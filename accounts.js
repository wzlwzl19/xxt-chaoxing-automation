/**
 * 账号管理（多账号版）
 *
 * 用法：
 *   node accounts.js add            交互添加一个账号（手机号 + 密码，密码 DPAPI 加密）
 *   node accounts.js list           看当前有哪些账号
 *   node accounts.js remove <手机号> 删掉一个账号
 *   node accounts.js login <手机号>  给这个账号打开浏览器，手动登录一次（之后 cookie 一直留着）
 *   node accounts.js parallel <n>   设置同时刷几个账号（默认 2）
 *
 * 安全说明：
 * - 密码只在本机用 Windows DPAPI（CurrentUser 作用域）加密后存进 accounts.json，
 *   换个 Windows 用户或换台机器都解不开，也没有任何网络上传。
 * - 密码不拼进 PowerShell 命令行，走临时文件中转，特殊字符不会被 shell 吃掉。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const readline = require('readline');

const DIR = __dirname;
const ACC_FILE = path.join(DIR, 'accounts.json');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILES = path.join(DIR, 'profiles');

function readJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return def; }
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
function load() {
  const d = readJSON(ACC_FILE, { parallel: 2, accounts: [] });
  if (!Array.isArray(d.accounts)) d.accounts = [];
  return d;
}
function safeName(user) {
  return String(user).replace(/[^0-9A-Za-z_@.-]/g, '_');
}

function ps(script) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
  });
}

function encryptPass(text) {
  const tmpIn = path.join(DIR, '.acc_in.tmp');
  const tmpOut = path.join(DIR, '.acc_out.enc');
  try {
    fs.writeFileSync(tmpIn, String(text), 'utf8');
    ps("Add-Type -AssemblyName System.Security;" +
       "$b=[IO.File]::ReadAllBytes('" + tmpIn + "');" +
       "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
       "[IO.File]::WriteAllBytes('" + tmpOut + "',$p)");
    const buf = fs.readFileSync(tmpOut);
    return buf.toString('base64');
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (e) {}
    try { fs.unlinkSync(tmpOut); } catch (e) {}
  }
}

function decryptPass(b64) {
  const tmpIn = path.join(DIR, '.acc_in.enc');
  const tmpOut = path.join(DIR, '.acc_out.tmp');
  try {
    fs.writeFileSync(tmpIn, Buffer.from(b64, 'base64'));
    ps("Add-Type -AssemblyName System.Security;" +
       "$b=[IO.File]::ReadAllBytes('" + tmpIn + "');" +
       "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
       "[IO.File]::WriteAllBytes('" + tmpOut + "',$p)");
    return fs.readFileSync(tmpOut, 'utf8');
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (e) {}
    try { fs.unlinkSync(tmpOut); } catch (e) {}
  }
}

function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const onData = (ch) => {
        if (ch.toString() === '\n' || ch.toString() === '\r' || ch.toString() === '\u0004') {
          process.stdin.removeListener('data', onData);
        } else {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(q + '*'.repeat(rl.line.length));
        }
      };
      rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
      process.stdin.on('data', onData);
    } else {
      rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
    }
  });
}

function cmdAdd() {
  return (async () => {
    const user = await ask('手机号/超星号：');
    if (!user) { console.log('没填手机号，取消'); return; }
    const data = load();
    if (data.accounts.some((a) => String(a.user) === user)) {
      console.log('这个账号已经在列表里了：' + user);
      return;
    }
    let pass = '';
    process.stdout.write('密码（输入不回显）：');
    pass = await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      let buf = '';
      const onData = (chunk) => {
        const s = chunk.toString();
        for (const ch of s) {
          if (ch === '\n' || ch === '\r') {
            process.stdin.removeListener('data', onData);
            process.stdout.write('\n');
            rl.close();
            resolve(buf);
            return;
          }
          if (ch === '\u007f' || ch === '\b') {
            buf = buf.slice(0, -1);
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            process.stdout.write('密码（输入不回显）：' + '*'.repeat(buf.length));
          } else if (ch >= ' ') {
            buf += ch;
            process.stdout.write('*');
          }
        }
      };
      process.stdin.on('data', onData);
    });
    if (!pass) { console.log('没填密码，取消'); return; }
    data.accounts.push({
      user,
      passEnc: encryptPass(pass),
      enabled: true,
      addedAt: new Date().toISOString(),
    });
    writeJSON(ACC_FILE, data);
    console.log('已添加：' + user + '（密码已用 Windows DPAPI 加密）');
    console.log('下一步：node accounts.js login ' + user + ' —— 打开浏览器手动登录一次');
  })();
}

function cmdList() {
  const data = load();
  if (!data.accounts.length) { console.log('还没有账号。执行 node accounts.js add'); return; }
  console.log('并行度：' + (data.parallel || 2));
  console.log('账号列表：');
  data.accounts.forEach((a, i) => {
    console.log('  #' + (i + 1) + '  ' + a.user + '  ' + (a.enabled === false ? '[已停用]' : '[启用]') +
      '  端口 ' + (9300 + i) + '  密码' + (a.passEnc ? '已存' : '未存'));
  });
}

function cmdRemove(user) {
  const data = load();
  const before = data.accounts.length;
  data.accounts = data.accounts.filter((a) => String(a.user) !== String(user));
  if (data.accounts.length === before) { console.log('没找到：' + user); return; }
  writeJSON(ACC_FILE, data);
  console.log('已删除：' + user);
}

function cmdParallel(n) {
  const data = load();
  const v = Math.max(1, Math.min(Number(n) || 2, 6));
  data.parallel = v;
  writeJSON(ACC_FILE, data);
  console.log('并行度已设为 ' + v + '（同时刷 ' + v + ' 个账号）');
}

async function cmdLogin(user) {
  const data = load();
  const idx = data.accounts.findIndex((a) => String(a.user) === String(user));
  if (idx < 0) { console.log('没找到账号：' + user); return; }
  const port = 9300 + idx;
  const profile = path.join(PROFILES, safeName(user));
  if (!fs.existsSync(profile)) fs.mkdirSync(profile, { recursive: true });

  // 端口已被占（可能已经在跑），就直接复用
  let alive = false;
  try {
    const http = require('http');
    await new Promise((res, rej) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/json/version' }, (r) => {
        r.resume(); r.on('end', () => { alive = true; res(); });
      });
      req.on('error', rej);
      req.setTimeout(2500, () => req.destroy(new Error('timeout')));
      req.end();
    });
  } catch (e) {}

  if (!alive) {
    console.log('启动浏览器（账号 ' + user + '，端口 ' + port + '）…');
    spawn(EDGE, [
      '--user-data-dir=' + profile,
      '--remote-debugging-port=' + port,
      '--no-first-run', '--no-default-browser-check',
      '--window-size=1280,800',
      '--disable-features=CalculateNativeWinOcclusion,AutofillServerCommunication,PasswordManagerOnboarding',
      'https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fmooc1.chaoxing.com%2Fvisit%2Finteraction',
    ], { detached: true, stdio: 'ignore' }).unref();
  } else {
    console.log('浏览器已在运行（端口 ' + port + '），直接打开登录页');
    const http = require('http');
    const list = await new Promise((res) => {
      http.get({ host: '127.0.0.1', port, path: '/json/list' }, (r) => {
        let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res([]); } });
      }).on('error', () => res([]));
    });
    const page = list.find((t) => t.type === 'page');
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r) => ws.onopen = r);
      ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fmooc1.chaoxing.com%2Fvisit%2Finteraction' } }));
      await new Promise((r) => setTimeout(r, 1500));
      try { ws.close(); } catch (e) {}
    }
  }

  console.log('');
  console.log('浏览器已打开，请在窗口里登录「' + user + '」。');
  console.log('登录完成后不用做别的，直接关掉这个窗口或回来告诉我 —— cookie 会一直留在这个 profile 里。');
  console.log('之后跑 node multi.js 就会自动用这个登录态开始刷课。');
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd || cmd === 'list') return cmdList();
  if (cmd === 'add') return cmdAdd();
  if (cmd === 'remove') return cmdRemove(arg);
  if (cmd === 'parallel') return cmdParallel(arg);
  if (cmd === 'login') return cmdLogin(arg);
  console.log('用法：node accounts.js [add|list|remove <手机号>|login <手机号>|parallel <n>]');
}

if (require.main === module) {
  main().catch((e) => { console.error('ERR ' + e.message); process.exitCode = 1; });
}

module.exports = { load, encryptPass, decryptPass };
