// —— 授权闸门（失败即退出，不可绕过）——
require('./license').guard();
const compliance = require('./compliance');
const pace = require('./pace');
// —— 授权闸门结束 ——
// autopilot.js —— 一键全自动：开浏览器 → 安全自检 → 登录 → 进课程 → 刷课 → 风控熔断
// 用法：node autopilot.js                  正常跑（开跑前先自检，不过自检就不跑）
//       node autopilot.js --selfcheck      只做安全自检并出报告
//       node autopilot.js --dry            登录 + 列课程，不开始刷
//       node autopilot.js --course 军事    只跑名字里含该关键词的课
//       node autopilot.js --max-chapters N 每门课最多推进 N 节
//       node autopilot.js --unlock         立即解除熔断锁并继续
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Browser, sleep, waitFor, httpJSON, framesEval } = require('./cdpkit');
const { Guard, PROBE, logLine } = require('./guard');
compliance.requireConsent('autopilot');
const vault = require('./vault');
const sentinel = require('./sentinel');
const maintain = require('./maintenance');
const faceguard = require('./faceguard');
const facecheck = require('./facecheck');
const apikey = require('./apikey');
const binding = require('./binding');

// 跨源 iframe 兜底探针：在任意一个 frame 里找第一个有 duration 的 video
const VIDEO_PROBE_SRC = "(function(){var vs=document.querySelectorAll('video');for(var i=0;i<vs.length;i++){var v=vs[i];if(v&&v.duration>0){return {paused:v.paused,t:v.currentTime,d:v.duration,rate:v.playbackRate,ended:!!v.ended};}}return null;})()";

// 强推播放：把所有 paused 的 video 打开（静音绕过自动播放限制），返回命中个数
const PLAY_SRC = "(function(){var n=0;var vs=document.querySelectorAll('video');for(var i=0;i<vs.length;i++){var v=vs[i];if(v&&v.paused&&!v.ended){try{v.muted=true;}catch(e){}try{var p=v.play();if(p&&p.catch)p.catch(function(){});n++;}catch(e){}}}return n;})()";

/**
 * 用 CDP 强行恢复播放：脚本在页面里点不动跨源 iframe 的播放器，但 CDP 有特权。
 * 先逐 frame 求值，再试 OOPIF target（独立 target）。
 */
/**
 * 严格模式：关闭"自动答题"（不代替使用者完成考核），保留"自动跳节"（仅播放导航）。
 * 依据《民法典》第 509 条诚信履行 + 学校学术规范：自动化只能做播放，不能做答题。
 */
/** 判断当前是不是"测验/答题"页面（严格模式下不代替使用者作答） */
/** 考试类页面探测（考试、期末、期中、补考、重修考试等）—— 风险最高，一律不碰 */
const EXAM_DETECT_SRC = "(function(){try{" +
  "var t=(document.body&&document.body.innerText||'');" +
  "var u=location.href;" +
  "var byUrl=/\\/exam|examtest|\/test\/|kaoshi/i.test(u);" +
  "var byText=/考试|期末|期中|补考|重修考试|试卷/.test(t)&&/提交试卷|开始考试|考试时长|剩余时间/.test(t);" +
  "return byUrl||byText;}catch(e){return false;}})()";

const QUIZ_DETECT_SRC = "(function(){try{" +
  "var t=(document.body&&document.body.innerText||'');" +
  "var hasTi=!!document.querySelector('.TiMu,.questionLi,.question-item,[class*=\"TiMu\"],[id*=\"question\"]');" +
  "var hasSubmit=Array.prototype.some.call(document.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit]'),function(e){var x=(e.innerText||e.value||'').trim();return /提交|交卷/.test(x);});" +
  "return hasTi||hasSubmit||/章节测验|测验题|考试/.test(t);}catch(e){return false;}})()";

/**
 * 合规核心：拦住"程序自动点提交"，只允许真人点击。
 * 原理：脚本用 element.click() 触发的点击 isTrusted === false，真人是 true。
 * 这样 AI 可以把答案填好，但提交这一步永远由本人完成。
 */
const SUBMIT_GUARD_SRC = "(function(){if(window.__xxtSubmitGuard)return;window.__xxtSubmitGuard=1;" +
  "document.addEventListener('click',function(e){" +
  "var el=e.target;var txt='';" +
  "try{var t=(el&&el.closest)?(el.closest('button,a,[role=button],input[type=button],input[type=submit]')||el):el;txt=(t&&(t.innerText||t.value)||'').trim();}catch(x){}" +
  "if(/提交|交卷/.test(txt)&&e.isTrusted===false){" +
  "e.preventDefault();e.stopImmediatePropagation();" +
  "try{var h=document.getElementById('xt-ds-host');var r=h&&h.shadowRoot;var lg=r&&r.querySelector('#log');" +
  "if(lg){lg.textContent+='\\n[合规] 已拦截自动提交 —— 答案已填好，请你核对后手动点「提交」';}}catch(x){}" +
  "}},true);})();";

async function installSubmitGuard(s) {
  try {
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: SUBMIT_GUARD_SRC });
  } catch (e) { }
  try { await s.eval(SUBMIT_GUARD_SRC, {}, 6000); } catch (e) { }
  return true;
}

async function enforceStrict(s) {
  if (compliance.isAuto()) {
    if (compliance.cfg().humanPace !== false) {
      const pr = await pace.install(s).catch(() => 'err');
      say('已启用真人节奏层（选项/提交随机延时）：' + pr, 'info');
    }
    return 'auto';
  }
  if (compliance.isAssist()) {
    await installSubmitGuard(s);
    return 'assist';
  }
  if (!compliance.isStrict()) return 'standard';
  try {
    const r = await s.eval(
      "(function(){var h=document.getElementById('xt-ds-host');var r=h&&h.shadowRoot;if(!r)return 'no-panel';" +
      "var q=r.getElementById('auto-quiz');var out=[];" +
      "if(q&&q.checked){q.click();out.push('auto-quiz:off');}" +
      "else out.push('auto-quiz:already-off');return out.join(',');})()",
      {}, 8000
    );
    return r;
  } catch (e) {
    return 'err:' + e.message;
  }
}

async function forcePlay(b, s) {
  let total = 0;
  try {
    const found = await framesEval(s, PLAY_SRC, 6000);
    for (const f of found) if (f && typeof f.value === 'number') total += f.value;
  } catch (e) { }
  if (total > 0) return total;
  try {
    const list = await httpJSON(PORT, '/json/list');
    for (const t of (list || [])) {
      if (!t || !t.webSocketDebuggerUrl || t.type === 'page') continue;
      if (!/iframe|worker/i.test(t.type)) continue;
      try {
        const ss = await b.attach(t.id);
        const n = await ss.eval(PLAY_SRC, {}, 6000);
        if (typeof n === 'number') total += n;
      } catch (e) { }
    }
  } catch (e) { }
  return total;
}

const DIR = __dirname;
const CFG_PATH = path.join(DIR, 'config.json');
const PANEL_SRC = path.join(DIR, 'xuexitong-console.js');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = process.env.XXT_PROFILE || (function () {
  const i = process.argv.indexOf('--profile');
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : path.join(DIR, 'cdp-profile');
})();
const PORT = Number(process.env.XXT_PORT || (function () {
  const i = process.argv.indexOf('--port');
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : 9222;
})());

