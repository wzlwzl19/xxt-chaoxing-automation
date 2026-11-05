/**
 * 起飞前体检：把「能不能安全开跑」的每一项都查一遍，只读，不改任何东西。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Browser, httpJSON } = require('./cdpkit');

const DIR = __dirname;
const PORT = 9333;
const CDP = 9222;
const out = {};

function mb(n) { return Math.round(n / 1048576); }

(async () => {
  // 1) 桥
  try {
    out.bridge = await httpJSON(PORT, '/ping');
    out.version = await httpJSON(PORT, '/version');
    out.status = await httpJSON(PORT, '/status');
  } catch (e) {
    out.bridge = { error: e.message };
  }

  // 2) 配置
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    out.config = {
      speed: cfg.speed,
      nightQuiet: cfg.nightQuiet,
      restEveryMinutes: cfg.restEveryMinutes,
      restMinutes: cfg.restMinutes,
      stallMinutes: cfg.stallMinutes,
      maxRunMinutes: cfg.maxRunMinutes,
    };
  } catch (e) { out.config = { error: e.message }; }

  // 3) 熔断锁 / 凭证 / 绑定
  const stopLock = path.join(DIR, 'STOP.lock');
  out.stopLock = fs.existsSync(stopLock) ? fs.readFileSync(stopLock, 'utf8').slice(0, 200) : null;
  try {
    const v = require('./vault');
    const c = v.load();
    out.creds = c ? { user: c.user, passLen: (c.pass || '').length } : null;
  } catch (e) { out.creds = { error: e.message }; }

  // 4) 时间窗
  const now = new Date();
  out.now = now.toLocaleString('zh-CN', { hour12: false });
  const hm = now.toTimeString().slice(0, 5);
  const q = out.config.nightQuiet || {};
  if (q.enabled) {
    const inQ = q.start <= q.end ? (hm >= q.start && hm < q.end) : (hm >= q.start || hm < q.end);
    out.inQuietHours = inQ;
  } else out.inQuietHours = false;

  // 5) 浏览器 + 登录态
  try {
    const v = await httpJSON(CDP, '/json/version');
    out.browser = { ok: true, ver: v.Browser };
    const b = await new Browser(CDP).connect();
    const pages = await b.pages();
    out.pages = pages.map((p) => ({ url: (p.url || '').slice(0, 110) }));
    const p = pages.find((x) => /chaoxing/.test(x.url || '')) || pages[0];
    if (p) {
      const s = await b.attach(p.id);
      const probe = await s.eval(
        `(async () => {
           const ck = document.cookie || '';
           const m = /(?:^|;\\s*)_uid=([^;]+)/.exec(ck);
           let api = 'skip';
           try {
             const r = await fetch('https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1', { credentials: 'include' });
             const j = await r.json();
             api = 'n=' + ((j.channelList || []).length);
           } catch (e) { api = 'ERR ' + e.message; }
           return JSON.stringify({
             url: location.href.slice(0, 120),
             uid: m ? m[1] : '',
             hasVideo: !!document.querySelector('video'),
             loginWall: /passport2\\.chaoxing\\.com\\/login/.test(location.href),
             api: api
           });
         })()`,
        { awaitPromise: true, returnByValue: true },
        12000
      );
      out.login = typeof probe === 'string' ? JSON.parse(probe) : probe;
      b.close();
    }
  } catch (e) {
    out.browser = { ok: false, error: e.message };
  }

  // 6) 内存
  out.mem = { totalGB: +(os.totalmem() / 1073741824).toFixed(2), freeGB: +(os.freemem() / 1073741824).toFixed(2) };

  // 7) 日志体积
  out.logs = {};
  for (const f of ['run.log', 'nanny.log', 'bridge-state.json', 'ap-nanny.log', 'quiz-watch.log']) {
    const fp = path.join(DIR, f);
    if (fs.existsSync(fp)) out.logs[f] = mb(fs.statSync(fp).size) + 'MB';
  }
  out.logsTotalMB = Object.values(out.logs).reduce((a, s) => a + (parseInt(s) || 0), 0);

  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.log('FATAL', e.message); process.exitCode = 1; });
