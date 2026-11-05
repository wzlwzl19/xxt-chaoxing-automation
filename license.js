'use strict';
/**
 * 授权校验（客户机运行）
 * - 机器码绑定 + Ed25519 签名 + 版本白名单 + 到期日
 * - 任何一项不通过，进程直接退出
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAw8+3zDziJ9hbUU5zTk3yIFhO1XgJJMO8wPdl7qHuYKI=
-----END PUBLIC KEY-----`;

const DIR = __dirname;
const LICENSE_FILE = path.join(DIR, 'license.key');

let _mid = null;

/** 机器码：CPU + 主板 + 系统盘序列号 → SHA256 前 16 位（4-4-4-4） */
function machineId() {
  if (_mid) return _mid;
  const parts = [];
  const ps = (cmd) => {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', cmd], {
        encoding: 'utf8', timeout: 15000, windowsHide: true,
      });
      return String(out || '').trim();
    } catch (e) { return ''; }
  };
  const probe = [
    ['cpu', '(Get-CimInstance Win32_Processor | Select-Object -First 1).ProcessorId'],
    ['board', '(Get-CimInstance Win32_BaseBoard | Select-Object -First 1).SerialNumber'],
    ['disk', '(Get-CimInstance Win32_DiskDrive | Where-Object { $_.Index -eq 0 } | Select-Object -First 1).SerialNumber'],
  ];
  for (const [k, cmd] of probe) {
    const v = ps(cmd);
    if (v && v.toLowerCase() !== 'to be filled by o.e.m.') parts.push(k + '=' + v);
  }
  if (!parts.length) parts.push('host=' + os.hostname() + '|user=' + (os.userInfo().username || ''));
  const h = crypto.createHash('sha256').update(parts.join('|').toUpperCase()).digest('hex').toUpperCase();
  _mid = (h.slice(0, 4) + '-' + h.slice(4, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16));
  return _mid;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64');
}

/** 读取并校验授权文件 */
function verify(plan) {
  const want = String(plan || '').toLowerCase();
  if (!fs.existsSync(LICENSE_FILE)) {
    return { ok: false, reason: 'missing', message: '未找到授权文件 license.key' };
  }
  let raw = '';
  try { raw = fs.readFileSync(LICENSE_FILE, 'utf8').replace(/^\uFEFF/, '').trim(); } catch (e) {
    return { ok: false, reason: 'io', message: '授权文件读不出来：' + e.message };
  }
  const m = raw.match(/^([A-Za-z0-9\-_]+)\.([A-Za-z0-9\-_]+)$/);
  if (!m) return { ok: false, reason: 'format', message: '授权文件格式不对（应为一串 payload.signature）' };

  const payloadBuf = unb64url(m[1]);
  const sig = unb64url(m[2]);
  let payload;
  try { payload = JSON.parse(payloadBuf.toString('utf8')); } catch (e) {
    return { ok: false, reason: 'format', message: '授权内容解析失败' };
  }
  let sigOk = false;
  try {
    sigOk = crypto.verify(null, payloadBuf, crypto.createPublicKey(PUBLIC_KEY_PEM), sig);
  } catch (e) { sigOk = false; }
  if (!sigOk) return { ok: false, reason: 'signature', message: '授权签名无效（文件被改过或不是我们签发的）' };

  const mid = machineId();
  const allow = String(payload.mid || '').toUpperCase();
  if (allow !== '*' && allow !== mid) {
    return {
      ok: false, reason: 'machine',
      message: '授权与本机不匹配。本机机器码 ' + mid + '，授权绑定 ' + allow,
      mid,
    };
  }
  const plans = String(payload.plan || '').toLowerCase();
  const allowed = plans === 'abc' || plans.split(',').map(s => s.trim()).indexOf(want) >= 0;
  if (!allowed) {
    return { ok: false, reason: 'plan', message: '该授权不含 ' + want.toUpperCase() + ' 版（授权版本：' + (payload.plan || '-') + '）', mid };
  }
  if (payload.exp && payload.exp !== 'never') {
    const exp = new Date(payload.exp + 'T23:59:59');
    if (isNaN(exp.getTime())) return { ok: false, reason: 'exp', message: '授权到期日格式不对：' + payload.exp, mid };
    if (Date.now() > exp.getTime()) {
      return { ok: false, reason: 'expired', message: '授权已于 ' + payload.exp + ' 到期', mid };
    }
  }
  return { ok: true, payload, mid, message: '授权有效（' + (payload.client || '未署名') + '）' };
}

function box(lines) {
  const w = Math.max.apply(null, lines.map(s => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
  const bar = '='.repeat(w + 4);
  console.log('\n' + bar);
  for (const s of lines) {
    const pad = w - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
    console.log('  ' + s + ' '.repeat(Math.max(0, pad)));
  }
  console.log(bar + '\n');
}

/** 启动闸门：校验失败直接退出 */
function guard(plan) {
  // 开源构建 / 开发模式：没有 plan.json 说明不是商业发布包，直接放行
  const planFile = path.join(DIR, 'plan.json');
  if (!plan && !fs.existsSync(planFile)) {
    if (process.env.XXT_DEV !== '0') {
      try { console.log('[license] 开发模式（无 plan.json），跳过授权校验'); } catch (e) {}
      return { ok: true, dev: true, plan: 'dev' };
    }
  }
  if (!plan) {
    try { plan = JSON.parse(fs.readFileSync(planFile, 'utf8').replace(/^\uFEFF/, '')).plan; } catch (e) { plan = 'a'; }
  }
  const r = verify(plan);
  if (r.ok) return r;
  box([
    '授权校验未通过 —— 程序已停止',
    '',
    '原因：' + r.message,
    r.mid ? ('本机机器码：' + r.mid) : ('本机机器码：' + machineId()),
    '',
    '请联系供应商，把上面这行机器码发给他换取授权文件',
    '换到 license.key 后，放到本程序目录（与启动脚本同一层）',
  ]);
  process.exit(3);
  return r;
}

module.exports = { machineId, verify, guard, LICENSE_FILE };

if (require.main === module) {
  const arg = (process.argv[2] || '').toLowerCase();
  if (arg === 'show' || !arg) {
    const mid = machineId();
    console.log('本机机器码：' + mid);
    const r = verify(arg === 'show' ? (process.argv[3] || 'a') : 'a');
    console.log('授权状态：' + (r.ok ? '有效 —— ' + r.message : '无效 —— ' + r.message));
  } else if (arg === 'check') {
    console.log(JSON.stringify(verify(process.argv[3] || 'a'), null, 2));
  }
}