// ---- 单实例锁：同一端口只允许一个 autopilot ----
// 背景：bridge 和 nanny 都可能来拉起 autopilot，两个进程会同时对同一个 profile
// 执行 spawn msedge，Chromium 只允许一个主进程 → 后起的那个把前一个顶掉，浏览器反复消失。
// 这里用 run-<port>.lock 兜底：发现同端口已有活着的进程，直接退出，绝不抢。
const RUN_LOCK = path.join(DIR, 'run-' + PORT + '.lock');
(function acquireRunLock() {
  try {
    const old = parseInt(fs.readFileSync(RUN_LOCK, 'utf8'), 10);
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0);
        console.log('[!] 端口 ' + PORT + ' 已有刷课进程在跑（pid ' + old + '），本进程退出，避免抢浏览器');
        process.exit(0);
      } catch (e) { /* 旧进程已死，接管 */ }
    }
  } catch (e) { /* 没有锁文件 */ }
  try { fs.writeFileSync(RUN_LOCK, String(process.pid), 'utf8'); } catch (e) {}
  const drop = () => { try { if (String(fs.readFileSync(RUN_LOCK, 'utf8')).trim() === String(process.pid)) fs.unlinkSync(RUN_LOCK); } catch (e) {} };
  process.on('exit', drop);
  process.on('SIGINT', drop);
  process.on('SIGTERM', drop);
})();

const DEFAULT_CFG = {
  speed: 1.0,
  chapterGapSec: [20, 60],
  maxRunMinutes: 120,
  restEveryMinutes: 45,
  restMinutes: 10,
  stallMinutes: 12,
  courses: [],
  guard: { stopAt: 100, pauseAt: 60, lockMinutes: 60 },
  maintenance: { everyMin: 15, logMaxMB: 2, logKeepKB: 200, tmpKeepDays: 3, closeIdleTabs: true, gc: true },
  nightQuiet: { enabled: false, start: '02:30', end: '06:00' },
};

function cfg() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { user = {}; }
  const out = Object.assign({}, DEFAULT_CFG, user);
  out.guard = Object.assign({}, DEFAULT_CFG.guard, user.guard || {});
  out.maintenance = Object.assign({}, DEFAULT_CFG.maintenance, user.maintenance || {});
  out.nightQuiet = Object.assign({}, DEFAULT_CFG.nightQuiet, user.nightQuiet || {});
  return out;
}

const CFG = cfg();
const G = new Guard({
  stopAt: CFG.guard.stopAt,
  pauseAt: CFG.guard.pauseAt,
  lockMinutes: CFG.guard.lockMinutes,
});

function say(msg, kind) {
  const tag = { info: '-', ok: 'OK', warn: '!', err: 'X', stop: '##' }[kind || 'info'];
  console.log('[' + tag + '] ' + msg);
  logLine({ level: kind || 'info', msg });
}
function rnd(a, b) { return a + Math.random() * (b - a); }

// ---------- 浏览器 ----------
let __browserSpawnTried = false;
async function ensureBrowser() {
  // 先给已在启动中的实例一点时间（避免"我又开一个"导致多出一个空白窗口）
  for (let i = 0; i < 12; i++) {
    try {
      const v = await httpJSON(PORT, '/json/version');
      if (v.webSocketDebuggerUrl) return { started: false, ver: v.Browser };
    } catch (e) {}
    await sleep(1000);
  }
  if (__browserSpawnTried) {
    // 本轮已经尝试过拉起，不再重复开窗（重复开窗会顶出多余窗口/抢同一个 profile）
    await waitFor(async () => {
      try { const v = await httpJSON(PORT, '/json/version'); return v.webSocketDebuggerUrl; } catch (e) { return false; }
    }, { timeout: 20000, label: '浏览器调试端口（复用已拉起实例）' });
    return { started: false, reused: true };
  }
  __browserSpawnTried = true;
  if (!fs.existsSync(EDGE)) throw new Error('找不到 Edge: ' + EDGE);
  say('启动浏览器（独立配置目录，登录态会一直保留）…');
  spawn(EDGE, [
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900',
    // —— 防节流/防遮挡四件套：让页面即使被别的窗口挡住也保持 visible、不冻结 ——
    // CalculateNativeWinOcclusion 是 Windows 的窗口遮挡检测，它会把被挡住的窗口判成 hidden，
    // 学习通播放器一 hidden 就自动暂停（这是"切走就停"的真正开关）。
    '--disable-features=CalculateNativeWinOcclusion,AutofillServerCommunication,PasswordManagerOnboarding',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-ipc-flooding-protection',
    // 长时间跑视频容易吃满内存导致渲染进程卡死，放宽内存压力判定
    '--memory-pressure-off',
    '--enable-unsafe-extension-debugging',
    'about:blank',
  ], { detached: true, stdio: 'ignore' }).unref();
  await waitFor(async () => {
    try { const v = await httpJSON(PORT, '/json/version'); return v.webSocketDebuggerUrl; } catch (e) { return false; }
  }, { timeout: 40000, label: '浏览器调试端口' });
  return { started: true };
}

// ---------- 登录态 ----------
// 返回详细信息（登录态 + 服务端 uid），调用方要靠 uid 判断"是不是同一个账号"
async function whoamiInfo(s) {
  // 必须在 chaoxing 同源页面上发请求，否则 fetch 会被 CORS 拦掉（about:blank 上必然失败）
  const u = await s.eval('location.href').catch(() => '');
  if (!/chaoxing\.com/.test(u)) {
    await s.send('Page.navigate', { url: 'https://mooc1-1.chaoxing.com/visit/interaction' }).catch(() => {});
    await sleep(4500);
  }
  const r = await s.eval(`(async()=>{
    try{
      const r=await fetch('https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1',{credentials:'include'});
      const t=await r.text();
      let n=0; try{ n=(JSON.parse(t).channelList||[]).length }catch(e){}
      const m=document.cookie.match(/_uid=([^;]+)/);
      // 登录判据：接口 200 且 channelList 非空。未登录/失效会话时这个接口也是 200 但 channelList 为空，
      // 所以只判「含 channelList 字段」会把未登录误判成已登录，必须判 n>0。
      return JSON.stringify({st:r.status,uid:m?m[1]:'',n:n,ok:(r.status===200 && n>0)});
    }catch(e){ return JSON.stringify({ok:false,uid:'',err:e.message}) }
  })()`, {}, 20000).catch((e) => JSON.stringify({ ok: false, err: e.message }));
  try { return JSON.parse(r); } catch (e) { return { ok: false, uid: '' }; }
}

async function whoami(s) {
  const i = await whoamiInfo(s);
  return !!i.ok;
}

// 登出：清掉浏览器里上一个人的会话（含 cookie 兜底）
async function logout(s) {
  say('先登出浏览器里当前的账号…', 'warn');
  await s.send('Page.navigate', { url: 'https://passport2.chaoxing.com/logout' }).catch(() => { });
  await sleep(1500);
  try {
    const res = await s.send('Network.getAllCookies', {});
    const list = (res && res.cookies) || [];
    for (const c of list) {
      if (/chaoxing\.com/.test(c.domain)) {
        await s.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }).catch(() => { });
      }
    }
    say('已清除 ' + list.filter((c) => /chaoxing\.com/.test(c.domain)).length + ' 个 chaoxing cookie', 'warn');
  } catch (e) {
    say('cookie 兜底清理失败（不影响登出）：' + e.message, 'warn');
  }
  await s.send('Page.navigate', { url: LOGIN_URL }).catch(() => { });
  await waitLoginForm(s);
}

// 等登录页的输入框出现（轮询，通常 1~2 秒；比固定 sleep 快很多）
async function waitLoginForm(s, maxMs) {
  const limit = maxMs || 12000;
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    const ready = await s.eval(`!!(document.querySelector('#phone') && document.querySelector('#pwd'))`).catch(() => false);
    if (ready) { await sleep(300); return true; }
    await sleep(200);
  }
  return false;
}

