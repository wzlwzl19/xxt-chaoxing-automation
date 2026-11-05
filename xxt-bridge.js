// xxt-bridge.js —— 学习通刷课的后端小服务（只绑 127.0.0.1:9333）
// DSH 插件、命令行、任何本机程序都可以通过它启动/查询/停止刷课。
//   GET  /status        进程与进度
//   GET  /log?since=N   增量日志
//   POST /start         {user, pass, course, maxChapters, speed, remember}
//   POST /stop          停止刷课
//   POST /open          只打开浏览器到学习通（不刷）
//   GET  /ping          存活探针
'use strict';

// —— 授权闸门（失败即退出，不可绕过）——
require('./license').guard();
// —— 授权闸门结束 ——
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const DIR = __dirname;
const PORT = 9333;
const STATE_FILE = path.join(DIR, 'bridge-state.json');
const MAX_LINES = 600;
// 注意：本脚本可能被 DSH(Electron) 当子进程拉起，此时 process.execPath 是
// "DeepSeek Harness.exe"，拿它 spawn autopilot 会多开一个完整 Electron 实例
// （吃内存、启动慢、还占一个窗口）。所以显式找真正的 node.exe。
const NODE = (function () {
  const fs = require('fs');
  const cands = [
    process.env.XXT_NODE,
    process.env.NODE_EXE,
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ];
  for (const c of cands) {
    if (c && /node(\.exe)?$/i.test(c) && fs.existsSync(c)) return c;
  }
  if (/node(\.exe)?$/i.test(process.execPath)) return process.execPath;
  return 'node';
})();

let child = null;
let startedAt = 0;
let exitCode = null;
let lastError = '';
let lines = [];
let seq = 0;
let stopping = false; // 区分「用户主动停止」与「异常退出」

const state = {
  running: false,
  phase: 'idle',      // idle | starting | logging-in | running | paused | done | error
  account: '',
  uid: '',
  course: '',
  chapter: '',
  percent: 0,
  courses: [],
  note: '',
  pid: 0,
  startedAt: 0,
  updatedAt: 0,
  face: { seen: 0, last: '', at: 0 },
  count: 1,        // 本次开了几个窗口
  multi: false,    // 是否走了多窗口调度器
  slots: [],       // 每个窗口的绑定情况 [{slot,port,phone,uid,state}]
};

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function push(text, level) {
  const raw = String(text || '').replace(/\r/g, '');
  for (const one of raw.split('\n')) {
    const t = one.trim();
    if (!t) continue;
    seq++;
    lines.push({ n: seq, t: stamp(), m: t, l: level || '' });
  }
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
}

function persist() {
  state.updatedAt = Date.now();
  state.running = !!child;
  state.pid = child ? child.pid : 0;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(Object.assign({}, state, { exitCode, lastError }), null, 2), 'utf8');
  } catch (_) { }
}

