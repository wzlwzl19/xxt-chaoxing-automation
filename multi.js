// —— 授权闸门（失败即退出，不可绕过）——
require('./license').guard();
// —— 授权闸门结束 ——
/**
 * 多账号调度器
 *
 * 设计要点（为什么这么做）：
 * 1. 一个账号一个独立的 Edge profile 目录 —— 学习通的登录态就是 cookie，
 *    两个账号在同一个浏览器里必然互相顶掉，所以物理隔离是唯一稳妥的办法。
 * 2. 端口从 9300 起按账号索引固定分配，调度器只管拉起/看护，不管业务逻辑，
 *    业务仍然由 autopilot.js 单账号跑 —— 这样单账号的稳定性不会因为多账号被破坏。
 * 3. 并行度默认 2。并行越多越快，但内存和"同 IP 多账号同时在线"的画像也越重，
 *    2 个是速度和安全之间比较稳的点。可用 accounts.json 里的 parallel 调。
 * 4. 每个 Edge 实例都带省内存参数（--renderer-process-limit / --disable-gpu），
 *    单实例稳定在 300MB 上下，两个约 600~700MB，普通电脑不会卡。
 * 5. 账号密码用 Windows DPAPI 加密存在 accounts.json 里，
 *    只在本机、只对当前 Windows 用户可解，不做任何网络上传。
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const http = require('http');
const binding = require('./binding');

const DIR = __dirname;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const NODE = (function () {
  const cands = [
    process.env.XXT_NODE,
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ];
  for (const c of cands) {
    if (c && /node(\.exe)?$/i.test(c) && fs.existsSync(c)) return c;
  }
  if (/node(\.exe)?$/i.test(process.execPath)) return process.execPath;
  return 'node';
})();

const ACC_FILE = path.join(DIR, 'accounts.json');
const LOG_DIR = path.join(DIR, 'logs');
const MULTI_LOG = path.join(DIR, 'multi.log');
const PROFILES = path.join(DIR, 'profiles');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(PROFILES)) fs.mkdirSync(PROFILES, { recursive: true });

function log(msg) {
  const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(MULTI_LOG, line + '\n', 'utf8'); } catch (e) {}
}

function readJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return def; }
}

function loadAccounts() {
  const data = readJSON(ACC_FILE, { parallel: 2, accounts: [] });
  if (!Array.isArray(data.accounts)) data.accounts = [];
  return data;
}

function safeName(user) {
  return String(user).replace(/[^0-9A-Za-z_@.-]/g, '_');
}

function httpJSON(port, p) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (r) => {
      let d = '';
      r.on('data', (c) => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort(port, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await httpJSON(port, '/json/version');
      if (v && v.webSocketDebuggerUrl) return v;
    } catch (e) {}
    await sleep(500);
  }
  return null;
}

function startEdge(port, profile) {
  const args = [
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + port,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,760',
    '--disable-features=CalculateNativeWinOcclusion,AutofillServerCommunication,PasswordManagerOnboarding,InterestFeedContentSuggestions,OptimizationHints,MediaRouter',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--metrics-recording-only',
    '--disable-ipc-flooding-protection',
    '--memory-pressure-off',
    // —— 省内存但保留 GPU（关 GPU 会让视频掉帧、界面发卡）——
    '--js-flags=--max-old-space-size=512',
    '--renderer-process-limit=2',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-extension-debugging',
    'about:blank',
  ];
  const child = spawn(EDGE, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

function killTree(pid) {
  return new Promise((res) => {
    if (!pid) return res();
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => res());
  });
}

/** 换号时清空一个窗口的登录态：cookie / 本地存储 / 保险箱，避免新号继承旧号会话 */
function wipeProfileAuth(profileDir) {
  const targets = [
    'Default\\Cookies', 'Default\\Cookies-journal', 'Default\\Network\\Cookies',
    'Default\\Network\\Cookies-journal', 'Default\\Local Storage', 'Default\\Session Storage',
    'creds.dpapi', 'account.txt', 'account-meta.json', 'binding.json', 'start-opts.json',
  ];
  let n = 0;
  for (const rel of targets) {
    const p = path.join(profileDir, rel);
    try {
      if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); n++; }
    } catch (e) {}
  }
  return n;
}