// 往输入框里填内容，并且**回读校验**：
// - Input.insertText 不走键盘/输入法，实测不会被 IME 干扰（中文输入法开着也照样正确）
// - 真正会出错的情况是：输入框 maxlength 截断、页面有遮罩导致 focus 没生效、被密码管理器覆盖
//   所以填完必须把 value 读回来跟预期逐字比对，不一致就重试，三次还不行直接停，绝不带着错密码去点登录
async function typeInto(s, selector, text) {
  const want = String(text == null ? '' : text);
  const len = String(selector).toLowerCase().indexOf('pwd') > -1 ? '' : ''; // 占位，保持签名稳定
  for (let attempt = 1; attempt <= 3; attempt++) {
    await s.eval(`(()=>{const p=document.querySelector(${JSON.stringify(selector)});if(p){p.focus();p.value='';p.dispatchEvent(new Event('input',{bubbles:true}));}})()`).catch(() => {});
    await sleep(120);
    for (const ch of want) {
      await s.send('Input.insertText', { text: ch }).catch(() => {});
      await sleep(rnd(40, 120));
    }
    await sleep(220);
    const got = await s.eval(`(document.querySelector(${JSON.stringify(selector)})||{}).value||''`).catch(() => '');
    if (got === want) return true;
    const ml = await s.eval(`(()=>{const p=document.querySelector(${JSON.stringify(selector)});return p?Number(p.maxLength):-1})()`).catch(() => -1);
    const a = [...want], b2 = [...got];
    let at = -1;
    for (let i = 0; i < Math.max(a.length, b2.length); i++) { if (a[i] !== b2[i]) { at = i; break; } }
    say('填写 ' + selector + ' 校验不一致（第 ' + attempt + '/3 次）：期望 ' + want.length + ' 位，实际 ' + got.length + ' 位，首个差异在第 ' + (at + 1) + ' 位，输入框 maxlength=' + ml, 'warn');
    if (ml > 0 && want.length > ml) {
      throw new Error('要填的密码有 ' + want.length + ' 位，但输入框 maxlength 只有 ' + ml + ' 位，会被截断 —— 请确认密码长度');
    }
  }
  throw new Error('连续 3 次都没能把 ' + selector + ' 填对，已停下（可能是页面有遮罩、输入框被替换，或密码里有输入框不接受的字符）');
}

const LOGIN_URL = 'https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fmooc1.chaoxing.com%2Fvisit%2Finteraction';
// 这次要登哪个账号（面板/命令行显式指定）。用来识别"浏览器里还是上一个人的会话"
const TARGET_USER = (() => {
  const i = process.argv.indexOf('--user');
  return i > -1 ? String(process.argv[i + 1] || '').trim() : '';
})();
// 手动登录最多等多久（分钟）。默认 10 分钟，可以用 --wait-login-min 600 拉长到 10 小时
const MANUAL_WAIT_MIN = (() => {
  const i = process.argv.indexOf('--wait-login-min');
  const v = i > -1 ? parseInt(process.argv[i + 1], 10) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 10;
})();
// 强制重登：即使浏览器里已经有登录会话，也先登出、跳登录页，等用户手动输入（配合「点开始就手动登录」）
const FORCE_RELOGIN = process.argv.includes('--force-relogin');

// 这个窗口绑定的用户号码（面板传入）。只用于防串号校验，不参与登录。
const PHONE = (() => {
  const i = process.argv.indexOf('--phone');
  return i > -1 ? String(process.argv[i + 1] || '').trim() : '';
})();

// 登录：有存档密码就自动填；没有（或加了 --manual-login）就把表单清空，等你手填任意账号
async function login(s) {
  const creds = vault.load();
  const manual = !creds || process.argv.includes('--manual-login');
  say('打开登录页…');
  await s.send('Page.navigate', { url: LOGIN_URL });
  await waitLoginForm(s);

  // 登录页结构自检：字段还在不在（失效就立刻停，不去瞎点）
  const form = await s.eval(`JSON.stringify({u:!!document.querySelector('#phone'),p:!!document.querySelector('#pwd'),b:!!document.querySelector('#loginBtn')})`).catch(() => '{}');
  let f = {}; try { f = JSON.parse(form); } catch (e) {}
  if (!f.u || !f.p || !f.b) {
    const fixed = await sentinel.repairSelector(async (sel) => s.eval(`!!document.querySelector(${JSON.stringify(sel)})`), 'loginPhone');
    if (!fixed) throw new Error('登录页结构变了（找不到账号/密码/登录按钮），已记入 upgrade-queue.json');
  }

  if (manual) {
    // 清掉浏览器密码管理器自动填的别人的号，把光标放到账号框，剩下你来
    await s.eval(`(()=>{
      for (const id of ['#phone','#pwd']) {
        const el=document.querySelector(id);
        if(el){el.focus();el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
      }
      const ph=document.querySelector('#phone'); if(ph) ph.focus();
    })()`).catch(() => {});
    // 取消「下次自动登录」：不勾它，浏览器才不会记住登录态、下次自动登录到别人的账号
    const ticked = await s.eval(`(()=>{
      // 学习通新版登录页：<div class="auto-lg-next"><span class="check-input"></span>下次自动登录</div>
      let box = document.querySelector('.auto-lg-next');
      if (box) {
        const mark = box.querySelector('.check-input');
        const target = mark || box;          // 真正能切换的是内层 .check-input，点外层没用
        const before = (mark && mark.className) || box.className;
        if (/checked/.test(before)) target.click();
        const after = (mark && mark.className) || box.className;
        return before + ' -> ' + after;
      }
      // 兜底：标准 checkbox
      const boxes=[...document.querySelectorAll('input[type=checkbox]')];
      if (boxes.length) { if(boxes[0].checked) boxes[0].click(); return 'checkbox|' + boxes[0].checked; }
      return '没找到';
    })()`).catch(() => 'err');
    say('「下次自动登录」已取消：' + ticked);
    say('登录框已清空 —— 请在浏览器窗口里填账号密码并点「登录」（最多等 ' + MANUAL_WAIT_MIN + ' 分钟）', 'warn');
  } else {
    await typeInto(s, '#phone', creds.user);
    await typeInto(s, '#pwd', creds.pass);
    await sleep(rnd(300, 900));
    await s.eval(`(()=>{const b=document.querySelector('#loginBtn')||document.querySelector('.btns-box');if(b)b.click();})()`);
    say('已用存档账号自动提交，等结果…');
  }

  const deadline = Date.now() + (manual ? MANUAL_WAIT_MIN * 60 * 1000 : 45 * 1000);
  while (Date.now() < deadline) {
    await sleep(1500);
    const st = await s.eval(`JSON.stringify({
      url: location.href,
      captcha: !!document.querySelector('#nc_1_n1z,.nc_wrapper,[class*="nc_container"]'),
      err: ((document.querySelector('.err-tip,.login-error,.tip-error')||{}).innerText||'').trim()
    })`).catch(() => '{}');
    let o = {}; try { o = JSON.parse(st); } catch (e) {}
    // 手填模式下出现滑块是你自己在操作，不算风控异常；自动填模式才熔断
    if (o.captcha && !manual) {
      Guard.trip(CFG.guard.lockMinutes, '登录时出现滑块验证', o.url);
      throw new Error('登录触发滑块验证 —— 已按风控策略立即停止');
    }
    if (o.err) { say('登录页提示：' + o.err, 'err'); if (!manual) throw new Error('登录失败：' + o.err); }
    if (o.url && !/passport2\.chaoxing\.com\/login/.test(o.url)) {
      await sleep(2500);
      if (await whoami(s)) { say('登录成功', 'ok'); return true; }
    }
  }
  throw new Error(manual ? '等你手动登录超时了（' + MANUAL_WAIT_MIN + ' 分钟）' : '登录超时（45 秒没看到跳转）');
}

