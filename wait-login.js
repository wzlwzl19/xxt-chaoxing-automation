// wait-login.js —— 通用登录哨兵：不管谁登录，只要登录成功（课程表拿得到）就自动开跑
// 用法：node wait-login.js                 登录成功后全量跑
//       node wait-login.js --max-chapters 1 登录成功后只跑第一节（先验证用）
//       node wait-login.js --course 军事理论 登录成功后只跑名字含该词的那门课
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Browser, sleep } = require('./cdpkit');

const DIR = __dirname;
const MAX_WAIT_MIN = 1440; // 常驻：一整天有效，你什么时候登录都行

(async () => {
  const b = await new Browser(9222).connect();
  const s = await b.newPage('https://mooc1-1.chaoxing.com/visit/interaction');
  await sleep(5000);

  const t0 = Date.now();
  let lastNote = '';
  while (Date.now() - t0 < MAX_WAIT_MIN * 60000) {
    let raw = null;
    try {
      raw = await s.eval(`(async()=>{
        try{
          const r=await fetch('https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1',{credentials:'include'});
          return await r.text();
        }catch(e){ return 'ERR|'+e.message }
      })()`, {}, 20000);
    } catch (e) { raw = null; }

    let list = [];
    if (raw && raw.indexOf('channelList') > -1) {
      try {
        const j = JSON.parse(raw);
        for (const ch of (j.channelList || [])) {
          const d = (ch.content && ch.content.course && ch.content.course.data) || [];
          if (d[0]) list.push({ name: (ch.content && ch.content.name) || d[0].name, courseId: String(d[0].id) });
        }
      } catch (e) {}
    }

    if (list.length) {
      const uid = await s.eval(`(()=>{const m=document.cookie.match(/_uid=([^;]+)/);return m?m[1]:''})()`).catch(() => '');
      console.log('ACCOUNT_OK 登录完成：uid=' + (uid || '未知') + '，名下 ' + list.length + ' 门课');
      list.forEach((c, i) => console.log('   ' + (i + 1) + '. ' + c.name + '  [courseId=' + c.courseId + ']'));
      const extra = process.argv.slice(2);
      console.log('开始跑课…（实时日志：autopilot-live.log）参数：' + (extra.join(' ') || '全量'));
      const out = fs.openSync(path.join(DIR, 'autopilot-live.log'), 'a');
      spawn(process.execPath, ['autopilot.js', '--manual-login'].concat(extra), {
        cwd: DIR, detached: true, stdio: ['ignore', out, out],
      }).unref();
      b.close();
      process.exit(0);
    }

    const note = '还没登录（等你在这台浏览器窗口里登录）';
    if (note !== lastNote) { console.log('WAIT ' + note); lastNote = note; }
    await sleep(6000);
  }
  console.log('TIMEOUT 等了 ' + MAX_WAIT_MIN + ' 分钟还没登录，先退出');
  b.close();
  process.exit(0);
})().catch((e) => { console.log('ERR ' + e.message); process.exit(1); });
