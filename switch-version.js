// switch-version.js —— 一键切换 A / B / C 三版
//
// 用法：
//   node switch-version.js a     一机一号（不开数量选择）
//   node switch-version.js b     一机三号（数量 1~3）
//   node switch-version.js c     一机六号（数量 1~6）
//   node switch-version.js       查看当前版本
//
// 切完会：
//   1) 生成/刷新三套 panel.a|b|c.js
//   2) 把选中版本写到 dsh-plugin/lib/panel.js（服务端读的那份）
//   3) 同步到 DSH profile 的 node_modules 里（刷新页面即生效）
//   4) 写 version.json，bridge 读它来限制窗口数量上限
//   5) 重启 bridge（让上限立刻生效）
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const DIR = __dirname;
const LIB = path.join(DIR, 'dsh-plugin', 'lib');
const PANEL = path.join(LIB, 'panel.js');
const VER_FILE = path.join(DIR, 'version.json');
const PROFILE_PANEL = 'C:\\Users\\wzl\\.dsh\\profiles\\desktop\\node_modules\\dsh-panel-xuexitong\\lib\\panel.js';
const NODE = (function () {
  const cands = [process.env.XXT_NODE, 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe'];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return 'node';
})();

const { VERSIONS, build } = require('./build-panels');

function readVersion() {
  try { return JSON.parse(fs.readFileSync(VER_FILE, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return { version: 'c', maxSlots: 6 }; }
}

function writeVersion(key) {
  const cfg = VERSIONS[key];
  fs.writeFileSync(VER_FILE, JSON.stringify({
    version: key, maxSlots: cfg.maxSlots, title: cfg.title, at: Date.now(),
  }, null, 2), 'utf8');
}

function restartBridge() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*xxt-bridge.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (out && out.trim()) console.log('  已停止旧 bridge');
  } catch (e) { }
  const child = spawn(NODE, [path.join(DIR, 'xxt-bridge.js')], {
    cwd: DIR, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  return true;
}

function main() {
  const key = (process.argv[2] || '').toLowerCase();
  const cur = readVersion();

  if (!key) {
    console.log('当前版本：' + (cur.version || '?').toUpperCase() + ' 版（最多 ' + (cur.maxSlots || '?') + ' 个窗口）');
    console.log('可用：a=一机一号  b=一机三号  c=一机六号');
    console.log('切换：node switch-version.js a|b|c');
    return;
  }
  if (!VERSIONS[key]) {
    console.log('未知版本「' + key + '」，只能是 a / b / c');
    process.exitCode = 1;
    return;
  }

  // 1) 三套产物全部刷新（保证任何一版都是最新模板生成的）
  Object.keys(VERSIONS).forEach((k) => build(k));

  // 2) 选中版本覆盖到服务端读的 panel.js
  const picked = build(key);
  fs.copyFileSync(picked.file, PANEL);

  // 3) 同步到 profile
  try {
    fs.mkdirSync(path.dirname(PROFILE_PANEL), { recursive: true });
    fs.copyFileSync(picked.file, PROFILE_PANEL);
  } catch (e) {
    console.log('  [!] 同步 profile 失败：' + e.message);
  }

  // 4) 写 version.json（bridge 用它限制上限）
  writeVersion(key);

  // 5) 重启 bridge
  // 不再重启 bridge：面板通过 ?v=mtime 自动刷新，重启 bridge 会连带杀掉正在跑的刷课进程
// （之前「莫名其妙退出」就是我反复发布面板时把它掐掉的）。只有 bridge 没在跑时才拉起。
(async () => {
  const alive = await new Promise((resolve) => {
    const req = require('http').get({ host: '127.0.0.1', port: 9333, path: '/ping', timeout: 2000 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
  if (!alive) { restartBridge(); console.log('  bridge 原本没在跑，已拉起'); }
  else console.log('  bridge 在跑，不重启（避免掐掉正在刷课的进程）');
})();

  console.log('[OK] 已切换到 ' + key.toUpperCase() + ' 版：' + VERSIONS[key].title);
  console.log('     窗口上限 ' + VERSIONS[key].maxSlots + ' 个，数量选择 ' +
    (VERSIONS[key].showCount ? '开启' : '关闭'));
  console.log('     刷新 DSH 页面（关掉窗口重开，或按 Ctrl+R）即可看到新面板');
}

if (require.main === module) main();
module.exports = { readVersion, writeVersion, VERSIONS };