// autopilot 的 stdout 逐行解析成状态
function absorb(line) {
  const t = line.trim();
  if (!t) return;
  push(t);

  // 多窗口：把每个 slot 的绑定情况记下来，面板能看出"哪个窗口是谁"
  let ms;
  if ((ms = t.match(/\[slot(\d+)\] port=(\d+) profile=(\S+) 绑定号码=(\S*)/))) {
    const n = Number(ms[1]);
    state.slots = state.slots.filter((x) => x.slot !== n);
    state.slots.push({ slot: n, port: Number(ms[2]), profile: ms[3], phone: ms[4] || '', uid: '', state: '已绑定' });
    state.slots.sort((a, b) => a.slot - b.slot);
  } else if ((ms = t.match(/✗ \[slot(\d+)\] (.+)$/))) {
    const n = Number(ms[1]);
    state.slots = state.slots.filter((x) => x.slot !== n);
    state.slots.push({ slot: n, port: 0, profile: '', phone: '', uid: '', state: '拒绝:' + ms[2].slice(0, 40) });
    state.slots.sort((a, b) => a.slot - b.slot);
  }

  let m;
  if ((m = t.match(/当前登录账号：uid=(\S+?)，名下 (\d+) 门课/))) {
    state.uid = m[1];
    // 不覆盖 state.account（它记的是手机号，用于切号判断；uid 单独放 state.uid）
    state.phase = 'running';
    state.note = '已登录，名下 ' + m[2] + ' 门课';
  } else if ((m = t.match(/^\[OK\] 登录成功/))) {
    state.phase = 'running';
    state.note = '登录成功';
  } else if (/未登录，走自动登录/.test(t)) {
    state.phase = 'logging-in';
    state.note = '正在登录';
  } else if ((m = t.match(/=====\s*课程：(.+?)\s*=====/))) {
    state.course = m[1];
    state.chapter = '';
    state.percent = 0;
    state.note = '进入课程';
  } else if ((m = t.match(/进入第 (\d+)\/(\d+) 个任务点：(.+)$/))) {
    state.chapter = m[3];
    state.percent = Math.round((parseInt(m[1], 10) / Math.max(1, parseInt(m[2], 10))) * 100);
    state.note = '播放中';
  } else if ((m = t.match(/视频开始播放：(.+?)\s*\(/))) {
    state.chapter = m[1];
  } else if (/本课程任务点已刷完|全部任务结束/.test(t)) {
    state.phase = 'done';
    state.percent = 100;
    state.note = '课程已刷完';
  } else if (/安全自检未通过|已拒绝启动/.test(t)) {
    state.phase = 'error';
    state.note = '安全自检未通过，已拒绝启动';
  } else if (/\[X\]|运行出错|熔断/.test(t)) {
    state.phase = 'error';
    state.note = t.slice(0, 80);
  } else if (/定时清理/.test(t)) {
    // 清理日志不进 note，避免刷屏
  } else if ((m = t.match(/检测到「人脸信息采集」弹窗（第 (\d+) 次）：([\s\S]*)$/))) {
    state.face = { seen: parseInt(m[2], 10) || 1, last: String(m[3] || '').slice(0, 80), at: Date.now() };
    state.note = '人脸校验弹窗（第 ' + m[2] + ' 次）';
  } else if (/人脸弹窗已消失，恢复正常刷课/.test(t)) {
    state.face = { seen: 0, last: '已自动关闭', at: Date.now() };
    state.note = '人脸弹窗已关闭，继续刷课';
  } else if (/人脸校验拦截|人脸弹窗反复出现/.test(t)) {
    state.phase = 'error';
    state.note = '人脸校验拦截，已停止';
  }
}

async function startAutopilot(opts) {
  // 切换账号：旧任务还在跑就先把整棵进程树结束掉，绝不能拿旧账号的会话去刷
  if (child) {
    const prev = state.account ? String(state.account) : '';
    const next = opts.user ? String(opts.user) : '';
    if (next && prev && next !== prev) {
      push('— 检测到切换账号（' + prev + ' → ' + next + '），先结束旧任务 —');
      stopAutopilot();
      for (let i = 0; i < 20 && child; i++) await new Promise((r) => setTimeout(r, 200));
    }
    if (child) return { ok: false, error: '已经在跑了，先停止' };
  }
  const args = ['autopilot.js'];
  if (opts.manual) {
    // 手动登录模式：浏览器里已经登录就直接沿用（绝不把正在刷课的人踢下线），
    // 没登录才跳登录页等用户输入。只有显式传 relogin 才强制登出重登。
    args.push('--manual-login');
    // 手动登录要等人，默认 10 分钟太短（用户可能不在电脑前）
    args.push('--wait-login-min', '120');
    if (opts.relogin) args.push('--force-relogin');
  } else if (opts.user) {
    args.push('--user', String(opts.user));
  }
  if (opts.phone) args.push('--phone', String(opts.phone));
  if (opts.course) args.push('--course', String(opts.course));
  const max = parseInt(opts.maxChapters, 10);
  if (max > 0) args.push('--max-chapters', String(max));

  // Windows 命令行传中文参数会乱码（实测「军事理论」到子进程变成 ????），
  // 所以把选项写进文件，autopilot 优先读它。
  try {
    require('fs').writeFileSync(
      require('path').join(DIR, 'start-opts.json'),
      JSON.stringify({ course: opts.course || '', maxChapters: parseInt(opts.maxChapters, 10) || 0 }),
      'utf8'
    );
  } catch (e) { /* 写不了就退回命令行参数 */ }

  state.phase = 'starting';
  state.note = '启动中…';
  state.course = opts.course || '';
  state.chapter = '';
  state.percent = 0;
  state.account = opts.manual ? '（手动登录）' : (opts.user ? String(opts.user) : '');
  exitCode = null;
  lastError = '';
  startedAt = Date.now();
  state.startedAt = startedAt;

  child = spawn(NODE, args, {
    cwd: DIR,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { FORCE_COLOR: '0' }),
  });
  state.running = true;
  state.pid = child.pid;

  const onData = (buf, lvl) => {
    String(buf).split('\n').forEach((l) => { if (l.trim()) absorb(l); });
  };
  child.stdout.on('data', (b) => onData(b));
  child.stderr.on('data', (b) => onData(b, 'err'));

  child.on('exit', (code) => {
    exitCode = code;
    child = null;
    state.running = false;
    state.pid = 0;
    if (stopping) {
      // 用户主动停止：taskkill 杀掉进程 exit code 非 0，这里不能被误判成 error
      stopping = false;
      state.phase = 'idle';
      state.note = '已停止';
    } else if (state.phase !== 'done' && state.phase !== 'error') {
      state.phase = code === 0 ? 'done' : 'error';
      if (code !== 0) state.note = '进程退出，代码 ' + code;
    }
    push('— 刷课进程已退出（代码 ' + code + '）—');
    persist();
  });

  persist();
  return { ok: true, pid: state.pid };
}

