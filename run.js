// 学习通自动刷课 · 全自动 CDP 运行器（无需油猴、无需 F12）
// 用法: node run.js            -> 探测登录态/课程列表
//       node run.js go [序号]   -> 打开第 N 门课的播放页并常驻注入脚本
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 9222;
const SCRIPT = path.join(__dirname, 'xuexitong-console.js');

function getJSON(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('ws error'));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 45000);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) return { error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
  return { value: r.result && r.result.value };
}

async function pickPage(prefer) {
  const list = await getJSON('/json/list');
  const pages = list.filter((t) => t.type === 'page');
  let t = pages.find((p) => (p.url || '').includes(prefer));
  if (!t) t = pages.find((p) => (p.url || '').includes('chaoxing'));
  if (!t) t = pages[0];
  if (!t) throw new Error('没有可用的 page target');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.connect();
  return { cdp, target: t };
}

async function goto(cdp, url, waitMs = 3500) {
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });
  await sleep(waitMs);
}

(async () => {
  const mode = process.argv[2] || 'probe';
  const idx = parseInt(process.argv[3] || '0', 10);
  const { cdp, target } = await pickPage('chaoxing');
  console.log('当前页面: ' + target.url);

  const loginState = await evaluate(cdp, `JSON.stringify({url:location.href,title:document.title})`);
  console.log('状态: ' + JSON.stringify(loginState.value));

  if ((target.url || '').includes('passport2') || (loginState.value || '').includes('用户登录')) {
    console.log('NEED_LOGIN 这个窗口还没登录学习通：请在弹出的 Edge 窗口里完成登录（扫码/账号密码），然后重新运行本脚本。');
    cdp.close();
    return;
  }

  if (mode === 'probe') {
    await goto(cdp, 'https://mooc1.chaoxing.com/visit/interaction');
    const r = await evaluate(cdp, `(() => {
      const links = [...document.querySelectorAll('a[href]')].map(a => ({t:(a.innerText||'').trim().replace(/\s+/g,' ').slice(0,40), h:a.href}))
        .filter(x => /courseId=/i.test(x.h) || /studentcourse/i.test(x.h));
      const seen = new Set(); const out = [];
      for (const l of links) { const k = l.h; if (!seen.has(k)) { seen.add(k); out.push(l); } }
      return JSON.stringify({url:location.href, title:document.title, courses: out.slice(0, 15)});
    })()`);
    console.log('课程页: ' + JSON.stringify(r.value));
    cdp.close();
    return;
  }

  if (mode === 'go') {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const coursesRaw = await evaluate(cdp, `(() => {
      const links = [...document.querySelectorAll('a[href]')].map(a => ({t:(a.innerText||'').trim().replace(/\\s+/g,' ').slice(0,40), h:a.href}))
        .filter(x => /courseId=/i.test(x.h) || /studentcourse/i.test(x.h));
      const seen = new Set(); const out = [];
      for (const l of links) { if (!seen.has(l.h)) { seen.add(l.h); out.push(l); } }
      return JSON.stringify(out);
    })()`);
    let list = [];
    try { list = JSON.parse(coursesRaw.value || '[]'); } catch (e) {}
    if (!list.length) {
      await goto(cdp, 'https://mooc1.chaoxing.com/visit/interaction');
      const again = await evaluate(cdp, `(() => {
        const links = [...document.querySelectorAll('a[href]')].map(a => ({t:(a.innerText||'').trim().replace(/\\s+/g,' ').slice(0,40), h:a.href}))
          .filter(x => /courseId=/i.test(x.h) || /studentcourse/i.test(x.h));
        const seen = new Set(); const out = [];
        for (const l of links) { if (!seen.has(l.h)) { seen.add(l.h); out.push(l); } }
        return JSON.stringify(out);
      })()`);
      try { list = JSON.parse(again.value || '[]'); } catch (e) {}
    }
    if (!list.length) { console.log('没找到课程链接，可能没选课或页面结构变了。'); cdp.close(); return; }
    console.log('课程列表:');
    list.forEach((c, i) => console.log(`  [${i}] ${c.t}  ${c.h}`));
    const pick = list[Math.min(idx, list.length - 1)];
    console.log('选择: ' + pick.t + ' -> ' + pick.h);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
    console.log('已注册常驻注入（每个新文档自动加载脚本）');
    await goto(cdp, pick.h, 5000);
    const found = await evaluate(cdp, `(() => {
      const chapters = [...document.querySelectorAll('a[href*="studentstudy"], .chapter_item a, [onclick*="studentstudy"]')].map(a => ({t:(a.innerText||'').trim().slice(0,40), h:a.href||''}));
      return JSON.stringify({url:location.href, title:document.title, chapters: chapters.slice(0,8)});
    })()`);
    console.log('课程页: ' + JSON.stringify(found.value));
    console.log('下一步: 在该页点进任意章节，脚本会自动出现右侧面板。');
    cdp.close();
    return;
  }
})().catch((e) => { console.log('ERR ' + e.message); process.exitCode = 1; });
