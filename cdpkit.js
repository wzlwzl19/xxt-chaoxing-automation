// cdpkit.js —— 零依赖 CDP 工具库（Node 内置 WebSocket）
// 提供：浏览器级连接 / 新建标签 / 会话内命令 / 页面命令
const http = require('http');

function httpJSON(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 120))); } });
    });
    req.on('error', reject);
    req.end();
  });
}

class Session {
  constructor(ws, sessionId) { this.ws = ws; this.sessionId = sessionId; this.id = 0; this.pending = new Map(); }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, timeoutMs);
    });
  }
  // 第三参 timeoutMs：调用方写 s.eval(expr, {}, 15000) 时真正生效（否则默认 30s）
  async eval(expression, opts = {}, timeoutMs = 10000) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      ...opts,
    }, timeoutMs);
    if (r.exceptionDetails) throw new Error('page eval threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
}

class Browser {
  constructor(port = 9222) { this.port = port; this.ws = null; this.sessions = new Map(); this.id = 0; this.pending = new Map(); this.closed = false; }
  async connect() {
    const v = await httpJSON(this.port, '/json/version');
    const url = v.webSocketDebuggerUrl;
    if (!url) throw new Error('no webSocketDebuggerUrl (浏览器没开调试端口?)');
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP ws 连接失败'));
      this.ws.onclose = () => { this.closed = true; };
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        // 浏览器级消息没有 sessionId；session 消息带 sessionId。先按是否有 sessionId 分流，
        // 避免浏览器级 id 和某个 session 的 id 撞号时互相抢响应。
        if (m.id && !m.sessionId && this.pending.has(m.id)) {
          const q = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result);
          return;
        }
        const s = this.sessions.get(m.sessionId);
        if (s && m.id && s.pending.has(m.id)) {
          const q = s.pending.get(m.id); s.pending.delete(m.id);
          m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result);
        }
      };
    });
    return this;
  }
  raw(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  async pages() {
    const list = await httpJSON(this.port, '/json/list');
    return list.filter((t) => t.type === 'page' && !(t.url || '').startsWith('devtools://'));
  }
  async findPage(match) {
    const ps = await this.pages();
    if (typeof match === 'string') return ps.find((p) => (p.url || '').includes(match));
    return ps.find((p) => match(p));
  }
  async newPage(url = 'about:blank') {
    // 浏览器刚起来/窗口被最小化时，Target.createTarget 会偶发 -32000「Failed to open a new tab」。
    // 重试三次；仍失败就退化成「复用现有页面并导航」，绝不因为开不出标签而整趟任务失败。
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const { targetId } = await this.raw('Target.createTarget', { url });
        if (targetId) return this.attach(targetId);
      } catch (e) {
        lastErr = e;
        await sleep(700);
      }
    }
    try {
      const ps = await this.pages();
      const pg = ps.find((p) => p.type === 'page') || ps[0];
      if (pg) {
        const sess = await this.attach(pg.id);
        await sess.send('Page.navigate', { url }).catch(() => {});
        return sess;
      }
    } catch (e) {}
    throw lastErr || new Error('开新标签失败且没有可复用页面');
  }
  async attach(targetId) {
    const { sessionId } = await this.raw('Target.attachToTarget', { targetId, flatten: true });
    const s = new Session(this.ws, sessionId);
    this.sessions.set(sessionId, s);
    await s.send('Page.enable').catch(() => {});
    await s.send('Runtime.enable').catch(() => {});
    s.targetId = targetId;
    return s;
  }
  async attachPage(match) {
    const p = await this.findPage(match);
    if (!p) return null;
    return this.attach(p.id);
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, interval = 250, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) {}
    await sleep(interval);
  }
  throw new Error('等待超时: ' + label);
}

module.exports = { Browser, Session, sleep, waitFor, httpJSON, framesEval };

/**
 * 逐 frame 求值：学习通部分章节的播放器在**跨源 iframe** 里，
 * 页面内 contentDocument 递归拿不到（会抛 Blocked a frame with origin ...）。
 * CDP 是有特权的，可以给每个 frame 建独立执行环境后求值，于是能读到那些视频。
 * 返回 [{ url, value } | { url, error }]
 */
async function framesEval(session, expression, timeoutMs = 8000) {
  const out = [];
  let tree = null;
  try { tree = await session.send('Page.getFrameTree', {}, timeoutMs); } catch (e) { return out; }
  const cache = session.__xxtFrameWorlds || (session.__xxtFrameWorlds = new Map());
  const walk = async (node, depth) => {
    if (!node || !node.frame || depth > 8) return;
    const f = node.frame;
    try {
      let ctxId = cache.get(f.id);
      if (!ctxId) {
        const w = await session.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'xxt_probe' }, timeoutMs);
        ctxId = w && w.executionContextId;
        if (ctxId) cache.set(f.id, ctxId);
      }
      if (!ctxId) { out.push({ url: f.url, error: 'no-context' }); }
      else {
        const r = await session.send('Runtime.evaluate', {
          expression, contextId: ctxId, returnByValue: true, awaitPromise: true,
        }, timeoutMs);
        const v = r && r.result ? r.result.value : undefined;
        if (v !== undefined && v !== null) out.push({ url: f.url, value: v });
        else if (r && r.exceptionDetails) out.push({ url: f.url, error: String(r.exceptionDetails.text || 'eval-error').slice(0, 80) });
      }
    } catch (e) {
      out.push({ url: f.url, error: e.message });
      cache.delete(f.id);
    }
    for (const c of (node.childFrames || [])) await walk(c, depth + 1);
  };
  await walk(tree && tree.frameTree, 0);
  return out;
}