// ---------- 课程与章节（iframe 内真实点击，不伪造 URL） ----------
// 从「我学的课」页面抓真实课程卡片：页面渲染的才是当前账号的课，API 在多账号下可能串味
async function coursesFromPage(s) {
  const cur = await s.eval('location.href').catch(() => '');
  if (!/\/visit\/interaction/.test(cur)) {
    await s.send('Page.navigate', { url: 'https://mooc1.chaoxing.com/visit/interaction' });
    await sleep(6000);
  }
  await s.eval(`(() => { const t=[...document.querySelectorAll('.tab-item')].find(e=>/我学的课/.test(e.innerText||'')); if(t) t.click(); return true; })()`, {}, 10000).catch(() => {});
  await sleep(5000);
  const raw = await s.eval(`(() => {
    const as=[...document.querySelectorAll('a')].filter(a=>/stucoursemiddle/.test(a.href||''));
    const map={};
    for (const a of as) {
      const m=(a.href||'').match(/courseid=(\\d+)[^#]*?clazzid=(\\d+)[^#]*?cpi=(\\d+)/);
      if(!m) continue;
      const key=m[1]+'_'+m[2];
      const t=(a.innerText||'').replace(/\\s+/g,' ').trim();
      if(!map[key]) map[key]={ courseId:m[1], clazzid:m[2], cpi:m[3], name:'', href:a.href };
      if(t && !map[key].name) map[key].name=t;
    }
    return JSON.stringify(Object.values(map));
  })()`, {}, 20000).catch(() => '[]');
  let arr = [];
  try { arr = JSON.parse(raw) || []; } catch (_) { arr = []; }
  return arr.filter((c) => c.name).map((c) => ({ name: c.name, courseId: c.courseId, clazzid: c.clazzid, cpi: c.cpi, href: c.href }));
}

async function listCourses(s) {
  // 1) 优先页面真实卡片：多账号环境里 API 的 channelList 可能属于另一个会话（实测会串味）
  let page = [];
  try { page = await coursesFromPage(s); } catch (_) { page = []; }
  if (page.length) return page;
  // 2) 兜底：backclazzdata 接口
  let j = null;
  for (let i = 0; i < 4; i++) {
    const raw = await s.eval(`(async()=>{
      const r=await fetch('https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1',{credentials:'include'});
      return await r.text();
    })()`, {}, 25000);
    try { j = JSON.parse(raw); } catch (_) { j = null; }
    if (j && (j.channelList || []).length) break;
    if (i < 3) await sleep(2500);
  }
  const out = [];
  for (const ch of ((j && j.channelList) || [])) {
    const c = ch.content || {};
    const arr = (c.course && c.course.data) || [];
    if (!arr[0]) continue;
    out.push({ name: arr[0].name, clazzid: ch.key, cpi: ch.cpi, courseId: arr[0].id, courseName: c.name });
  }
  return out;
}

async function frameWith(s, needle) {
  const tree = await s.send('Page.getFrameTree');
  const out = [];
  (function walk(n) { out.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(walk); })(tree.frameTree);
  return out.find((f) => f.url.indexOf(needle) > -1) || null;
}

async function iframeEval(s, needle, expr) {
  const f = await frameWith(s, needle);
  if (!f) return null;
  const cx = await s.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'xxt' });
  const r = await s.send('Runtime.evaluate', {
    expression: expr, contextId: cx.executionContextId, returnByValue: true, awaitPromise: true,
  }, 30000).catch(() => null);
  return r && r.result ? r.result.value : null;
}

// 打开某门课的目录页（interaction → 我学的课 → 课程卡 → stu 页）
async function openCourse(s, c) {
  await s.send('Page.navigate', { url: 'https://mooc1-1.chaoxing.com/visit/interaction' });
  await sleep(4200);
  await s.eval(`(()=>{const t=[...document.querySelectorAll('.tab-item')].find(e=>/我学的课/.test(e.innerText));if(t)t.click();})()`).catch(() => {});
  await sleep(4500);
  let href = c.href || await s.eval(`(()=>{
    const a=[...document.querySelectorAll('a')].find(x=>/stucoursemiddle/.test(x.href)&&x.href.indexOf(${JSON.stringify(String(c.courseId))})>-1);
    return a?a.href:'';
  })()`).catch(() => '');
  if (!href) {
    // 兜底：直接按 courseid/clazzid/cpi 拼学生入口（页面会 302 到 stu）
    href = 'https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=' + c.courseId + '&clazzid=' + c.clazzid + '&vc=1&cpi=' + c.cpi + '&ismooc2=1&v=2';
    say('课程卡没渲染出来，改用学生入口直连', 'warn');
  }
  await s.send('Page.navigate', { url: href });
  // 轮询等目录 iframe 出现（固定 sleep 在慢网络上会读空 → 误判"全部任务结束"）
  for (let i = 0; i < 25; i++) {
    const f = await frameWith(s, 'studentcourse').catch(() => null);
    if (f) { await sleep(2500); return f; }
    await sleep(1000);
  }
  return null;
}

// 任务点筛选：只有带 toOld(...) 的才是可播放节点；"1 国防概述" 这种是章标题，点了没反应
const POINT_FILTER = `(e)=>{const on=e.getAttribute('onclick')||'';return on.indexOf('toOld')>-1;}`;

async function listChapters(s) {
  // 目录 iframe 刚出现时内容可能还在渲染，读到空就等一下重试（否则会误判"全部任务结束"）
  for (let attempt = 0; attempt < 4; attempt++) {
    const raw = await iframeEval(s, 'studentcourse', `(()=>{
    const items=[...document.querySelectorAll('.chapter_item')].filter(${POINT_FILTER});
    return JSON.stringify(items.map((e,i)=>{
      const on=e.getAttribute('onclick')||'';
      const m=on.match(/toOld\\('(\\d+)'\\s*,\\s*'(\\d+)'/);
      // 完成判据：目录行里的 ".catalog_state"（图标 class 或悬停文案）
      // icon_yiwanc / 文案含「已完成」→ 已完成；否则（icon_weiwanc/无图标）视为未完成
      const st=e.querySelector('.catalog_state');
      const cls=st?String(st.className||''):'';
      const tip=st?(st.textContent||'').replace(/\\s+/g,''):'';
      const done=/yiwanc|已完成/.test(cls+tip);
      return {
        i:i,
        t:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,70),
        chapterId:m?m[2]:'',
        pending: done?0:1,
        done: done
      };
    }));
  })()`);
    let arr = [];
    try { arr = JSON.parse(raw || '[]'); } catch (e) { arr = []; }
    if (arr.length) return arr;
    if (attempt < 3) await sleep(3000);
  }
  return [];
}

async function clickChapter(s, idx) {
  const r = await iframeEval(s, 'studentcourse', `(()=>{
    const items=[...document.querySelectorAll('.chapter_item')].filter(${POINT_FILTER});
    if(!items[${idx}]) return 'missing';
    items[${idx}].click();
    return 'clicked:'+(items[${idx}].innerText||'').replace(/\\s+/g,' ').trim().slice(0,60);
  })()`);
  return r;
}

async function waitStudentstudy(s, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const u = await s.eval('location.href').catch(() => '');
    if (/studentstudy/.test(u)) return u;
    await sleep(1500);
  }
  return null;
}

// ---------- 面板 ----------
function panelSource() {
  const src = fs.readFileSync(PANEL_SRC, 'utf8');
  return 'if(window.top===window.self){(function(){var s=function(){try{' + src +
    "\n}catch(e){console.error('[xxt-fatal]',e&&e.stack||e)}};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',s,{once:true});else setTimeout(s,50);})();}";
}

async function clickPanel(s, text) {
  return s.eval(`(()=>{
    const h=document.getElementById('xt-ds-host'); if(!h||!h.shadowRoot) return 'no-panel';
    const b=[...h.shadowRoot.querySelectorAll('button')].find(x=>(x.innerText||'').trim()===${JSON.stringify(text)});
    if(!b) return 'no-btn'; b.click(); return 'clicked';
  })()`).catch(() => 'err');
}

