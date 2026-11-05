// vault.js —— 账号密码本地加密存储（Windows DPAPI，绑定当前用户+本机）
// 明文不落盘：写临时文件 → DPAPI 加密 → 立即删除临时文件
// 用 ProtectedData 直接加密字节，避开 ConvertFrom-SecureString 的格式坑
// （5.1 下 Set-Content 会追加 CRLF，读回来 ConvertTo-SecureString 直接报 "not in a correct format"）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 存储目录：
//   单账号模式 = 本文件所在目录（老行为不变）；
//   多账号模式 = 由调度器通过 XXT_VAULT_DIR 指定到各自的 profile 目录。
// 这一步是多账号不串号的关键之一：两个窗口绝不能共用同一份 creds.dpapi，
// 否则后登录的会覆盖前一个，autopilot 重启后就会拿错密码去登。
const DIR = process.env.XXT_VAULT_DIR
  ? path.resolve(process.env.XXT_VAULT_DIR)
  : __dirname;
try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); } catch (e) { }
const BIN = path.join(DIR, 'creds.dpapi');   // DPAPI 密文字节
const LEGACY = path.join(DIR, 'creds.sec');  // 老格式，仅作兼容探测
const ACC = path.join(DIR, 'account.txt');
const META = path.join(DIR, 'account-meta.json');
const PS = 'powershell.exe';

function run(cmd) {
  const out = execFileSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
    stdio: 'pipe', windowsHide: true, timeout: 30000, encoding: 'utf8',
  });
  return String(out || '');
}

function save(user, pass) {
  const tmp = path.join(DIR, '.cred.tmp');
  fs.writeFileSync(tmp, String(pass), 'utf8');
  try {
    run([
      'Add-Type -AssemblyName System.Security',
      `$b=[IO.File]::ReadAllBytes('${tmp}')`,
      `$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser')`,
      `[IO.File]::WriteAllBytes('${BIN}',$e)`,
    ].join('; '));
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { }
  }
  fs.writeFileSync(ACC, String(user), 'utf8');
  return true;
}

function load() {
  let user = '';
  try { user = fs.readFileSync(ACC, 'utf8').trim(); } catch (e) { }
  if (!user || !fs.existsSync(BIN)) return null;
  const out = path.join(DIR, '.cred.out');
  try {
    run([
      'Add-Type -AssemblyName System.Security',
      `$e=[IO.File]::ReadAllBytes('${BIN}')`,
      `$b=[Security.Cryptography.ProtectedData]::Unprotect($e,$null,'CurrentUser')`,
      `[IO.File]::WriteAllBytes('${out}',$b)`,
    ].join('; '));
    const pass = fs.readFileSync(out, 'utf8');
    return pass ? { user, pass } : null;
  } catch (e) {
    return null;
  } finally {
    try { fs.unlinkSync(out); } catch (e) { }
  }
}

// 账号指纹（不含密码）：记录上次真正登录成功的是哪个账号、服务端 uid 是多少
// 用途：切换账号时能立刻发现"浏览器里还挂着上一个人的会话"
function getMeta() {
  try {
    return JSON.parse(fs.readFileSync(META, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch (e) {
    return {};
  }
}

function setMeta(obj) {
  try {
    const next = Object.assign({}, getMeta(), obj, { at: Date.now() });
    fs.writeFileSync(META, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) {
    return null;
  }
}

function clear() {
  for (const f of [BIN, LEGACY, ACC, META]) { try { fs.unlinkSync(f); } catch (e) { } }
  return true;
}

module.exports = {
  save, load, getMeta, setMeta, clear,
  exists: () => fs.existsSync(BIN) && fs.existsSync(ACC),
  file: BIN,
  metaFile: META,
};
