// background.js —— 服务工作线程：代理 DeepSeek 请求（绕 CORS）、维护侧边栏状态、转发指令
const DEEPSEEK_MODELS = 'https://api.deepseek.com/models';

// 点工具栏图标就开侧边栏
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch (e) {}

// 最近一次页面状态（供侧边栏打开时立即渲染）
const state = { updatedAt: 0, tabId: null, url: '', injected: false, running: false, chapter: '', progress: '', logs: [], keySaved: false };

function pushState(patch) {
  Object.assign(state, patch, { updatedAt: Date.now() });
  chrome.storage.local.set({ lastState: state }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'state', state }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'gmRequest') {
      // 白名单：原脚本只请求 DeepSeek API，拒绝被页面注入的任意脚本滥用成"绕 CORS 的万能代理"
      if (!/^https:\/\/api\.deepseek\.com\//.test(msg.url || '')) {
        sendResponse({ ok: false, error: 'blocked url（仅允许 api.deepseek.com）' });
        return;
      }
      // 主世界的 GM_xmlhttpRequest 经 content.js 转到这里，由扩展身份发请求（无 CORS 限制）
      try {
        const r = await fetch(msg.url, {
          method: msg.method || 'GET',
          headers: msg.headers || {},
          body: msg.data === undefined || msg.data === null ? undefined : msg.data,
        });
        const text = await r.text();
        const headers = [];
        r.headers.forEach((v, k) => headers.push(k + ': ' + v));
        sendResponse({ ok: true, value: { status: r.status, statusText: r.statusText, responseText: text, responseHeaders: headers.join('\r\n'), finalUrl: r.url, readyState: 4 } });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
      return;
    }

    if (msg.type === 'pageState') {
      pushState({ tabId: sender.tab ? sender.tab.id : null, ...msg.patch });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'getState') {
      const s = await chrome.storage.local.get('lastState');
      sendResponse({ ok: true, state: s.lastState || state });
      return;
    }

    if (msg.type === 'ping') { sendResponse({ ok: true }); return; }
    sendResponse({ ok: false, error: 'unknown message' });
  })();
  return true;
});