/** 一个账号跑完（或失败）后返回 {ok, code, minutes} */
function runAutopilot(acc, port, profile, opts) {
  return new Promise((resolve) => {
    const tag = safeName(acc.user || ('slot' + port));
    const logFile = path.join(LOG_DIR, tag + '.log');
    const out = fs.openSync(logFile, 'a');
    const args = [
      path.join(DIR, 'autopilot.js'),
      '--port', String(port),
      '--profile', profile,
      '--user', String(acc.user || ''),
    ];
    if (opts.manual) {
      args.push('--manual-login');
      // 多窗口要一个个手动登录，30 分钟够用；单账号默认 10 分钟太紧
      args.push('--wait-login-min', '30');
    }
    if (opts.phone) args.push('--phone', String(opts.phone));
    if (opts.course) args.push('--course', opts.course);
    if (opts.maxChapters) args.push('--max-chapters', String(opts.maxChapters));

    const t0 = Date.now();
    const child = spawn(NODE, args, {
      cwd: DIR,
      stdio: ['ignore', out, out],
      windowsHide: true,
      // 每窗口独立 vault 目录：密码文件、account.txt 全在各自 profile 里，
      // 两个窗口绝不共用一份 creds.dpapi（共用就会互相覆盖，登错号）
      env: Object.assign({}, process.env, { XXT_VAULT_DIR: profile }),
    });
    log('  [' + acc.user + '] autopilot 启动 pid=' + child.pid + ' port=' + port +
      (opts.manual ? '（手动登录）' : '（自动登录）'));

    child.on('exit', (code) => {
      try { fs.closeSync(out); } catch (e) {}
      const minutes = Math.round((Date.now() - t0) / 60000);
      log('  [' + acc.user + '] autopilot 退出 code=' + code + ' 用时 ' + minutes + ' 分钟');
      resolve({ ok: code === 0, code, minutes });
    });
    child.on('error', (e) => {
      try { fs.closeSync(out); } catch (x) {}
      log('  [' + acc.user + '] autopilot 启动失败：' + e.message);
      resolve({ ok: false, code: -1, minutes: 0 });
    });
  });
}