/**
 * 多窗口模式：按数量拉起 N 个独立窗口（各自 profile / 端口 9300+i），
 * 每个窗口一个 autopilot。已存账号优先自动登录，不足的补手动登录槽。
 */
async function startMulti(opts) {
  if (child) {
    return { ok: false, error: '已经在跑了，先停止' };
  }
  const ver = readVersion();
  const n = Math.max(2, Math.min(Math.round(Number(opts.count) || 2), ver.maxSlots));
  const args = [path.join(DIR, 'multi.js'), '--count', String(n), '--manual', '--max-slots', String(ver.maxSlots)];
  const max = parseInt(opts.maxChapters, 10);
  if (max > 0) args.push('--max-chapters', String(max));

  // 每行一个账号：{phone, pass, course}。Windows 命令行传中文会乱码，统一写文件。
  const slots = (Array.isArray(opts.slots) ? opts.slots : []).slice(0, n).map((s) => ({
    phone: String((s && s.phone) || '').replace(/\s/g, ''),
    pass: String((s && s.pass) || ''),
    course: String((s && s.course) || '').trim(),
  }));
  try {
    require('fs').writeFileSync(
      require('path').join(DIR, 'start-opts.json'),
      JSON.stringify({
        slots, maxChapters: max || 0, count: n,
        multi: true, version: ver.version,
      }, null, 2),
      'utf8'
    );
  } catch (e) {}

  const named = slots.filter((s) => s.phone).length;
  state.phase = 'starting';
  state.note = '正在打开 ' + n + ' 个窗口（' + named + ' 个已填号码）…';
  state.course = slots.length ? String(slots[0].course || '') : '';
  state.chapter = '';
  state.percent = 0;
  state.account = '（多窗口 ' + n + ' 个）';
  state.count = n;
  state.multi = true;
  exitCode = null;
  lastError = '';
  startedAt = Date.now();
  state.startedAt = startedAt;

  push('— 多窗口模式：将打开 ' + n + ' 个独立浏览器窗口（端口 9300~' + (9300 + n - 1) + '）—');
  slots.forEach((s, i) => {
    push('— 账号 ' + (i + 1) + '：' + (s.phone || '未填号码') + ' / ' + (s.course || '全部课程') + ' —');
  });

  child = spawn(NODE, args, {
    cwd: DIR,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { FORCE_COLOR: '0' }),
  });
  state.running = true;
  state.pid = child.pid;

  const onData = (buf) => {
    // absorb() 内部已经 push 过一次，这里不能再 push，否则每条日志都会重复
    String(buf).split('\n').forEach((l) => { absorb(l); });
  };
  child.stdout.on('data', (b) => onData(b));
  child.stderr.on('data', (b) => onData(b));

  child.on('exit', (code) => {
    exitCode = code;
    child = null;
    state.running = false;
    state.pid = 0;
    state.multi = false;
    if (stopping) {
      stopping = false;
      state.phase = 'idle';
      state.note = '已停止';
    } else {
      state.phase = code === 0 ? 'done' : 'error';
      state.note = code === 0 ? '多窗口任务结束' : ('多窗口退出，代码 ' + code);
    }
    push('— 多窗口调度器已退出（代码 ' + code + '）—');
    persist();
  });

  persist();
  return { ok: true, pid: state.pid, count: n };
}

