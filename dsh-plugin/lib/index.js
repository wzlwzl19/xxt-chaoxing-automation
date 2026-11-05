// dsh-panel-xuexitong —— DSH 宿主侧插件
// 职责很薄：把前端脚本挂进 Web 界面 + 把 /xxt-panel/api/* 反向代理到本地 bridge(9333)。
// 真正的业务（启动 autopilot、解析日志、停止进程）在 XueXiTong/xxt-bridge.js 里。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PANEL_JS = path.join(PKG_ROOT, 'lib', 'panel.js');
const HOME = process.env.XXT_HOME || 'C:\\Users\\wzl\\Documents\\deepseek-harness\\default-workspace\\XueXiTong';
const BRIDGE_PORT = 9333;
const TAG = '[xxt-panel]';

function say(...a) { try { console.log(TAG, ...a); } catch (_) { } }

// DSH 是 Electron：这里的 process.execPath 是 "DeepSeek Harness.exe"，不是 node.exe。
// 拿它去 spawn 会多开一个完整 Electron 实例（吃内存、慢、还弹窗口），必须显式找真 node。
function findNode() {
  const cands = [
    process.env.XXT_NODE,
    process.env.NODE_EXE,
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ];
  for (const c of cands) {
    try { if (c && /node(\.exe)?$/i.test(c) && fs.existsSync(c)) return c; } catch (_) { }
  }
  if (/node(\.exe)?$/i.test(process.execPath)) return process.execPath;
  return 'node';
}

// —— 确保 bridge 在跑（幂等，失败也不影响 DSH 启动）——
function ensureBridge() {
  const req = http.get({ host: '127.0.0.1', port: BRIDGE_PORT, path: '/ping', timeout: 900 }, (res) => res.resume());
  req.on('timeout', () => req.destroy(new Error('ping timeout')));
  req.on('error', () => {
    try {
      const script = path.join(HOME, 'xxt-bridge.js');
      if (!fs.existsSync(script)) { say('缺少 xxt-bridge.js：' + script); return; }
      const nodeExe = findNode();
      spawn(nodeExe, [script], { cwd: HOME, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      say('已拉起 bridge（' + nodeExe + '）');
    } catch (e) { say('拉起 bridge 失败：' + e.message); }
  });
}

// —— 转发到 bridge ——
function proxy(req, res, targetPath, method) {
  const chunks = [];
  if (method === 'POST') req.on('data', (c) => chunks.push(c));
  const done = () => {
    const payload = Buffer.concat(chunks);
    const up = http.request({
      host: '127.0.0.1', port: BRIDGE_PORT, path: targetPath, method,
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
      timeout: 20000,
    }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => {
        res.writeHead(r.statusCode || 200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(d);
      });
    });
    up.on('timeout', () => { up.destroy(new Error('bridge timeout')); });
    up.on('error', (e) => {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'bridge 没在运行：' + e.message }));
    });
    if (payload.length) up.write(payload);
    up.end();
  };
  if (method === 'POST') req.on('end', done); else done();
}

function servePanel(res) {
  try {
    const js = fs.readFileSync(PANEL_JS);
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(js.length),
    });
    res.end(js);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('panel.js 读不到：' + e.message);
  }
}

// 带版本号的面板地址：文件一改 mtime 就变，浏览器一定会重新拉，不会被旧缓存钉死
function panelUrl() {
  try { return '/xxt-panel/panel.js?v=' + Math.floor(fs.statSync(PANEL_JS).mtimeMs); }
  catch (e) { return '/xxt-panel/panel.js'; }
}

// 桌面壳用「内联 script 行」自建 <script src>，加载失败也只静默，不会拖垮启动
function makeInlineRow(url) {
  return '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
    'if(window.__xxtPanelBooted)return;window.__xxtPanelBooted=1;' +
    'var s=document.createElement("script");s.src="' + url + '";s.onerror=function(){};d.appendChild(s)}catch(e){}})()';
}
const INLINE_ROW = makeInlineRow('/xxt-panel/panel.js');

export default {
  name: 'xuexitong-panel',
  apply(root) {
    // ① 两种形态都挂一次；行本身不依赖任何服务，尽早进表
    root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return;
        for (const row of table) {
          if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf('/xxt-panel/panel.js') >= 0) return;
        }
        table.push({ kind: 'script', placement: 'body', text: makeInlineRow(panelUrl()) });
      } catch (_) { }
    });

    root.inject(['webServer'], (ctx) => {
      const routes = [
        { kind: 'exact', path: '/xxt-panel/panel.js', handler: (req, res) => servePanel(res) },
        { kind: 'exact', path: '/xxt-panel/api/status', handler: (req, res) => proxy(req, res, '/status', 'GET') },
        { kind: 'exact', path: '/xxt-panel/api/log', handler: (req, res) => proxy(req, res, '/log' + (req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?')) : ''), 'GET') },
        { kind: 'exact', path: '/xxt-panel/api/start', handler: (req, res) => proxy(req, res, '/start', 'POST') },
        { kind: 'exact', path: '/xxt-panel/api/stop', handler: (req, res) => proxy(req, res, '/stop', 'POST') },
        { kind: 'exact', path: '/xxt-panel/api/open', handler: (req, res) => proxy(req, res, '/open', 'POST') },
      ];
      for (const r of routes) {
        try { ctx.webServer.register(r); } catch (e) { say('路由注册失败 ' + r.path + '：' + e.message); }
      }

      if (typeof ctx.webServer.tapIndex === 'function') {
        try {
          ctx.webServer.tapIndex((html) => {
            if (html.indexOf('/xxt-panel/panel.js') !== -1) return html;
            const tag = '<script defer src="' + panelUrl() + '"></script>';
            return html.indexOf('</body>') !== -1 ? html.replace('</body>', tag + '</body>') : html + tag;
          });
        } catch (e) { say('tapIndex 失败：' + e.message); }
      }

      ensureBridge();
      say('已就绪');
    });
  },
};
