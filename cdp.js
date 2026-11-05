// 极简 CDP 客户端：无第三方依赖，依赖 Node 22+ 内置 fetch/WebSocket
const http = require('http');

const PORT = 9222;

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.events = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('ws error'));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        } else if (m.method) {
          this.events.push(m);
        }
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); }
      }, 40000);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function browserCDP() {
  const v = await getJSON('/json/version');
  const c = new CDP(v.webSocketDebuggerUrl);
  await c.connect();
  return c;
}

async function pageCDP(match) {
  const list = await getJSON('/json/list');
  const pages = list.filter((t) => t.type === 'page');
  let t = match ? pages.find((p) => (p.url || '').includes(match)) : pages[0];
  if (!t) t = pages[0];
  if (!t) throw new Error('no page target');
  const c = new CDP(t.webSocketDebuggerUrl);
  await c.connect();
  return { cdp: c, target: t };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    return { error: r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || '') };
  }
  return { value: r.result && r.result.value };
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'list') {
      const list = await getJSON('/json/list');
      list.filter((t) => t.type === 'page').forEach((t) => console.log(t.url + '   [' + t.title + ']'));
      console.log('targets=' + list.length);
    } else if (cmd === 'load-ext') {
      const b = await browserCDP();
      const r = await b.send('Extensions.loadUnpacked', { path: rest[0] });
      console.log('loadUnpacked ->', JSON.stringify(r));
      b.close();
    } else if (cmd === 'ext-info') {
      const b = await browserCDP();
      const r = await b.send('Extensions.getStorageItems', { id: rest[0], storageArea: 'local' }).catch((e) => ({ err: e.message }));
      console.log(JSON.stringify(r).slice(0, 800));
      b.close();
    } else if (cmd === 'nav') {
      const { cdp } = await pageCDP(rest[1]);
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url: rest[0] });
      console.log('navigated -> ' + rest[0]);
      cdp.close();
    } else if (cmd === 'eval') {
      const { cdp, target } = await pageCDP(rest[1]);
      const out = await evaluate(cdp, rest[0]);
      console.log('page=' + target.url);
      console.log('result=' + JSON.stringify(out));
      cdp.close();
    } else if (cmd === 'newtab') {
      const b = await browserCDP();
      const r = await b.send('Target.createTarget', { url: rest[0] || 'about:blank' });
      console.log('new tab ' + r.targetId);
      b.close();
    } else {
      console.log('unknown cmd: ' + cmd);
    }
  } catch (e) {
    console.log('ERR ' + e.message);
    process.exitCode = 1;
  }
})();
