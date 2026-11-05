// binding.js —— 窗口 ↔ 账号 绑定，防止"刷串号"
//
// 串号的根因（都已实测踩过）：
//   1. 学习通的登录态就是 cookie，同一 profile 里登第二个号必然顶掉第一个；
//   2. 全局只有一份 creds.dpapi / account.txt，多窗口互相覆盖；
//   3. 面板/桥接只有单份 state.account，A 窗口的日志会显示到 B 窗口上。
// 解法是三层，缺一层都会串：
//   ① 物理隔离：一窗口一 profile（cookie / localStorage / 缓存全分开）；
//   ② 身份绑定：窗口首次登录成功后把 user→uid 写死进 binding.json，
//      之后每次进窗口先校验，uid 对不上就停，绝不用别人的会话继续刷；
//   ③ 状态隔离：每个 profile 自带 vault 目录，桥接按 slot 分别记状态。
const fs = require('fs');
const path = require('path');

const FILE = 'binding.json';

function fileOf(profileDir) {
  return path.join(profileDir, FILE);
}

function read(profileDir) {
  try {
    return JSON.parse(fs.readFileSync(fileOf(profileDir), 'utf8').replace(/^\uFEFF/, '')) || null;
  } catch (e) {
    return null;
  }
}

function write(profileDir, obj) {
  try {
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    const next = Object.assign({}, read(profileDir) || {}, obj, { at: Date.now() });
    fs.writeFileSync(fileOf(profileDir), JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) {
    return null;
  }
}

/**
 * 启动前检查：这个窗口是不是已经被别的号码占用了。
 * 返回 { ok, bound, reason }
 *   ok=false 时调用方必须拒绝启动（不能"先跑起来再说"）
 */
function checkBeforeStart(profileDir, slot, user) {
  const b = read(profileDir);
  const u = String(user || '').trim();
  if (!b) {
    write(profileDir, { slot: slot, user: u, uid: '', createdAt: Date.now() });
    return { ok: true, bound: null };
  }
  if (b.slot && slot && Number(b.slot) !== Number(slot)) {
    return {
      ok: false, bound: b,
      reason: '窗口 slot' + slot + ' 指向的 profile 上次是 slot' + b.slot + ' 用的，目录被换过，先清空该目录再来',
    };
  }
  if (b.user && u && String(b.user) !== u) {
    // 换号是正常需求（用户把某一行改成另一个号），不能因此把整个窗口吞掉。
    // 返回 changed=true，由调用方清空该 profile 的登录态（cookie + 保险箱）后重新绑定，
    // 这样既不会串号，也不会出现「填了 3 个号只开出 2 个窗口」。
    return { ok: true, changed: true, bound: b, prevUser: b.user };
  }
  if (!b.user && u) write(profileDir, { slot: slot, user: u });
  return { ok: true, bound: b };
}

/**
 * 登录成功后核对：浏览器里这个会话到底是谁。
 * 第一次登录：把 uid 记下来，作为这个窗口的唯一身份。
 * 之后每次：uid 必须与记录一致，否则说明会话被别人顶了。
 */
function checkAfterLogin(profileDir, uid, user) {
  const b = read(profileDir) || {};
  const cur = String(uid || '').trim();
  if (!cur) {
    return { ok: false, reason: '登录后拿不到 uid，无法确认身份，停止以免串号' };
  }
  if (b.uid && String(b.uid) !== cur) {
    return {
      ok: false, bound: b,
      reason: '会话串号：本窗口绑定 uid=' + b.uid + '（' + (b.user || '?') + '），当前浏览器里是 uid=' + cur + '；已停止',
    };
  }
  const next = write(profileDir, {
    uid: cur,
    user: b.user || String(user || '').trim() || '',
    lastLoginAt: Date.now(),
  });
  return { ok: true, bound: next };
}

function reset(profileDir) {
  try { fs.unlinkSync(fileOf(profileDir)); } catch (e) { }
  return true;
}

function describe(profileDir) {
  const b = read(profileDir);
  if (!b) return '未绑定';
  return 'slot' + (b.slot || '?') + ' · ' + (b.user || '未指定号码') + (b.uid ? ' · uid=' + b.uid : ' · 未登录过');
}

module.exports = { checkBeforeStart, checkAfterLogin, read, write, reset, describe, FILE };