async function setRate(s, rate) {
  if (!rate || rate <= 0) return 'skip';
  return s.eval(`(()=>{
    const h=document.getElementById('xt-ds-host'); if(!h||!h.shadowRoot) return 'no-panel';
    const sel=h.shadowRoot.getElementById('rate'); if(!sel) return 'no-select';
    const want=[...sel.options].find(o=>Math.abs((parseFloat(o.value)||0)-${Number(rate)})<0.01);
    if(!want) return 'no-option';
    if(sel.value!==want.value){ sel.value=want.value; sel.dispatchEvent(new Event('change',{bubbles:true})); return 'set-'+want.value; }
    return 'already-'+want.value;
  })()`).catch(() => 'err');
}

// ---------- 熔断 ----------
async function stopAll(s, reason, detail) {
  try { await clickPanel(s, '停止'); } catch (e) {}
  // 视频在 iframe 里，主文档 querySelector('video') 拿不到 —— 递归钻同源 iframe 暂停所有视频
  await s.eval(`(()=>{
    const walk=(doc,d)=>{ if(!doc||d>5)return;
      try{doc.querySelectorAll('video').forEach(v=>{try{v.pause()}catch(e){}})}catch(e){}
      let fs=[]; try{fs=doc.querySelectorAll('iframe')}catch(e){}
      for(const f of fs){ try{const x=f.contentDocument; if(x)walk(x,d+1)}catch(e){} }
    };
    walk(document,0);
  })()`).catch(() => {});
  try { await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s._injectId }); } catch (e) {}
  try { await s.send('Page.navigate', { url: 'about:blank' }); } catch (e) {}
  const rec = Guard.trip(CFG.guard.lockMinutes, reason, detail);
  say('已熔断：' + reason + '，所有任务停止，解锁时间 ' + new Date(rec.until).toLocaleString(), 'stop');
  try {
    spawn('powershell', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(' +
      JSON.stringify('自动刷课已停止：' + reason + '\n\n为保护账号已终止本次运行，请检查学习通页面。') +
      ",'学习通自动刷课 - 已熔断','OK','Warning')"],
      { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {}
}

// —— 顺手关掉启动时留下的 about:blank 空标签，避免窗口里多一个没用的页 ——
async function closeBlankTabs(b) {
  try {
    const pages = await b.pages();
    for (const p of pages) {
      if (p.type && p.type !== 'page') continue;
      if ((p.url || '') === 'about:blank') {
        const rest = pages.filter((x) => x.id !== p.id);
        if (!rest.length) continue; // 绝不留 0 个标签，否则后面开新页会失败
        try { await b.raw('Target.closeTarget', { targetId: p.id }); } catch (e) {}
      }
    }
  } catch (e) {}
}
function printAudit(rep) {
  console.log('');
  console.log('========== 安全自检 ==========');
  console.log('结论：' + rep.verdict);
  for (const c of rep.checks) {
    console.log('  [' + (c.ok ? '√' : c.level === 'blocker' ? '×' : '!') + '] ' + c.id + ' —— ' + c.note);
  }
  if (rep.blockers.length) console.log('阻断项：' + rep.blockers.join(' / '));
  console.log('报告已存：' + sentinel.REPORT);
  console.log('==============================');
  console.log('');
}

// ---------- 主流程 ----------
(async () => {
  // 记下 pid，清理进程靠它判断我还在不在
  const PID_FILE = path.join(DIR, 'autopilot.pid');
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (_) { }
  const dropPid = () => { try { fs.unlinkSync(PID_FILE); } catch (_) { } };
  process.on('exit', dropPid);
  process.on('SIGINT', () => { dropPid(); process.exit(0); });

  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const onlyCheck = argv.includes('--selfcheck');
  const ci = argv.indexOf('--course');
  // Windows 命令行传中文会乱码（bridge spawn 时尤其明显），所以优先读 start-opts.json
  let fileOpts = {};
  try {
    fileOpts = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'start-opts.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) { fileOpts = {}; }
  const onlyCourse = fileOpts.course || (ci > -1 ? argv[ci + 1] : null);
  const mi = argv.indexOf('--max-chapters');
  const maxChapters = mi > -1 ? parseInt(argv[mi + 1], 10) || 0 : 0;

  const lock = Guard.isLocked();
  if (lock) {
    say('检测到熔断锁：' + lock.reason + '（解锁时间 ' + new Date(lock.until).toLocaleString() + '）', 'stop');
    if (argv.includes('--unlock')) { Guard.release(); say('已手动解除熔断锁', 'warn'); }
    else { say('如确认继续：node autopilot.js --unlock', 'warn'); process.exit(0); }
  }

  await ensureBrowser();
  const b = await new Browser(PORT).connect();
  await closeBlankTabs(b);
  // 把浏览器侧边栏插件（学习通刷课助手）装进这个窗口；失败不影响刷课
  try {
    const r = await b.raw('Extensions.loadUnpacked', { path: path.join(DIR, 'extension-xxt') });
    if (r && r.id) say('浏览器侧边栏插件已就绪：' + r.id, 'info');
  } catch (e) {
    say('侧边栏插件没装上（不影响刷课）：' + e.message, 'warn');
  }
  try { setTimeout(() => { closeBlankTabs(b).catch(() => {}); }, 8000).unref(); } catch (e) {}
  let s = await b.attachPage((p) => /chaoxing/.test(p.url || ''));
  if (!s) s = await b.attachPage(() => true); // 尽量复用现有标签，少开新页（开新页偶发失败）
  if (!s) s = await b.newPage('about:blank');

  // 手动登录 + 强制重登：马上要登出跳登录页，前面的探测和自检都是白等，直接跳过（从点击到出登录页只要 2~3 秒）
  if (!FORCE_RELOGIN) {
    await s.send('Page.navigate', { url: 'https://mooc1-1.chaoxing.com/visit/interaction' }).catch(() => {});
    await sleep(4500);

    // 第一道闸：环境自检。不过就不许跑。
    const rep = await sentinel.preflight((expr) => s.eval(expr, {}, 15000), CFG);
    printAudit(rep);
    if (rep.verdict === 'BLOCKED') {
      say('安全自检未通过，已拒绝启动（这是保护账号，不是故障）', 'stop');
      b.close();
      process.exit(2);
    }
  }

  s._injectId = (await s.send('Page.addScriptToEvaluateOnNewDocument', { source: panelSource() })).identifier;

  // —— 账号处理：输入谁的号就登谁、刷谁，不做「是不是本人」的课程特征校验 ——
  // vault 里存的永远是面板/命令行最后一次输入的账号密码（bridge /start 每次都会先 save）。
  // 有密码 → 强制登出旧会话，用这个账号密码自动登录（切换账号绝不残留上一个号的会话）；
  // 无密码（--manual-login）→ 沿用浏览器里用户手动登录的会话。
  const savedCreds = vault.load();
  const targetUser = TARGET_USER || (savedCreds && savedCreds.user) || '';
  const autoMode = !!(savedCreds && savedCreds.pass && !argv.includes('--manual-login'));

  let info = FORCE_RELOGIN ? { ok: false, uid: '' } : await whoamiInfo(s);

  if (autoMode) {
    if (info.ok) {
      say('检测到已有会话（uid=' + (info.uid || '未知') + '），为确保刷的是「' + targetUser + '」，先登出', 'ok');
      await logout(s);
    }
    say('走自动登录：' + targetUser);
    await login(s);
    info = await whoamiInfo(s);
    if (!info.ok) throw new Error('登录后仍取不到课程数据（账号或密码可能不对）');
    vault.setMeta({ user: targetUser, uid: info.uid });
    say('登录完成：uid=' + (info.uid || '未知'), 'ok');
  } else {
    if (FORCE_RELOGIN && info.ok) {
      say('已登录（uid=' + (info.uid || '未知') + '），按要求先登出、跳登录页让你手动输入', 'warn');
      await logout(s);
      info = { ok: false, uid: '' };
    }
    if (!info.ok) {
      say('未检测到登录，请在浏览器窗口里手动登录', 'warn');
      await login(s);
      info = await whoamiInfo(s);
      if (!info.ok) throw new Error('手动登录超时或失败');
    } else {
      say('已登录（uid=' + (info.uid || '未知') + '），沿用当前会话', 'ok');
    }
  }

  // —— 防串号第二道：登录成功后核对"这个窗口里现在到底是谁" ——
  // 首次登录把 uid 记进 binding.json，之后每次必须一致；不一致就立刻停，
  // 绝不用上一个人的会话继续刷（这是多账号最容易出事的地方）。
  const bindRes = binding.checkAfterLogin(PROFILE, info.uid, targetUser || PHONE);
  if (!bindRes.ok) {
    say(bindRes.reason, 'err');
    Guard.trip(60, '账号绑定冲突', bindRes.reason);
    await stopAll(s, '账号绑定冲突', bindRes.reason);
    throw new Error(bindRes.reason);
  }
  if (PHONE && bindRes.bound && bindRes.bound.user && String(bindRes.bound.user) !== String(PHONE)) {
    const msg = '窗口绑定号码 ' + bindRes.bound.user + '，但参数要求 ' + PHONE + '，为防串号已停止';
    say(msg, 'err');
    Guard.trip(60, '账号绑定冲突', msg);
    await stopAll(s, '账号绑定冲突', msg);
    throw new Error(msg);
  }
  say('窗口绑定：' + binding.describe(PROFILE), 'ok');

  // 第二道闸：登录后审计，看这次登录有没有刺激到风控
  const post = await sentinel.postLoginAudit((expr) => s.eval(expr, {}, 15000));
  if (post.length) {
    console.log('登录后审计发现 ' + post.length + ' 项：');
    post.forEach((x) => console.log('  ! ' + x.id + ' —— ' + x.note));
    if (post.some((x) => x.id === 'captcha-after-login' || x.id === 'login-failed')) {
      say('登录后出现风控迹象，已停止', 'stop');
      await stopAll(s, '登录后风控', JSON.stringify(post));
      b.close(); process.exit(0);
    }
  } else {
    say('登录后审计通过，无异常特征', 'ok');
  }

  const courses = await listCourses(s);
  if (!courses.length) throw new Error('登录上了但课程表是空的（账号没选课？接口还没返回？），先停下不乱跑');
  const uid = await s.eval(`(()=>{const m=document.cookie.match(/_uid=([^;]+)/);return m?m[1]:''})()`).catch(() => '');
  say('当前登录账号：uid=' + (uid || '未知') + '，名下 ' + courses.length + ' 门课', 'ok');
  courses.forEach((c, i) => console.log('   ' + (i + 1) + '. ' + c.name + '  [courseId=' + c.courseId + ']'));

  if (onlyCheck || dry) {
    say(onlyCheck ? '--selfcheck 模式，自检完成' : '--dry 模式，到此为止', 'ok');
    b.close(); return;
  }

  const runT0 = Date.now();
  const state = { chaptersDone: 0, minutesElapsed: 0, avgVideoMinutes: 10 };

  // 课程名匹配：① 直接包含 ② 去掉括号/空格后按 2-gram 重叠度模糊匹配（防「国家安全教育」写成「国际安全教育」这类错字）
  //            ③ 都匹配不到就刷全部课程并明确告警，绝不允许「静默跳过全部课程 → 秒退」那种假死
  let picked = courses;
  if (onlyCourse) {
    const kw = String(onlyCourse).trim();
    const norm = (s) => String(s || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '');
    const bigrams = (s) => { const r = new Set(); for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2)); return r; };
    let hit = courses.filter((c) => c.name.indexOf(kw) > -1);
    if (!hit.length) {
      const kb = bigrams(norm(kw));
      let best = null, bestScore = 0;
      for (const c of courses) {
        const cb = bigrams(norm(c.name));
        let inter = 0; kb.forEach((x) => { if (cb.has(x)) inter++; });
        const score = kb.size ? inter / kb.size : 0;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (best && bestScore >= 0.6) {
        hit = [best];
        say('课程名「' + kw + '」没完全对上，按相似度匹配到「' + best.name + '」', 'warn');
      }
    }
    if (hit.length) picked = hit;
    else say('没找到名字匹配「' + kw + '」的课程，改为把全部课程都刷（请检查面板里填的课名）', 'warn');
  }

  for (const c of picked) {
    say('===== 课程：' + c.name + ' =====');

    const frame = await openCourse(s, c);
    if (!frame) { say('进不去课程目录，跳过', 'warn'); continue; }

    const chapters = await listChapters(s);
    say('目录共 ' + chapters.length + ' 节');
    if (!chapters.length) { say('目录里没解析到章节，跳过该课程', 'warn'); continue; }

    let done = 0;
    const tries = new Map();
    const keyOf = (x) => String(x.chapterId || ('i' + x.i));
    while (done < (maxChapters || chapters.length)) {
      // 每次回目录刷新进度，取第一个"没做过"的
      const now = await listChapters(s);
      const pending = now.filter((x) => !x.done && (tries.get(keyOf(x)) || 0) < 2);
      const next = pending[0];
      if (!next) { say('这门课能推进的任务点都用尽了（已完成或多次失败）', 'ok'); break; }
      tries.set(keyOf(next), (tries.get(keyOf(next)) || 0) + 1);

      say('进入第 ' + (next.i + 1) + '/' + now.length + ' 个任务点：' + next.t);
      const r = await clickChapter(s, next.i);
      if (!r || r.indexOf('clicked') !== 0) { say('点击章节失败：' + r, 'warn'); await openCourse(s, c); continue; }

      const u = await waitStudentstudy(s, 30000);
      if (!u) { say('没进到播放页，回目录重试', 'warn'); await openCourse(s, c); continue; }

      // 等面板挂载
      let hasPanel = false;
      for (let k = 0; k < 25; k++) {
        await sleep(1000);
        hasPanel = await s.eval("!!(document.getElementById('xt-ds-host')&&document.getElementById('xt-ds-host').shadowRoot)").catch(() => false);
        if (hasPanel) break;
      }
      if (!hasPanel) { say('面板没挂载，本节跳过', 'warn'); await openCourse(s, c); continue; }

      // API Key：localStorage 按 origin/profile 隔离，这里按需补种，避免「有时读不到要重输」
      const keyRes = await apikey.seedKey(s);
      if (keyRes === 'seeded') say('API Key 已补进本窗口（以后不用再输）', 'info');
      else if (keyRes === 'no-key') say('没有 apikey.txt，章节测验前需要手动填一次 Key', 'warn');
      await clickPanel(s, '开始');
      { const _st = await enforceStrict(s);
    if (_st === 'auto') say('模式：全自动（考试类页面仍会硬拦截）', 'warn');
    else if (_st === 'assist') say('模式：辅助（AI 填答案，提交须你本人点）', 'info');
    else if (_st !== 'standard') say('模式：只播放（不答题）', 'info'); }
      await sleep(1500);
      const rateRes = await setRate(s, CFG.speed);
      if (/^set-/.test(rateRes || '')) say('倍速已设为 ' + CFG.speed + 'x', 'info');
      await sleep(1000);

      // ---- 监控：脚本会自己跳下一节，这里只保安全、防停滞 ----
      let lastUrl = '';
      let lastCt = -1;
      let stallSince = Date.now();
      let endedSince = 0;
      let noVideoSince = 0;
      let pausedRounds = 0;
      let quizWaitSince = 0;
      let restMark = Date.now();
      let lastPrint = 0;
      let lastMaint = Date.now();
      let faceSeen = 0;

      while (true) {
        await sleep(4000);

        // 最小化/后台也保持页面「活跃」：焦点仿真让 hasFocus 为 true，
        // 配合 Edge 的 --disable-backgrounding-occluded-windows 让 visibilityState 一直是 visible，
        // 学习通播放器的失焦保护就不会暂停（实测窗口最小化 120 秒视频照常播、照常跳节）。
        try { await s.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
        // 页面可能换到另一个 chaoxing 子域，localStorage 不共通，缺就补
        try { if ((await apikey.seedKey(s)) === 'seeded') say('API Key 已补进当前页面', 'info'); } catch (e) {}

        // 夜间静默：落在配置时段内就暂停刷课（模拟人在睡觉，避开「凌晨连续学习」这个
        // 最容易被人工注意、收益又最低的时段）。时段支持跨零点，如 23:30~06:00。
        if (CFG.nightQuiet && CFG.nightQuiet.enabled) {
          const nowHm = new Date().toTimeString().slice(0, 5);
          const qs = CFG.nightQuiet.start, qe = CFG.nightQuiet.end;
          const inQuiet = qs <= qe ? (nowHm >= qs && nowHm < qe) : (nowHm >= qs || nowHm < qe);
          if (inQuiet) {
            await clickPanel(s, '停止').catch(() => {});
            const waitMin = 10;
            say(`夜间静默时段（${qs}~${qe}），已暂停刷课，${waitMin} 分钟后再看`, 'warn');
            await sleep(waitMin * 60 * 1000);
            continue;
          }
        }

        // 定时清理：截断日志 + 收临时文件 + 关多余标签 + 触发堆回收
        const maintEvery = (CFG.maintenance.everyMin || 15) * 60000;
        if (Date.now() - lastMaint > maintEvery) {
          lastMaint = Date.now();
          try {
            const r = await maintain.tick(CFG.maintenance);
            if (r && r !== '无需清理') say('定时清理：' + r);
          } catch (e) { say('定时清理出错：' + e.message, 'warn'); }
        }

        if (Date.now() - runT0 > CFG.maxRunMinutes * 60000) {
          say('达到单次运行上限 ' + CFG.maxRunMinutes + ' 分钟，正常收工', 'ok');
          // 正常收工不是风控，不能写熔断锁（stopAll 会 Guard.trip），只停面板即可
          await clickPanel(s, '停止').catch(() => {});
          b.close(); process.exit(0);
        }

        const raw = await s.eval(PROBE, {}, 15000).catch(() => null);
        if (!raw) continue;
        let sig = {}; try { sig = JSON.parse(raw); } catch (e) { continue; }

        // PROBE 用的是页面内 contentDocument 递归（只对同源 iframe 有效）。
        // 学习通有些章节把播放器放在**跨源 iframe**（mooc1 vs mooc2-ans / mooc1-1），
        // 这时 PROBE 会报「获取视频元素失败 / 无视频」，看起来就是卡死不动。
        // 用 CDP 逐 frame 求值兜底：CDP 有特权，能读到跨源 frame 里的 video。
        if (!sig.video) {
          let hit = null;
          // ① 同进程 iframe：逐 frame 建执行环境求值
          try {
            const found = await framesEval(s, VIDEO_PROBE_SRC, 8000);
            hit = found.find((x) => x && x.value && typeof x.value.d === 'number' && x.value.d > 0) || null;
            if (hit) sig.videoFrame = String(hit.url || '').slice(0, 80);
          } catch (e) { }
          // ② 跨进程 iframe（OOPIF）在 CDP 里是独立 target，要单独 attach 才能读到 video
          if (!hit) {
            try {
              const list = await httpJSON(PORT, '/json/list');
              for (const t of (list || [])) {
                if (!t || !t.webSocketDebuggerUrl || t.type === 'page') continue;
                if (!/iframe|worker/i.test(t.type)) continue;
                let ss = null;
                try {
                  ss = await b.attach(t.id);
                  const v = await ss.eval(VIDEO_PROBE_SRC, {}, 6000);
                  if (v && typeof v.d === 'number' && v.d > 0) {
                    hit = { value: v, url: t.url };
                    sig.videoFrame = String(t.url || '').slice(0, 80);
                    break;
                  }
                } catch (e) { }
              }
            } catch (e) { }
          }
          if (hit) sig.video = hit.value;
        }

        // 人脸信息采集弹窗：老师开了「人脸识别监控」的课程会在播放途中弹出来
        // （「请使用手机APP采集人脸信息后继续学习」+ 二维码），挡住视频。
        // 先尝试无害关闭（点 × / 移除遮罩）；关掉后继续看进度是否还在涨：
        // 涨 = 纯前端遮罩，绕过去了；连续 3 轮都弹 = 服务端强制，停下来不乱刷。
        try {
          const faceRaw = await s.eval(faceguard.PROBE_SRC, {}, 8000).catch(() => null);
          let faceHit = null;
          if (faceRaw) {
            if (typeof faceRaw === 'string') { try { faceHit = JSON.parse(faceRaw); } catch (e) { faceHit = null; } }
            else if (typeof faceRaw === 'object') faceHit = faceRaw;
          }
          if (faceHit && faceHit.found) {
            faceSeen++;
            const fcfg = facecheck.cfg();
            say('检测到「人脸信息采集」弹窗（第 ' + faceSeen + ' 次）：' +
              String(faceHit.text || '').replace(/\s+/g, ' ').slice(0, 60), 'warn');
            if (faceHit.qr && faceHit.qr.img) say('二维码地址：' + String(faceHit.qr.img).slice(0, 120));
            say('人脸校验配置：mode=' + fcfg.mode + '，dismissOnly=' + fcfg.dismissOnly +
              '，照片=' + (facecheck.loadPhoto(fcfg.photo) ? fcfg.photo : '未放置'), 'warn');
            // 记录到 SQL 无关的本地事件表，供面板展示与事后审计
            try {
              const ev = { ts: new Date().toISOString(), kind: 'face-popup', seen: faceSeen, text: String(faceHit.text || '').slice(0, 200), qr: faceHit.qr || null, mode: fcfg.mode };
              require('fs').appendFileSync(require('path').join(__dirname, 'face-events.jsonl'), JSON.stringify(ev) + '\n');
            } catch (e) {}
            const dr = await s.eval(faceguard.DISMISS_SRC, {}, 8000).catch(() => 'err');
            say('弹窗处理结果：' + dr, /^(closed|removed)/.test(dr || '') ? 'ok' : 'warn');
            if (faceSeen >= 3) {
              say('人脸弹窗反复出现、关掉也不解决问题（需要真实采集），停止刷课以免白刷和账号风险', 'err');
              await clickPanel(s, '停止').catch(() => {});
              Guard.trip(60, '人脸校验拦截', '连续 3 次检测到人脸采集弹窗');
              b.close(); process.exit(0);
            }
            await sleep(2500);
          } else if (faceSeen > 0) {
            say('人脸弹窗已消失，恢复正常刷课', 'ok');
            faceSeen = 0;
          }
        } catch (e) {}

        // 这一节根本没有任何 video（播放器没渲染出来，实测会出现：页面正常但 iframe 里无播放器）
        // → 45 秒还没起来就跳过这一节，别在这里干等 12 分钟
        if (!sig.video) {
          if (!noVideoSince) noVideoSince = Date.now();
          if (Date.now() - noVideoSince > 45000) {
            say('这一节 45 秒都没加载出播放器，跳过进入下一节', 'warn');
            noVideoSince = 0;
            await clickPanel(s, '停止').catch(() => {});
            break;
          }
        } else {
          noVideoSince = 0;
        }

        // 卡在暂停：脚本点不动跨源 iframe 里的播放器，这里用 CDP 直接调 play()
        if (sig.video && sig.video.paused && !sig.video.ended) {
          pausedRounds++;
          if (pausedRounds >= 2) {
            const n = await forcePlay(b, s).catch(() => 0);
            say('视频卡在暂停，已用 CDP 强推播放（第 ' + pausedRounds + ' 轮，命中 ' + (n || 0) + ' 个视频）', 'warn');
          }
          if (pausedRounds >= 6) {
            say('连续 6 轮推不动，跳过这一节', 'warn');
            pausedRounds = 0;
            await clickPanel(s, '下一节').catch(() => {});
            break;
          }
        } else {
          pausedRounds = 0;
        }


        // 合规闸门：严格模式下遇到测验/答题页，立刻收手，绝不代替本人作答或提交
        // ① 考试类页面：任何模式都硬拦截（考试是风险最高的一类，代码层面不碰）
        if (compliance.examBlocked()) {
          let isExam = false;
          try { isExam = !!(await s.eval(EXAM_DETECT_SRC, {}, 6000)); } catch (e) { }
          if (isExam) {
            say('检测到考试类页面 —— 已跳过（本程序不参与任何考试）', 'err');
            compliance.audit('exam-skip', 'blocked');
            try { await clickPanel(s, '停止').catch(() => { }); } catch (e) { }
            await clickPanel(s, '下一节').catch(() => { });
            break;
          }
        }

        if (compliance.isAssist()) {
          try {
            const isQuiz2 = !!(await s.eval(QUIZ_DETECT_SRC, {}, 6000));
            if (isQuiz2 && !quizWaitSince) {
              quizWaitSince = Date.now();
              say('检测到测验页：答案会自动填入，提交请你自己点（已拦截自动提交）', 'warn');
            } else if (!isQuiz2) {
              quizWaitSince = 0;
            }
          } catch (e) { }
        } else if (compliance.isStrict()) {
          let isQuiz = false;
          try { isQuiz = !!(await s.eval(QUIZ_DETECT_SRC, {}, 6000)); } catch (e) { }
          if (isQuiz) {
            if (!quizWaitSince) {
              quizWaitSince = Date.now();
              await clickPanel(s, '停止').catch(() => { });
              say('合规模式：检测到测验页，已暂停自动作答 —— 请本人核对后手动提交', 'warn');
              compliance.audit('quiz-blocked', 'strict');
            }
            if (Date.now() - quizWaitSince < 30 * 60 * 1000) {
              await sleep(15000);
              continue;
            }
            say('测验页停留超过 30 分钟，跳过这一节继续后面的', 'warn');
            quizWaitSince = 0;
            await clickPanel(s, '下一节').catch(() => { });
            break;
          } else if (quizWaitSince) {
            quizWaitSince = 0;
            say('测验已完成，恢复自动播放', 'ok');
            await clickPanel(s, '开始').catch(() => { });
          }
        }

        // 每分钟打一次进度心跳，避免"看着像卡死"
        if (Date.now() - lastPrint > 60000) {
          lastPrint = Date.now();
          const v = sig.video || {};
          const pos = v.d ? (Math.floor(v.t || 0) + 's/' + Math.floor(v.d) + 's') : '无视频';
          say('运行中 · ' + pos + ' · ' + (v.paused ? '暂停' : '播放中') +
            (v.rate ? ' · ' + v.rate + 'x' : '') +
            (sig.panelText ? ' · ' + String(sig.panelText).replace(/\s+/g, ' ').slice(0, 40) : ''));
        }

        // 行为体检
        state.minutesElapsed = (Date.now() - runT0) / 60000;
        if (sig.video && sig.video.d > 0) state.avgVideoMinutes = sig.video.d / 60;
        const hb = await sentinel.heartbeat((expr) => s.eval(expr, {}, 15000), state);
        if (!hb.ok) {
          await stopAll(s, hb.issues.filter((i) => i.fatal).map((i) => i.note).join('、'), sig.url);
          b.close(); process.exit(0);
        }
        for (const it of hb.issues) if (!it.fatal) say('体检提示：' + it.note, 'warn');

        // 风险计分
        const g = G.evaluate(sig);
        if (g.hits.length) say('风险信号：' + g.hits.map((h) => h.label).join('、') + '（评分 ' + g.score + '）', 'warn');
        if (g.level === 'trip') {
          await stopAll(s, g.hits.map((h) => h.label).join('、'), sig.url);
          b.close(); process.exit(0);
        }
        if (g.level === 'pause') {
          say('评分偏高，暂停 ' + CFG.restMinutes + ' 分钟观察', 'warn');
          await clickPanel(s, '停止');
          await sleep(CFG.restMinutes * 60000);
          G.score = Math.floor(G.score / 2);
          await clickPanel(s, '开始');
      if (compliance.isStrict()) { const _st = await enforceStrict(s); if (_st !== 'standard') say('合规模式：已关闭「自动答题」（' + _st + '），只做播放自动化', 'info'); }
          restMark = Date.now();
        }

        // 定时休息（长时间连续播放最容易被判机器）
        if (CFG.restEveryMinutes > 0 && Date.now() - restMark > CFG.restEveryMinutes * 60000) {
          say('连续跑了 ' + CFG.restEveryMinutes + ' 分钟，休息 ' + CFG.restMinutes + ' 分钟', 'warn');
          await clickPanel(s, '停止');
          await sleep(CFG.restMinutes * 60000);
          await clickPanel(s, '开始');
      if (compliance.isStrict()) { const _st = await enforceStrict(s); if (_st !== 'standard') say('合规模式：已关闭「自动答题」（' + _st + '），只做播放自动化', 'info'); }
          restMark = Date.now();
        }

        const cur = await s.eval('location.href').catch(() => '');
        if (cur && cur !== lastUrl) {
          lastUrl = cur;
          stallSince = Date.now();
        }
        if (sig.video && typeof sig.video.t === 'number') {
          if (Math.abs(sig.video.t - lastCt) > 0.8) { lastCt = sig.video.t; stallSince = Date.now(); }
        }
        // 面板/页面出现"任务点已完成"也算进展，避免把正常学完误判成卡住
        if (/任务点已完成|已看完|已学完/.test((sig.panelText || '') + ' ' + (sig.popText || ''))) stallSince = Date.now();

        // 视频播到结尾（ended）但页面迟迟不跳节：实测会干等 12 分钟，这里 60 秒就主动换节
        if (sig.video && sig.video.ended) {
          if (!endedSince) endedSince = Date.now();
          else if (Date.now() - endedSince > 60000) {
            say('视频已播完但页面没跳节，主动回目录换下一节', 'warn');
            await clickPanel(s, '停止');
            break;
          }
        } else {
          endedSince = 0;
        }

        const pl = sig.panelText || '';
        if (/全部完成|课程已完成|没有更多/.test(pl)) { say('本课程任务点已刷完', 'ok'); break; }

        // 停滞太久：很可能卡在未完成任务点/题库上，回目录换下一节
        if (Date.now() - stallSince > CFG.stallMinutes * 60000) {
          say('本节 ' + CFG.stallMinutes + ' 分钟没进展（可能卡在测验/任务点），回目录换下一节', 'warn');
          await clickPanel(s, '停止');
          break;
        }
      }

      done++; state.chaptersDone++;
      await openCourse(s, c); // 回目录，准备下一节
      await sleep(rnd(CFG.chapterGapSec[0], CFG.chapterGapSec[1]) * 1000);
    }
  }

  say('全部任务结束', 'ok');
  b.close();
  process.exit(0);
})().catch((e) => {
  say('运行出错：' + e.message, 'err');
  console.error(e.stack);
  process.exit(1);
});
