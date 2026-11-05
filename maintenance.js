// maintenance.js —— 定时清理：日志截断 + 临时文件回收 + 浏览器内存整理
// 用法：
//   node maintenance.js            跑一轮就退出
//   node maintenance.js --daemon   常驻，每 N 分钟跑一轮（N 默认 15）
//   node maintenance.js --watch    跟随 autopilot 进程，autopilot 退出它也退出
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const LOG = path.join(DIR, 'maintenance.log');

const DEFAULTS = {
  everyMin: 15,          // 多久清一次
  logMaxMB: 2,           // 单个 .log 超过这个大小就截断
  logKeepKB: 200,        // 截断后只保留尾部这么多 KB
  tmpKeepDays: 3,        // 截图/探针脚本保留天数
  closeIdleTabs: true,   // 关掉多余的标签页
  gc: true,              // 触发浏览器堆回收
  maxLogMB: 8,           // maintenance.log 自己的上限
};

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(line) {
  const s = `[${now()}] ${line}\n`;
  try { fs.appendFileSync(LOG, s); } catch (_) { /* 写不进去就算了，别影响主流程 */ }
  return s;
}

// 把文件截断成"保留尾部 keepBytes"
function trimTail(file, keepBytes) {
  const st = fs.statSync(file);
  if (st.size <= keepBytes) return 0;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(keepBytes);
  const start = st.size - keepBytes;
  fs.readSync(fd, buf, 0, keepBytes, start);
  fs.closeSync(fd);
  // 尽量从第一个换行处开始，避免半行
  let s = buf.toString('utf8');
  const nl = s.indexOf('\n');
  if (nl > 0 && nl < 4000) s = s.slice(nl + 1);
  fs.writeFileSync(file, '…（较早日志已清理，只保留最近部分）\n' + s, 'utf8');
  return st.size - Buffer.byteLength(s, 'utf8');
}

// 1) 日志截断
function trimLogs(opt) {
  const maxBytes = opt.logMaxMB * 1024 * 1024;
  const keepBytes = opt.logKeepKB * 1024;
  const done = [];
  let files = [];
  try { files = fs.readdirSync(DIR); } catch (_) { return done; }
  for (const f of files) {
    if (!/\.log$/i.test(f)) continue;
    const full = path.join(DIR, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.isFile()) continue;
    const cap = (f === 'maintenance.log') ? opt.maxLogMB * 1024 * 1024 : maxBytes;
    if (st.size <= cap) continue;
    try {
      trimTail(full, keepBytes);
      done.push(`${f} ${(st.size / 1048576).toFixed(1)}MB→${(fs.statSync(full).size / 1024).toFixed(0)}KB`);
    } catch (e) { done.push(`${f} 清理失败(${e.message})`); }
  }
  return done;
}

// 2) 临时文件回收（截图、探针、一次性 json）
const TMP_PATTERNS = [
  /^probe-.*\.js$/i, /^check-.*\.js$/i, /^shot.*\.js$/i, /^click-.*\.js$/i,
  /^inject\d*\.js$/i, /^open-login\.js$/i, /^back-to-login\.js$/i,
  /^watch-login\.js$/i, /^clear-login\.js$/i, /^close-tabs\.js$/i,
  /\.png$/i, /^tab-.*\.json$/i,
];
// 这些留着，是交付物
const KEEP = new Set(['panel-proof.png', 'extension-xxt', 'icons']);

function sweepTmp(opt) {
  const days = opt.tmpKeepDays;
  const cutoff = Date.now() - days * 86400000;
  const done = [];
  let files = [];
  try { files = fs.readdirSync(DIR); } catch (_) { return done; }
  for (const f of files) {
    if (KEEP.has(f)) continue;
    if (!TMP_PATTERNS.some((re) => re.test(f))) continue;
    const full = path.join(DIR, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.isFile() || st.mtimeMs > cutoff) continue;
    try { fs.unlinkSync(full); done.push(f); } catch (_) { }
  }
  return done;
}

