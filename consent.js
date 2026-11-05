'use strict';
/**
 * 同意闸门 CLI
 *   node consent.js            # 显示须知与当前状态
 *   node consent.js agree      # 记录同意（写入 consent.json）
 *   node consent.js revoke     # 撤回同意（删除 consent.json）
 */
const fs = require('fs');
const path = require('path');
const c = require('./compliance');

const DIR = __dirname;
const NOTICE = path.join(DIR, '使用须知.md');
const cmd = (process.argv[2] || '').toLowerCase();

function showNotice() {
  try {
    const t = fs.readFileSync(NOTICE, 'utf8');
    console.log(t.split('\n').slice(0, 60).join('\n'));
    console.log('\n（完整文本见 使用须知.md）');
  } catch (e) {
    console.log('未找到《使用须知.md》，请检查程序完整性。');
  }
}

if (cmd === 'agree') {
  const rec = { agreed: true, version: c.NOTICE_VERSION, at: new Date().toISOString(), host: require('os').hostname() };
  fs.writeFileSync(c.CONSENT_FILE, JSON.stringify(rec, null, 2), 'utf8');
  c.audit('consent-agreed', rec.at);
  console.log('已记录同意（' + c.CONSENT_FILE + '）。可以开始使用。');
  process.exit(0);
}

if (cmd === 'revoke') {
  try { fs.unlinkSync(c.CONSENT_FILE); } catch (e) { }
  c.audit('consent-revoked', '');
  console.log('已撤回同意，程序将无法启动。');
  process.exit(0);
}

showNotice();
const ok = (() => { try { return !!JSON.parse(fs.readFileSync(c.CONSENT_FILE, 'utf8')).agreed; } catch (e) { return false; } })();
console.log('\n当前状态：' + (ok ? '已同意' : '未同意（同意请输入： node consent.js agree）'));
console.log('运行模式：' + c.cfg().mode + '（严格模式不自动作答/不自动提交）');