/** 简易并发池：同时最多 n 个任务 */
async function pool(items, n, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(n, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = { ok: false, error: e.message }; }
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const argv = process.argv.slice(2);
  const data = loadAccounts();
  const only = (function () { const i = argv.indexOf('--user'); return i > -1 ? argv[i + 1] : null; })();
  const course = (function () { const i = argv.indexOf('--course'); return i > -1 ? argv[i + 1] : null; })();
  const maxChapters = (function () { const i = argv.indexOf('--max-chapters'); return i > -1 ? Number(argv[i + 1]) : 0; })();
  const dryRun = argv.includes('--dry');
  const forceManual = argv.includes('--manual');
  // --count N：按"窗口数量"开跑（面板里填的数字）。已存账号优先自动登录，不够的补手动登录槽。
  const count = (function () {
    const i = argv.indexOf('--count');
    if (i < 0) return 0;
    return Math.max(1, Math.min(Math.round(Number(argv[i + 1]) || 0) || 1, 6));
  })();

  if (count >= 1) {
    // 版本上限（A=1 / B=3 / C=6），由 switch-version.js 写进 version.json
    const maxSlots = (function () {
      const i = argv.indexOf('--max-slots');
      if (i > -1) return Math.max(1, Math.min(Number(argv[i + 1]) || 6, 6));
      try {
        const v = readJSON(path.join(DIR, 'version.json'), { maxSlots: 6 });
        return Math.max(1, Math.min(Number(v.maxSlots) || 6, 6));
      } catch (e) { return 6; }
    })();
    const realCount = Math.min(count, maxSlots);

    // 每行一个账号：{phone, course}。从 start-opts.json 读（Windows 命令行传中文会乱码）
    let rowSlots = [];
    try {
      const so = readJSON(path.join(DIR, 'start-opts.json'), {});
      if (Array.isArray(so.slots)) rowSlots = so.slots;
      else if (Array.isArray(so.phones)) rowSlots = so.phones.map((p) => ({ phone: p, course: so.course || '' }));
      // 密码已经读进内存，立刻把文件里的明文抹掉（万一中途被杀，磁盘上不留密码）
      if (Array.isArray(so.slots) && so.slots.some((s) => s && s.pass)) {
        try {
          const cleaned = Object.assign({}, so, {
            slots: so.slots.map((s) => ({ phone: (s && s.phone) || '', course: (s && s.course) || '' })),
          });
          fs.writeFileSync(path.join(DIR, 'start-opts.json'), JSON.stringify(cleaned, null, 2), 'utf8');
        } catch (e) { }
      }
    } catch (e) { }

    const slots = [];
    for (let i = 0; i < realCount; i++) {
      const row = rowSlots[i] || {};
      const slotPhone = String(row.phone || '').replace(/\s/g, '');
      const slotPass = String(row.pass || '');
      const slotCourse = String(row.course || '').trim();
      const acc = data.accounts[i];
      const useAuto = !forceManual && acc && acc.user && acc.enabled !== false;
      if (useAuto) {
        slots.push({
          mode: 'auto', acc, port: 9300 + i,
          profile: path.join(PROFILES, safeName(acc.user)),
          phone: slotPhone || String(acc.user), pass: slotPass, course: slotCourse,
        });
      } else {
        const tag = 'slot' + (i + 1);
        slots.push({
          mode: 'manual', acc: { user: tag }, port: 9300 + i,
          profile: path.join(PROFILES, tag),
          phone: slotPhone, pass: slotPass, course: slotCourse,
        });
      }
    }

    // —— 空行不再清空存档：沿用该窗口上一次的登录态（避免"明明登着却被踢下线又要输密码"）——
    //    真要重来，请用 清空窗口.cmd 或删掉对应 profiles\slotN 目录
    slots.forEach((s, i) => {
      try { if (!fs.existsSync(s.profile)) fs.mkdirSync(s.profile, { recursive: true }); } catch (e) {}
      if (!s.phone && !s.pass) log('  · [slot' + (i + 1) + '] 未填账号 → 沿用该窗口上次的登录态');
    });

    // —— 防串号第一步：启动前检查每个窗口的绑定关系 ——
    // 换号（同一行改成另一个号码）是正常操作：清空该窗口的登录态后重新绑定，
    // 绝不允许因为"已经绑过别的号"就直接不开窗口（那会导致填 3 个号只出 2 个窗）。
    const refused = [];
    const usable = [];
    slots.forEach((s, i) => {
      const phone = s.phone || '';
      if (!fs.existsSync(s.profile)) fs.mkdirSync(s.profile, { recursive: true });
      const c = binding.checkBeforeStart(s.profile, i + 1, phone);
      if (!c.ok) {
        log('  ✗ [slot' + (i + 1) + '] ' + c.reason);
        refused.push({ slot: i + 1, reason: c.reason });
        return;
      }
      if (c.changed) {
        // 换号：删掉该窗口的 cookie / 保险箱 / 旧绑定，保证新号不会继承旧号会话
        wipeProfileAuth(s.profile);
        binding.reset(s.profile);
        binding.checkBeforeStart(s.profile, i + 1, phone);
        log('  ↻ [slot' + (i + 1) + '] 换号：' + (c.prevUser || '?') + ' → ' + phone + '，已清空该窗口登录态');
      }
      s.phone = phone;
      s.boundUid = (c.bound && c.bound.uid) || '';
      usable.push(s);
      log('  ✓ [slot' + (i + 1) + '] port=' + s.port + ' profile=' + path.basename(s.profile) +
        (s.phone ? ' 绑定号码=' + s.phone : ' 未指定号码') +
        ' 课程=' + (s.course || '全部') +
        (s.boundUid ? '（上次登录 uid=' + s.boundUid + '）' : ''));
    });

    if (!usable.length) {
      log('没有可用窗口（全部因绑定冲突被拒绝），退出');
      return { refused: refused };
    }

    log('===== 按数量开窗口 =====');
    log('窗口 ' + usable.length + ' 个（上限 ' + maxSlots + '）' +
      (refused.length ? '，拒绝 ' + refused.length + ' 个' : '') +
      (course ? '，限定课程「' + course + '」' : ''));

    if (dryRun) {
      usable.forEach((s, i) => log('  #' + (i + 1) + ' ' + s.acc.user + ' → port ' + s.port +
        ' profile ' + path.basename(s.profile) + ' [' + s.mode + ']' + (s.phone ? ' 号码=' + s.phone : '')));
      return;
    }

    // 先把所有窗口都拉起来（用户要能同时看到 N 个窗口分别登录）
    // 错峰 2.2 秒开一个：6 个 Chromium 同时冷启动会把 CPU 打满，反而每个都卡
    for (const s of usable) {
      let ver = null;
      try { ver = await httpJSON(s.port, '/json/version'); } catch (e) {}
      if (!ver) {
        startEdge(s.port, s.profile);
        log('  [' + s.acc.user + '] 窗口已打开 port=' + s.port);
        await sleep(2200);
      } else {
        log('  [' + s.acc.user + '] 复用已有窗口 port=' + s.port);
      }
    }

    // 等所有窗口就绪
    for (const s of usable) {
      const ver = await waitPort(s.port, 30000);
      if (!ver) log('  [' + s.acc.user + '] 浏览器起不来（port ' + s.port + '）');
    }

    // 有号码+密码的行：先把密码写进该窗口自己的保险箱，之后 autopilot 自动登录
    for (const s of usable) {
      if (s.phone && s.pass) {
        try {
          const { spawnSync } = require('child_process');
          const r = spawnSync(NODE, [path.join(DIR, 'save-cred.js'), s.profile, s.phone], {
            input: String(s.pass), encoding: 'utf8', windowsHide: true, timeout: 30000,
          });
          if (r.status === 0) {
            s.autoCred = true;
            s.acc = { user: s.phone };
            log('  ✓ [' + s.phone + '] 密码已写入本窗口保险箱（自动登录）');
          } else {
            log('  ✗ [' + (s.phone || 'slot') + '] 写入密码失败：' +
              String(r.stderr || r.stdout || '').trim().slice(0, 80) + ' → 改为手动登录');
          }
        } catch (e) {
          log('  ✗ [' + (s.phone || 'slot') + '] 写入密码异常：' + e.message + ' → 改为手动登录');
        }
      }
    }

    const autoN = usable.filter((s) => s.autoCred).length;
    log('自动填账号密码 ' + autoN + ' 个，手动登录 ' + (usable.length - autoN) + ' 个');

    // autopilot 并发：默认每个窗口都跑（用户预期「开了 N 个就该 N 个都在动」）。
    // 注意不能拿 accounts.json 里的 parallel（默认 2）当默认值 —— 那会让第 3 个窗口永远排队。
    // 只有显式 --parallel N 才限流。
    const parArg = (function () { const i = argv.indexOf('--parallel'); return i > -1 ? Number(argv[i + 1]) : 0; })();
    const parallel = Math.max(1, Math.min(parArg > 0 ? parArg : usable.length, usable.length));
    const results = await pool(usable, parallel, async (s, idx) => {
      if (idx > 0) await sleep(1200 * idx); // 错峰：避免 6 个 autopilot 同时抢 CPU 造成集体卡顿
      const r = await runAutopilot(s.acc, s.port, s.profile, {
        course: s.course || course, maxChapters,
        manual: !s.autoCred, phone: s.phone,
      });
      return { ...r, user: s.acc.user, mode: s.autoCred ? 'auto' : 'manual', phone: s.phone };
    });

    log('===== 汇总 =====');
    let okCount = 0;
    results.forEach((r, i) => {
      const u = (r && r.user) || usable[i].acc.user;
      if (r && r.ok) okCount++;
      log('  ' + u + ' → ' + (r && r.ok ? '正常结束' : '未完成/出错') + (r && r.minutes ? '（' + r.minutes + ' 分钟）' : ''));
    });
    log('完成 ' + okCount + '/' + usable.length);
    return { refused: refused };
  }

  let targets = data.accounts.filter((a) => a && a.user && a.enabled !== false);
  if (only) targets = targets.filter((a) => String(a.user) === String(only));

  if (!targets.length) {
    log('accounts.json 里没有可跑的账号。先执行：node accounts.js add');
    return;
  }

  const parallel = Math.max(1, Math.min(Number(data.parallel) || 2, targets.length));
  log('===== 多账号刷课开始 =====');
  log('账号 ' + targets.length + ' 个，并行度 ' + parallel + (course ? '，限定课程「' + course + '」' : ''));
  if (dryRun) {
    targets.forEach((a, i) => log('  #' + (i + 1) + ' ' + a.user + ' → port ' + (9300 + i) + ' profile ' + safeName(a.user)));
    return;
  }

  const items = targets.map((acc, i) => ({ acc, port: 9300 + i, profile: path.join(PROFILES, safeName(acc.user)) }));

  const results = await pool(items, parallel, async (item) => {
    const { acc, port, profile } = item;
    log('[' + acc.user + '] 准备中（port ' + port + '）');

    // 1) 浏览器：端口活着就复用，否则拉起
    let ver = null;
    try { ver = await httpJSON(port, '/json/version'); } catch (e) {}
    if (!ver) {
      if (!fs.existsSync(profile)) fs.mkdirSync(profile, { recursive: true });
      startEdge(port, profile);
      ver = await waitPort(port);
      if (!ver) {
        log('[' + acc.user + '] 浏览器起不来（端口 ' + port + '），跳过');
        return { ok: false, error: 'browser-not-ready' };
      }
    }
    log('[' + acc.user + '] 浏览器就绪 ' + ver.Browser);

    // 2) 让 autopilot 干活
    const r = await runAutopilot(acc, port, profile, { course, maxChapters });
    return { ...r, user: acc.user };
  });

  log('===== 汇总 =====');
  let okCount = 0;
  results.forEach((r, i) => {
    const u = (r && r.user) || items[i].acc.user;
    if (r && r.ok) okCount++;
    log('  ' + u + ' → ' + (r && r.ok ? '正常结束' : '未完成/出错') + (r && r.minutes ? '（' + r.minutes + ' 分钟）' : ''));
  });
  log('完成 ' + okCount + '/' + items.length);
}

if (require.main === module) {
  main().catch((e) => { log('FATAL ' + e.message); process.exitCode = 1; });
}

module.exports = { loadAccounts, runAutopilot, startEdge, waitPort, killTree, log, NODE, DIR, PROFILES, LOG_DIR };
