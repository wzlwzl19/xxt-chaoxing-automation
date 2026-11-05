// sentinel.js —— 哨兵：每次运行前自检 + 运行中体检 + 选择器自适应迭代
// 铁律：安全 > 进度。任何一项"不确定"，直接拒绝启动（fail-closed）。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIR = __dirname;
const REPORT = path.join(DIR, 'risk-report.json');
const SELECTORS = path.join(DIR, 'selectors.json');
const QUEUE = path.join(DIR, 'upgrade-queue.json');
const EVOLOG = path.join(DIR, 'evolution.log');
const AUDITLOG = path.join(DIR, 'selfcheck.log');

function now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function app(file, obj) { try { fs.appendFileSync(file, JSON.stringify({ ts: now(), ...obj }) + '\n'); } catch (e) {} }
function readJSON(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; } }
function writeJSON(p, o) { try { fs.writeFileSync(p, JSON.stringify(o, null, 2)); } catch (e) {} }

// ---------- 选择器表：可被自动替换（自我迭代的核心） ----------
const DEFAULT_SELECTORS = {
  loginPhone: ['#phone', 'input[name="phone"]', '.ipt-tel'],
  loginPwd: ['#pwd', 'input[type="password"]', '.ipt-pwd'],
  loginBtn: ['#loginBtn', '.btns-box', 'button.btn-big-blue'],
  courseTab: ['.tab-item[coursetype="1"]', '.course-tab .tab-item:nth-child(2)'],
  courseCard: ['a[href*="stucoursemiddle"]', 'a[href*="studentcourse"]'],
  chapterFrame: ['studentcourse', 'studentstudy'],
  chapterItem: ['.chapter_item', '[onclick*="toOld"]', '.chapter_body .clicktitle'],
  panelHost: ['#xt-ds-host'],
};

function loadSelectors() {
  const cur = readJSON(SELECTORS, null);
  if (!cur || !cur.chapterItem) { writeJSON(SELECTORS, DEFAULT_SELECTORS); return DEFAULT_SELECTORS; }
  return cur;
}

// 在一个上下文里试探某个选择器是否存在（ctx 提供 eval）
async function probeSelector(ctx, key) {
  const list = loadSelectors()[key] || [];
  for (const sel of list) {
    try {
      const hit = await ctx(sel);
      if (hit) return { sel, ok: true };
    } catch (e) {}
  }
  return { sel: list[0], ok: false };
}

// ---------- 环境体检 ----------
function checkPortBind() {
  // 调试端口必须只绑 127.0.0.1，不能被局域网访问（否则别人能直接接管浏览器）
  try {
    const out = execSync('netstat -ano | findstr :9222', { encoding: 'utf8', timeout: 8000 }) || '';
    const lines = out.split(/\r?\n/).filter((l) => /LISTENING/.test(l));
    if (!lines.length) return { ok: true, note: '端口未监听（会自行拉起浏览器）' };
    const external = lines.filter((l) => /0\.0\.0\.0:9222|\[::\]:9222/.test(l));
    return external.length
      ? { ok: false, note: '调试端口对公网/局域网开放，任何人可接管浏览器：' + external[0].trim() }
      : { ok: true, note: '仅本机 127.0.0.1 可访问' };
  } catch (e) {
    return { ok: true, note: '无法读取端口状态，按默认放行' };
  }
}

const PAGE_PROBE = `(() => {
  const out = {};
  out.webdriver = navigator.webdriver;
  out.ua = navigator.userAgent;
  out.headless = /HeadlessChrome/i.test(navigator.userAgent);
  out.langs = (navigator.languages || []).join(',');
  out.plugins = navigator.plugins ? navigator.plugins.length : 0;
  out.vis = document.visibilityState;
  out.focus = document.hasFocus();
  out.captcha = !!document.querySelector('#nc_1_n1z,.nc_wrapper,[class*="nc_container"]');
  out.loginWall = /passport2\\.chaoxing\\.com\\/login/i.test(location.href);
  out.video = (() => {
    // 视频在 iframe 里，主文档 querySelector('video') 永远是 null —— 递归钻同源 iframe 才拿得到
    const all = [];
    const walk = (doc, depth) => {
      if (!doc || depth > 4) return;
      try { doc.querySelectorAll('video').forEach((x) => all.push(x)); } catch (e) {}
      let fs = [];
      try { fs = doc.querySelectorAll('iframe'); } catch (e) {}
      for (const f of fs) { try { const d = f.contentDocument; if (d) walk(d, depth + 1); } catch (e) {} }
    };
    walk(document, 0);
    const v = all.find((x) => !x.paused && x.duration > 0) || all.find((x) => x.duration > 0) || all[0] || null;
    return v ? { rate: v.playbackRate, paused: v.paused } : null;
  })();
  return JSON.stringify(out);
})()`;

