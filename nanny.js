// —— 授权闸门（失败即退出，不可绕过）——
require('./license').guard();
// —— 授权闸门结束 ——
// nanny.js —— 睡眠守护：自动检测异常并自动修复
// 职责：防休眠、防窗口隐藏、恢复暂停、重启停止的脚本、记录一切
const { Browser, sleep } = require('./cdpkit');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const DIR = __dirname;
const LOG = path.join(DIR, 'nanny.log');

// —— 真正的 node.exe（DSH 里 process.execPath 是 DeepSeek Harness.exe，不能拿去 spawn 脚本）——
const NODE = (function () {
  const cands = [process.env.XXT_NODE, 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe'];
  for (const c of cands) { if (c && /node(\.exe)?$/i.test(c) && fs.existsSync(c)) return c; }
  if (/node(\.exe)?$/i.test(process.execPath)) return process.execPath;
  return 'node';
})();

// —— autopilot 是否还活着（它启动时会写 autopilot.pid，退出时删除）——
function isAutopilotRunning() {
  try {
    const pid = parseInt(String(fs.readFileSync(path.join(DIR, 'autopilot.pid'), 'utf8')).trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) { return false; }
}

// —— 是否落在夜间静默时段（读 config.json 的 nightQuiet，支持跨零点）——
function inQuietHours() {
  try {
    const c = JSON.parse(String(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')).replace(/^\uFEFF/, ''));
    const q = c.nightQuiet;
    if (!q || !q.enabled || !q.start || !q.end) return false;
    const hm = new Date().toTimeString().slice(0, 5);
    return q.start <= q.end ? (hm >= q.start && hm < q.end) : (hm >= q.start || hm < q.end);
  } catch (e) { return false; }
}

// —— 桥是否已在管一个任务（桥有 child 时它自己会拉起/结束 autopilot，nanny 别再插一脚）——
function bridgeRunning() {
  return new Promise((resolve) => {
    try {
      const http = require('http');
      const req = http.get({ host: '127.0.0.1', port: 9333, path: '/status', timeout: 1500 }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d).running === true); } catch (e) { resolve(false); }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch (e) { resolve(false); }
  });
}
// —— 重新拉起 autopilot（2x 由 config.json 控制，走手动登录模式沿用当前会话）——
function spawnAutopilot(course) {
  try {
    const out = fs.openSync(path.join(DIR, 'ap-nanny.log'), 'a');
    const args = ['autopilot.js', '--manual-login', '--course', course || '军事理论'];
    const ch = spawn(NODE, args, { cwd: DIR, detached: true, stdio: ['ignore', out, out], windowsHide: true });
    ch.unref();
    return ch.pid;
  } catch (e) { return 0; }
}

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  try { console.log(line); } catch (e) {}
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

// —— 防止系统休眠（不强制屏幕常亮）——
function keepAwake() {
  const ps = [
    `Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name K -Namespace W | Out-Null`,
    `[W.K]::SetThreadExecutionState(0x80000001) | Out-Null`,
    `while($true){ Start-Sleep -Seconds 30; [W.K]::SetThreadExecutionState(0x80000001) | Out-Null }`
  ].join('\n');
  try {
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    log('已启动防休眠守护（ES_SYSTEM_REQUIRED）');
  } catch (e) { log('防休眠启动失败：' + e.message); }
}

// —— 激活 Edge 窗口到前台 ——
function activateEdge() {
  const ps = [
    `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);' -Name U -Namespace W | Out-Null`,
    `Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object { [W.U]::ShowWindow($_.MainWindowHandle, 9) | Out-Null; [W.U]::SetForegroundWindow($_.MainWindowHandle) | Out-Null }`
  ].join('\n');
  try { execFileSync('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, timeout: 15000 }); } catch (e) {}
}

// —— 重启 Edge（带调试端口，沿用同一 profile 以保留 cookie）——
function restartEdge() {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const prof = path.join(DIR, 'cdp-profile');
  const args = [
    `--user-data-dir=${prof}`,
    '--remote-debugging-port=9222',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    'about:blank'
  ];
  try {
    spawn(edge, args, { detached: true, stdio: 'ignore' }).unref();
    log('已尝试重启 Edge（--user-data-dir=cdp-profile --remote-debugging-port=9222）');
  } catch (e) {
    log('重启 Edge 失败：' + e.message);
  }
}

// —— 页面探测（主文档 + 递归 iframe 视频 + 面板日志）——
const PROBE = `(() => {
  const walk = (doc, d) => {
    if (!doc || d > 5) return [];
    let out = [];
    try { doc.querySelectorAll('video').forEach(v => out.push({ p: v.paused, ct: v.currentTime | 0, d: v.duration | 0, e: v.ended })); } catch (e) {}
    let fs = [];
    try { fs = doc.querySelectorAll('iframe'); } catch (e) {}
    for (const f of fs) { try { const x = f.contentDocument; if (x) out = out.concat(walk(x, d + 1)); } catch (e) {} }
    return out;
  };
  let panel = '';
  const h = document.getElementById('xt-ds-host');
  if (h && h.shadowRoot) { const lg = h.shadowRoot.querySelector('#log'); if (lg) panel = lg.innerText.slice(-600); }
  return JSON.stringify({ vis: document.visibilityState, focus: document.hasFocus(), vids: walk(document, 0), panel, url: location.href });
})()`;

// —— 点面板按钮 ——
async function clickPanel(s, text) {
  const expr = `(() => {
    const h = document.getElementById('xt-ds-host');
    if (!h || !h.shadowRoot) return 'NO_PANEL';
    const b = [...h.shadowRoot.querySelectorAll('button')].find(x => x.innerText.trim() === ${JSON.stringify(text)});
    if (!b) return 'NO_BTN';
    b.click();
    return 'OK';
  })()`;
  try { return await s.eval(expr, {}, 8000); } catch (e) { return 'ERR ' + e.message; }
}

// —— 强制 video.play()（递归 iframe）——
const FORCE_PLAY = `(() => {
  const walk = (doc, d) => {
    let n = 0;
    try { doc.querySelectorAll('video').forEach(v => { if (v.paused) { const r = v.play(); if (r && r.catch) r.catch(() => {}); n++; } }); } catch (e) {}
    let fs = [];
    try { fs = doc.querySelectorAll('iframe'); } catch (e) {}
    for (const f of fs) { try { const x = f.contentDocument; if (x) n += walk(x, d + 1); } catch (e) {} }
    return n;
  };
  return walk(document, 0);
})()`;

(async () => {
  keepAwake();
  log('===== nanny 启动（自动检测 + 自动修复）=====');
  let b = null;
  let stuckPaused = 0, stuckNoVideo = 0, stoppedSeen = 0;
  let lastCt = -1, lastCtChange = Date.now(), savedShown = false;
  let lastCourseUrl = '';
  let lastActivate = 0;
  let lastSpawn = Date.now();

  for (;;) {
    // ---- 0. 保活：autopilot 退出（跑满 120 分钟会正常收工）就重新拉起；
    //        夜间静默时段内不拉，让它真的停着睡觉 ----
    if (Date.now() - lastSpawn > 60000) {
      const managedByBridge = await bridgeRunning();
      if (managedByBridge) {
        lastSpawn = Date.now(); // 桥在管，nanny 只做看护不动手
      } else if (!isAutopilotRunning() && !runLockHeld(9222)) {
        if (inQuietHours()) {
          log('autopilot 不在运行，当前处于夜间静默时段 → 保持停止');
          lastSpawn = Date.now(); // 60s 后再看一次
        } else {
          const pid = spawnAutopilot();
          log('autopilot 不在运行 → 重新拉起，pid=' + pid);
          lastSpawn = Date.now();
        }
      } else {
        lastSpawn = Date.now();
      }
    }
    try {
      if (!b) b = await new Browser(9222).connect();

      // 页面不在 studentstudy 就去找，找不到就等
      let s = null;
      try { s = await b.attachPage(p => (p.url || '').indexOf('studentstudy') > -1); } catch (e) {
        log('attach 失败：' + e.message);
        b = null; await sleep(15000); continue;
      }
      if (!s) {
        // attachPage 找不到匹配页面时返回 null（跳节/导航瞬间），等下一轮再试
        log('当前没有 studentstudy 页面（可能在跳节），等下一轮');
        await sleep(12000); continue;
      }

      await s.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      const raw = await s.eval(PROBE, {}, 20000).catch(e => 'ERR ' + e.message);
      if (typeof raw !== 'string' || raw.indexOf('ERR') === 0) {
        log('探测失败：' + raw);
        b = null; await sleep(15000); continue;
      }
      const o = JSON.parse(raw);
      if (o.url && o.url.indexOf('studentstudy') > -1) lastCourseUrl = o.url;
      const v = (o.vids || []).find(x => x.d > 0) || (o.vids || [])[0];

      // ---- 1. 页面不可见 → 激活窗口（节流：最多 1 分钟抢一次焦点，别把用户鼠标抢走）----
      if (o.vis === 'hidden' && Date.now() - lastActivate > 60000) {
        lastActivate = Date.now();
        log('页面不可见（hidden）→ 激活 Edge 窗口');
        activateEdge();
        await sleep(3000);
        continue;
      }

      // ---- 2. 安全检查：出现验证码/滑块 → 记录并停手 ----
      const pl = (o.panel || '').replace(/\s+/g, ' ');
      if (/验证码|滑块|拖动验证|拖拽/.test(pl.slice(-300))) {
        log('!!! 检测到验证码/滑块 —— 按安全策略暂停自动操作，等待人工处理');
        await clickPanel(s, '停止');
        await sleep(60000);
        continue;
      }

      // ---- 3. 视频状态修复 ----
      if (!v) {
        stuckNoVideo++;
        log(`无视频元素（连续 ${stuckNoVideo} 次）`);
        if (stuckNoVideo >= 3) {
          log('修复：点「开始」重试');
          const r = await clickPanel(s, '开始');
          log('  clickPanel(开始) -> ' + r);
          stuckNoVideo = 0;
        }
      } else if (v.e) {
        stuckPaused = 0;
        stuckNoVideo = 0;
        log(`视频已播完 ${v.ct}s/${v.d}s，等待脚本进入测验/跳节`);
      } else if (v.p) {
        stuckPaused++;
        stuckNoVideo = 0;
        log(`视频暂停 ${v.ct}s/${v.d}s（第 ${stuckPaused} 次）`);
        if (stuckPaused >= 2) {
          const n = await s.eval(FORCE_PLAY, {}, 8000).catch(() => -1);
          log('  修复：强制 play()，触发 ' + n + ' 个 video');
          if (stuckPaused >= 4) {
            const r = await clickPanel(s, '开始');
            log('  修复：点「开始」-> ' + r);
            await sleep(2000);
            const n2 = await s.eval(FORCE_PLAY, {}, 8000).catch(() => -1);
            log('  再次 play()，触发 ' + n2);
            stuckPaused = 0;
          }
        }
      } else {
        stuckPaused = 0;
        stuckNoVideo = 0;
        if (v.ct !== lastCt) { lastCt = v.ct; lastCtChange = Date.now(); savedShown = false; }
        const idle = (Date.now() - lastCtChange) / 1000;
        if (idle > 240 && !savedShown) {
          log(`进度 ${idle.toFixed(0)}s 未变（${v.ct}s/${v.d}s），尝试「下一节」`);
          const r = await clickPanel(s, '下一节');
          log('  clickPanel(下一节) -> ' + r);
          lastCtChange = Date.now(); savedShown = true;
        }
      }

      // ---- 4. 脚本被停止 → 重点开始（只在日志末尾是「自动化已停止」时判定，避免读到历史记录误判）----
      if (pl.trim().endsWith('自动化已停止')) {
        stoppedSeen++;
        log(`检测到「自动化已停止」在日志末尾（第 ${stoppedSeen} 次）`);
        if (stoppedSeen >= 2) {
          const r = await clickPanel(s, '开始');
          log('  修复：点「开始」-> ' + r);
          stoppedSeen = 0;
        }
      } else {
        stoppedSeen = 0;
      }

      log(`状态：vis=${o.vis} ${v ? `${v.ct}s/${v.d}s ${v.p ? '暂停' : (v.e ? '完成' : '播放中')}` : '无视频'}`);
    } catch (e) {
      log('异常：' + e.message);
      b = null;
      if (/ECONNREFUSED/.test(e.message)) {
        log('浏览器调试端口不可用 → 自动重启 Edge 并恢复课程页');
        log('浏览器不在（由 autopilot/bridge 负责重开，nanny 不再抢着重启以免丢登录态）');
        await sleep(15000);
        // 重启后尽力恢复课程页（登录态若幸存即可继续）
        try {
          b = await new Browser(9222).connect();
          if (lastCourseUrl) {
            await b.newPage(lastCourseUrl);
            log('已恢复课程页：' + lastCourseUrl.slice(0, 90));
          }
        } catch (e2) {
          log('重启后仍连不上：' + e2.message);
          b = null;
          await sleep(15000);
        }
      }
    }
    await sleep(20000);
  }
})().catch(e => { log('FATAL ' + e.message); });
