// setup.js —— 首次运行：录入学习通账号密码，DPAPI 加密保存（不回显、不落明文）
const readline = require('readline');
const vault = require('./vault');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(q) {
  return new Promise((res) => rl.question(q, res));
}

function askHidden(q) {
  return new Promise((res) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (ch) => {
      const s = ch.toString('utf8');
      if (s === '\r' || s === '\n' || s === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        res(buf);
        return;
      }
      if (s === '\u0003') { process.stdout.write('\n'); process.exit(1); }
      if (s === '\u007f' || s === '\b') { buf = buf.slice(0, -1); return; }
      buf += s;
      process.stdout.write('*');
    };
    stdin.on('data', onData);
  });
}

(async () => {
  console.log('');
  console.log('=== 学习通自动刷课 · 首次设置 ===');
  console.log('账号密码只会用 Windows DPAPI 加密存在本机，只有这台电脑的这个用户能解开。');
  console.log('');
  const user = (await ask('学习通手机号 / 超星号：')).trim();
  if (!user) { console.log('账号不能为空'); process.exit(1); }
  const pass = await askHidden('学习通密码（输入时不显示）：');
  if (!pass) { console.log('密码不能为空'); process.exit(1); }
  vault.save(user, pass);
  const chk = vault.load();
  if (chk && chk.user === user && chk.pass === pass) {
    console.log('');
    console.log('已保存。以后双击「启动自动刷课.cmd」就不会再问账号密码了。');
    console.log('账号：' + user + '（密码长度 ' + pass.length + ' 位，已加密存储）');
  } else {
    console.log('保存后校验失败，请重试');
    process.exit(1);
  }
  rl.close();
  process.exit(0);
})();