function stopAutopilot() {  if (!child) {
    state.running = false;
    state.phase = state.phase === 'done' ? 'done' : 'idle';
    persist();
    return { ok: true, note: '本来就没在跑' };
  }
  const pid = child.pid;
  stopping = true;
  push('— 收到停止指令，结束进程树 ' + pid + ' —');
  try {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (e) => {
      if (e) push('结束进程失败：' + e.message, 'err');
    });
  } catch (e) {
    try { child.kill('SIGKILL'); } catch (_) { }
  }
  state.phase = 'idle';
  state.note = '已停止';
  persist();
  return { ok: true };
}

// 只打开学习通（不刷课）
function openChaoxing() {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const prof = path.join(DIR, 'cdp-profile');
  try {
    spawn(edge, [
      '--user-data-dir=' + prof,
      '--remote-debugging-port=9222',
      '--enable-unsafe-extension-debugging',
      '--no-first-run', '--no-default-browser-check',
      '--window-size=1440,900',
      'https://mooc1.chaoxing.com/visit/interaction',
    ], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 读当前生效的版本（由 switch-version.js 写） */
function readVersion() {
  try {
    const j = JSON.parse(require('fs').readFileSync(require('path').join(DIR, 'version.json'), 'utf8').replace(/^\uFEFF/, ''));
    return { version: j.version || 'c', maxSlots: Math.max(1, Math.min(Number(j.maxSlots) || 6, 6)), title: j.title || '' };
  } catch (e) {
    return { version: 'c', maxSlots: 6, title: 'C 版 · 一机六号' };
  }
}

function readBody(req) {  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 65536) { d = ''; req.destroy(); } });
    req.on('end', () => {
      try { resolve(JSON.parse(d || '{}')); } catch (_) { resolve({}); }
    });
    // destroy() 之后不会触发 end，只有 close；这里兜底，避免 async handler 永远 pending
    req.on('error', () => resolve({}));
    req.on('close', () => resolve({}));
  });
}

/**
 * 把账号密码写进某个目录的 DPAPI 保险箱（每个窗口一份，避免串号）。
 * 密码走 stdin，不进程命令行。返回 {ok, out}。
 */
function saveCred(dirPath, user, pass) {
  try {
    const r = require('child_process').spawnSync(
      NODE,
      [require('path').join(DIR, 'save-cred.js'), dirPath, String(user)],
      { input: String(pass), encoding: 'utf8', windowsHide: true, timeout: 30000 }
    );
    const out = String(r.stdout || '') + String(r.stderr || '');
    return { ok: r.status === 0, out: out.trim() };
  } catch (e) {
    return { ok: false, out: e.message };
  }
}

