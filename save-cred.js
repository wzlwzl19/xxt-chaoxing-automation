/**
 * 把账号密码写进指定目录的 DPAPI 保险箱。
 *
 * 为什么要单独一个进程：vault.js 在 require 时就把 DIR 定死了（按 XXT_VAULT_DIR 环境变量），
 * 同一个进程里没法给不同窗口写不同目录。所以每个窗口起一个短命进程来写。
 *
 * 密码走 stdin，不进命令行（避免出现在系统进程列表里）。
 * 用法：node save-cred.js <profileDir> <phone>  （密码从 stdin 读）
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const user = process.argv[3];

if (!dir || !user) {
  console.error('用法：node save-cred.js <profileDir> <phone>（密码从 stdin 读）');
  process.exit(2);
}

let pass = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { pass += c; });
process.stdin.on('end', () => {
  pass = pass.replace(/\r?\n$/, '');
  if (!pass) { console.error('密码为空'); process.exit(2); }
  process.env.XXT_VAULT_DIR = path.resolve(dir);
  const vault = require('./vault');
  try {
    vault.save(user, pass);
    const back = vault.load();
    if (!back || back.user !== user || back.pass !== pass) {
      console.error('回读校验失败');
      process.exit(3);
    }
    console.log('OK ' + dir + ' ' + user + ' 密码' + pass.length + '位');
    process.exit(0);
  } catch (e) {
    console.error('保存失败：' + e.message);
    process.exit(1);
  }
});