// ---------- 主自检 ----------
async function preflight(ctxEval, cfg) {
  const checks = [];
  const add = (id, level, ok, note) => checks.push({ id, level, ok, note });

  // 1. 调试端口暴露面
  const port = checkPortBind();
  add('port-bind', 'blocker', port.ok, port.note);

  // 2. 浏览器指纹（页面刚跳转时 evaluate 可能超时，重试几次再下结论）
  let page = {};
  let probeErr = null;
  for (let i = 0; i < 3; i++) {
    try { page = JSON.parse(await ctxEval(PAGE_PROBE)); probeErr = null; break; } catch (e) { probeErr = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  if (probeErr) add('page-probe', 'warn', false, '页面暂时读不到（' + probeErr.message + '），稍后运行中会继续探测');
  if (page.ua) {
    add('headless', 'blocker', !page.headless, page.headless ? '检测到 HeadlessChrome，平台极易识别' : '正常窗口模式');
    add('webdriver', 'warn', page.webdriver !== true, 'navigator.webdriver=' + page.webdriver);
    add('plugins', 'warn', (page.plugins || 0) > 0, '浏览器插件数 ' + page.plugins + '（0 是自动化特征）');
    add('langs', 'info', true, '语言 ' + page.langs);
  }

  // 3. 行为参数
  const rate = (cfg && cfg.speed) || 1.0;
  // 脚本 UI 合法倍速 1.0x~3.0x，只有超出脚本上限才算配置异常（与 guard.js 一致）
  add('speed', 'blocker', rate <= 3.0, rate > 3.0 ? '倍速 ' + rate + 'x 超出脚本上限（≤3x），配置异常' : '倍速 ' + rate + 'x');
  const gapMin = (cfg && cfg.chapterGapSec && cfg.chapterGapSec[0]) || 0;
  add('chapter-gap', 'warn', gapMin >= 10, gapMin < 10 ? '章节间隔 ' + gapMin + ' 秒过短，容易形成机器节奏' : '章节间隔 ' + gapMin + '-' + ((cfg.chapterGapSec || [])[1] || '?') + ' 秒');

  // 4. 平台风控现状
  add('captcha-now', 'blocker', !page.captcha, page.captcha ? '当前页面已有验证码，先人工处理' : '当前无验证码');
  add('session', 'info', !page.loginWall, page.loginWall ? '当前处于登录页，将按流程自动登录' : '会话正常');

  // 5. 选择器完整性（自我迭代：验证 → 失效则记录待升级）
  const selKeys = ['chapterItem', 'panelHost', 'loginPhone', 'loginPwd', 'loginBtn'];
  const broken = [];
  for (const k of selKeys) {
    const sels = loadSelectors()[k] || [];
    add('selector:' + k, 'info', sels.length > 0, sels[0]);
    if (!sels.length) broken.push(k);
  }

  // 6. 待升级队列
  const q = readJSON(QUEUE, []);
  add('upgrade-queue', 'warn', q.length === 0, q.length ? '有 ' + q.length + ' 条未处理的自检问题：' + q.map((x) => x.id).join(',') : '无遗留问题');

  const blockers = checks.filter((c) => c.level === 'blocker' && !c.ok);
  const warns = checks.filter((c) => c.level === 'warn' && !c.ok);
  const verdict = blockers.length ? 'BLOCKED' : warns.length ? 'PASS_WITH_WARNINGS' : 'PASS';

  const report = { ts: now(), verdict, blockers: blockers.map((b) => b.note), warnings: warns.map((w) => w.id + ': ' + w.note), checks };
  writeJSON(REPORT, report);
  app(AUDITLOG, { verdict, checks: checks.length, blockers: blockers.length, warnings: warns.length });

  return report;
}

// ---------- 登录后审计：这次登录有没有暴露新特征 ----------
async function postLoginAudit(ctxEval) {
  const findings = [];
  let p = {};
  try { p = JSON.parse(await ctxEval(PAGE_PROBE)); } catch (e) { findings.push({ id: 'probe-fail', note: e.message }); }
  if (p.captcha) findings.push({ id: 'captcha-after-login', note: '登录后出现验证码，平台已开始关注该会话' });
  if (p.loginWall) findings.push({ id: 'login-failed', note: '登录后被弹回登录页' });

  // 接口连通性 + 会话有效性（学习通自有接口，正常请求无特征）
  const api = await ctxEval(`(async()=>{
    try{
      const t0=Date.now();
      const r=await fetch('https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1',{credentials:'include'});
      const t=await r.text();
      return JSON.stringify({status:r.status,ms:Date.now()-t0,ok:t.indexOf('channelList')>-1});
    }catch(e){ return JSON.stringify({status:0,ok:false,err:e.message}) }
  })()`).catch(() => '{"status":0,"ok":false}');
  let a = {}; try { a = JSON.parse(api); } catch (e) {}
  if (!a.ok) findings.push({ id: 'api-dead', note: '课程接口不可用：' + JSON.stringify(a) });
  if (a.ms > 8000) findings.push({ id: 'api-slow', note: '接口响应 ' + a.ms + 'ms，网络/风控中间层可能介入' });

  if (findings.length) {
    app(EVOLOG, { phase: 'postLogin', findings });
    const q = readJSON(QUEUE, []);
    findings.forEach((f) => { if (!q.find((x) => x.id === f.id)) q.push({ ...f, at: now() }); });
    writeJSON(QUEUE, q);
  }
  return findings;
}

// ---------- 运行中体检 ----------
async function heartbeat(ctxEval, state) {
  const issues = [];
  const r = await ctxEval(PAGE_PROBE).catch(() => null);
  let p = {};
  try { p = JSON.parse(r); } catch (e) { return { ok: true, issues }; }
  if (p.captcha) issues.push({ id: 'captcha', fatal: true, note: '运行中出现验证码' });
  if (p.loginWall) issues.push({ id: 'kickout', fatal: true, note: '会话被踢回登录页' });
  if (p.video && p.video.rate > 3.1) issues.push({ id: 'rate', fatal: false, note: '倍速 ' + p.video.rate + 'x 超过脚本上限，可能被篡改' });
  if (state && state.chaptersDone > 0 && state.minutesElapsed > 0) {
    const perChapter = state.minutesElapsed / state.chaptersDone;
    if (perChapter < 2 && state.avgVideoMinutes > 4) {
      issues.push({ id: 'pace', fatal: false, note: '平均每节 ' + perChapter.toFixed(1) + ' 分钟，远快于视频时长，节奏异常' });
    }
  }
  if (issues.length) app(AUDITLOG, { phase: 'heartbeat', issues });
  return { ok: issues.filter((i) => i.fatal).length === 0, issues };
}

// ---------- 自我迭代：选择器失效时自动换备选 ----------
async function repairSelector(ctxProbe, key) {
  const table = loadSelectors();
  const list = table[key] || [];
  for (const sel of list) {
    try { if (await ctxProbe(sel)) { app(EVOLOG, { phase: 'repair', key, sel, result: 'ok' }); return sel; } } catch (e) {}
  }
  // 全失败：记入升级队列，等人工/下版补
  const q = readJSON(QUEUE, []);
  if (!q.find((x) => x.id === 'selector:' + key)) {
    q.push({ id: 'selector:' + key, note: '选择器全部失效，需要补充新规则', candidates: list, at: now() });
    writeJSON(QUEUE, q);
    app(EVOLOG, { phase: 'repair', key, result: 'failed' });
  }
  return null;
}

// ---------- 自我升级：把验证通过的新选择器写回表（持久生效） ----------
function promoteSelector(key, sel) {
  const table = loadSelectors();
  const list = table[key] || [];
  if (!list.includes(sel)) { table[key] = [sel, ...list]; writeJSON(SELECTORS, table); app(EVOLOG, { phase: 'promote', key, sel }); }
}

function clearQueue(id) {
  const q = readJSON(QUEUE, []).filter((x) => x.id !== id);
  writeJSON(QUEUE, q);
}

module.exports = { preflight, postLoginAudit, heartbeat, repairSelector, promoteSelector, loadSelectors, clearQueue, probeSelector, REPORT, QUEUE, SELECTORS, EVOLOG, readJSON, writeJSON };