function json(res, code, obj) {  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  if (p === '/ping') return json(res, 200, { ok: true, version: 1 });

  if (p === '/status') {
    return json(res, 200, Object.assign({}, state, {
      running: !!child, pid: child ? child.pid : 0, exitCode, lastError,
      logTail: lines.slice(-8).map((x) => x.t + ' ' + x.m),
    }));
  }

  if (p === '/log') {
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    return json(res, 200, { ok: true, lines: lines.filter((x) => x.n > since), last: seq });
  }

  if (p === '/start' && req.method === 'POST') {
    const body = await readBody(req);
    const ver = readVersion();
    let count = parseInt(body.count, 10) || 1;
    // 版本上限优先：A 版锁死 1 个窗口，B 版 3 个，C 版 6 个
    if (count > ver.maxSlots) {
      push('— 当前是 ' + String(ver.version || 'c').toUpperCase() + ' 版，最多 ' + ver.maxSlots + ' 个窗口，已自动收敛 —');
      count = ver.maxSlots;
    }
    if (count < 1) count = 1;
    const slots = (Array.isArray(body.slots) ? body.slots : []).slice(0, count).map((s) => ({
      phone: String((s && s.phone) || '').replace(/\s/g, ''),
      pass: String((s && s.pass) || ''),
      course: String((s && s.course) || '').trim(),
    }));
    // 手动登录模式：不再保存任何账号密码。点「开始」= 清除存档 → 跳登录页 → 用户手动输入。
    try { require('./vault').clear(); } catch (e) { }
    if (count >= 2) {
      push('— ' + String(ver.version || 'c').toUpperCase() + ' 版：将打开 ' + count + ' 个独立浏览器 —');
      const r = await startMulti({ slots, maxChapters: body.maxChapters, count });
      // 「已经在跑了」不是错误，返回 200 + ok:false，避免客户端看到 500
      return json(res, 200, r);
    }
    const one = slots[0] || { phone: '', pass: '', course: '' };
    const autoFill = !!(one.phone && one.pass);
    if (autoFill) {
      const sc = saveCred(DIR, one.phone, one.pass);
      push('— 已把 ' + one.phone + ' 的密码写进本机保险箱' + (sc.ok ? '（' + sc.out + '）' : '失败：' + sc.out) + ' —');
      if (!sc.ok) return json(res, 500, { ok: false, error: '保存密码失败：' + sc.out });
    } else {
      push('— 未填号码/密码，走手动登录：浏览器会跳到登录页，请手动输入 —');
    }
    state.count = 1;
    state.multi = false;
    const r = await startAutopilot({
      course: one.course, maxChapters: body.maxChapters,
      manual: !autoFill, user: autoFill ? one.phone : '', phone: one.phone,
    });
    return json(res, r.ok ? 200 : 500, r);
  }

  if (p === '/version') {
    const v = readVersion();
    return json(res, 200, { ok: true, version: v.version || 'c', maxSlots: v.maxSlots || 6, title: v.title || '' });
  }

  if (p === '/accounts') {
    let data = { parallel: 2, accounts: [] };
    try {
      data = JSON.parse(require('fs').readFileSync(require('path').join(DIR, 'accounts.json'), 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {}
    const list = Array.isArray(data.accounts) ? data.accounts.filter((a) => a && a.user && a.enabled !== false) : [];
    return json(res, 200, { ok: true, parallel: data.parallel || 2, accounts: list.map((a) => String(a.user)) });
  }

  if (p === '/stop' && req.method === 'POST') {
    // 记录是谁调用的，方便定位「莫名其妙被停」
    try { push('— /stop 来自 ' + (req.socket.remoteAddress || '?') + ' UA=' + String(req.headers['user-agent'] || '').slice(0, 40) + ' —'); } catch (e) {}
    return json(res, 200, stopAutopilot());
  }

  if (p === '/open' && req.method === 'POST') {
    return json(res, 200, openChaoxing());
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  const msg = 'xxt-bridge 已启动：http://127.0.0.1:' + PORT;
  console.log(msg);
  push(msg);
  persist();
});

process.on('SIGINT', () => { try { server.close(); } catch (_) { } process.exit(0); });