// 3) 浏览器侧整理：关多余标签 + 回收堆
async function browserHygiene(opt) {
  let Browser, sleep;
  try { ({ Browser, sleep } = require('./cdpkit')); } catch (_) { return ['cdpkit 缺失，跳过']; }
  const out = [];
  let b;
  try {
    b = await new Browser(9222).connect();
  } catch (_) {
    return ['浏览器没开（9222 连不上），跳过'];
  }
  try {
    const pages = await b.pages();
    // 保留：一个工作页（chaoxing）+ 扩展页；其它关掉
    const keep = [];
    const course = pages.find((p) => /studentstudy|studentcourse|chaoxing/.test(p.url));
    if (course) keep.push(course.id);
    const ext = pages.find((p) => /^chrome-extension:\/\//.test(p.url));
    if (ext) keep.push(ext.id);
    if (!keep.length && pages[0]) keep.push(pages[0].id);

    if (opt.closeIdleTabs && pages.length > keep.length + 1) {
      let closed = 0;
      for (const p of pages) {
        if (keep.includes(p.id)) continue;
        if (p.type !== 'page') continue;
        try { await b.raw('Target.closeTarget', { targetId: p.id }); closed++; } catch (_) { }
      }
      if (closed) out.push(`关掉 ${closed} 个多余标签页`);
    }

    // 堆回收：连着点两次更容易真正释放
    if (opt.gc) {
      const t = course || pages[0];
      if (t) {
        try {
          const s = await b.attach(t.id);
          for (let i = 0; i < 2; i++) {
            await s.send('HeapProfiler.collectGarbage').catch(() => { });
            await sleep(400);
          }
          await s.send('Runtime.releaseObjectGroup', { objectGroup: 'xxt' }).catch(() => { });
          const m = await s.send('Performance.getMetrics').catch(() => null);
          if (m && m.metrics) {
            const g = (n) => (m.metrics.find((x) => x.name === n) || {}).value;
            const heap = g('JSHeapUsedSize');
            if (heap) out.push(`页面 JS 堆 ${(heap / 1048576).toFixed(1)}MB`);
          }
        } catch (_) { }
      }
    }

    // 进程总内存
    try {
      const info = await b.raw('SystemInfo.getProcessInfo');
      if (info && info.processInfo) {
        out.push(`浏览器进程 ${info.processInfo.length} 个`);
      }
    } catch (_) { }
  } catch (e) {
    out.push('整理出错：' + e.message);
  } finally {
    try { b && b.close(); } catch (_) { }
  }
  return out;
}

async function tick(opt0) {
  const opt = Object.assign({}, DEFAULTS, opt0 || {});
  const parts = [];
  const logs = trimLogs(opt);
  if (logs.length) parts.push('日志截断：' + logs.join('、'));
  const tmp = sweepTmp(opt);
  if (tmp.length) parts.push('删除临时文件 ' + tmp.length + ' 个：' + tmp.slice(0, 6).join('、') + (tmp.length > 6 ? '…' : ''));
  const hy = await browserHygiene(opt);
  if (hy.length) parts.push('浏览器：' + hy.join('；'));
  const line = parts.length ? parts.join(' | ') : '无需清理';
  log(line);
  return line;
}

module.exports = { tick, trimLogs, sweepTmp, browserHygiene, DEFAULTS, log };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const everyMin = (() => {
    const i = argv.indexOf('--every-min');
    return i > -1 ? Math.max(1, parseInt(argv[i + 1], 10) || 15) : 15;
  })();
  const opt = { everyMin };

  if (argv.includes('--daemon') || argv.includes('--watch')) {
    const watch = argv.includes('--watch');
    let alive = true;
    let seenPid = false; // 第一次检测到 autopilot 才算"跟随"生效，避免启动竞态（autopilot 还没写 pid 就误判退出）
    process.on('SIGINT', () => { alive = false; process.exit(0); });
    (async () => {
      const boot = `常驻清理启动：每 ${everyMin} 分钟一轮${watch ? '，跟随 autopilot' : ''}`;
      console.log(boot); log(boot);
      while (alive) {
        if (watch) {
          // autopilot 不在了就自己退出，别留僵尸
          const st = path.join(DIR, 'autopilot.pid');
          let running = true;
          try {
            const pid = parseInt(fs.readFileSync(st, 'utf8').trim(), 10);
            if (pid) {
              seenPid = true;
              try { process.kill(pid, 0); } catch (_) { running = false; }
            } else {
              running = false;
            }
          } catch (_) { running = false; }
          // 只有在"见过 autopilot 启动"之后它才可能"退出"；还没见过就继续等，别因为竞态自杀
          if (!running && seenPid) { const s = 'autopilot 已退出，清理进程跟着结束'; console.log(s); log(s); break; }
        }
        const r = await tick(opt);
        console.log(`[${now()}] ${r}`);
        await new Promise((res) => setTimeout(res, everyMin * 60000));
      }
      process.exit(0);
    })();
  } else {
    tick(opt).then((r) => {
      console.log('清理完成：' + r);
      console.log('明细见 ' + LOG);
    }).catch((e) => { console.log('清理失败：' + e.message); process.exitCode = 1; });
  }
}
