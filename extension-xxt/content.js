// content.js —— 学习通播放页的桥：注入引擎、代理 DeepSeek 请求、转发侧边栏指令、上报状态
(function () {
  if (window.top !== window.self) return; // 只在主框架干活

  const HOST_ID = 'xt-ds-host';

  /* ---------- 1. 把引擎注入到页面主世界（原油猴脚本需要真实 window） ---------- */
  function injectEngine() {
    if (document.getElementById('xt-ds-engine')) return;
    const s = document.createElement('script');
    s.id = 'xt-ds-engine';
    s.src = chrome.runtime.getURL('engine.js');
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => {
      chrome.runtime.sendMessage({ type: 'pageState', patch: { injected: true, url: location.href } }).catch(() => {});
    };
  }
  injectEngine();

  /* ---------- 2. GM_xmlhttpRequest 桥：主世界 → 这里 → background ---------- */
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || !d.__xtGmReq) return;
    chrome.runtime.sendMessage({
      type: 'gmRequest', url: d.url, method: d.method, headers: d.headers, data: d.data,
    }).then((res) => {
      window.postMessage({ __xtGm: d.__xtGmReq, res: res }, '*');
    }).catch((e) => {
      window.postMessage({ __xtGm: d.__xtGmReq, res: { ok: false, error: String(e) } }, '*');
    });
  });

  /* ---------- 3. 面板操作 ---------- */
  function shadow() {
    const h = document.getElementById(HOST_ID);
    return h && h.shadowRoot ? h.shadowRoot : null;
  }

  function findByText(root, text) {
    const all = root.querySelectorAll('button, [role="button"], .btn, a');
    for (const el of all) {
      if ((el.innerText || '').trim() === text) return el;
    }
    return null;
  }

  function clickText(text) {
    const sr = shadow();
    if (!sr) return { ok: false, error: '面板还没加载出来（等视频页加载完）' };
    const el = findByText(sr, text);
    if (!el) return { ok: false, error: '没找到按钮：' + text };
    el.click();
    return { ok: true };
  }

  function setKey(key) {
    const sr = shadow();
    if (!sr) return { ok: false, error: '面板还没加载出来' };
    const inp = sr.querySelector('input[type="password"]') || sr.querySelector('input');
    if (!inp) return { ok: false, error: '没找到 Key 输入框' };
    inp.focus();
    inp.value = key;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    const save = findByText(sr, '保存');
    if (save) { save.click(); return { ok: true }; }
    return { ok: false, error: '没找到「保存」按钮' };
  }

  function readPanel() {
    const sr = shadow();
    if (!sr) return null;
    const panel = sr.getElementById('panel') || sr.querySelector('.panel');
    if (!panel) return null;
    const txt = (panel.innerText || '').replace(/\r/g, '');
    const lines = txt.split('\n').map((x) => x.trim()).filter(Boolean);
    return { txt: txt, lines: lines };
  }

  // 递归找 iframe 里的 video（学习通播放器在主文档的 iframe 内，主文档 querySelector 永远拿不到）
  function findVideo() {
    let best = null;
    function walk(doc, depth) {
      if (depth > 5) return;
      try {
        for (const v of doc.querySelectorAll('video')) {
          if (v.duration && v.duration > 0 && (!best || v.currentTime > best.currentTime)) best = v;
        }
      } catch (e) {}
      try {
        for (const f of doc.querySelectorAll('iframe')) {
          let d = null;
          try { d = f.contentDocument; } catch (e) {}
          if (d) walk(d, depth + 1);
        }
      } catch (e) {}
    }
    walk(document, 0);
    return best;
  }

  function collectState() {
    const p = readPanel();
    const out = { injected: !!p, url: location.href };

    // 章节标题：优先页面 h1，其次面板里的“第 x/y 章 · 第 n 节 · 名称”
    let chapter = '';
    const h1 = document.querySelector('h1, .chapter-title, .prev_title');
    if (h1 && h1.innerText) chapter = h1.innerText.trim().slice(0, 60);
    let course = '';
    const ct = document.querySelector('.course-title, .prev_course, .mark_item');
    if (ct && ct.innerText) course = ct.innerText.trim().slice(0, 40);

    let progress = '';
    let playing = false;
    const v = findVideo();
    if (v && v.duration) {
      const fmt = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
      progress = fmt(v.currentTime) + ' / ' + fmt(v.duration);
      playing = !v.paused && !v.ended;
    }

    if (p) {
      for (const ln of p.lines) {
        if (/第\s*\d+\s*\/\s*\d+\s*章/.test(ln)) { chapter = ln.slice(0, 80); break; }
      }
      for (const ln of p.lines) {
        // 面板进度嵌在长句里（如「视频 … 国防的内涵 0:59 / 5:41」），不能锚定整行
        const pm = /(\d+):(\d{2})\s*\/\s*(\d+):(\d{2})/.exec(ln);
        if (pm) { progress = pm[1] + ':' + pm[2] + ' / ' + pm[3] + ':' + pm[4]; break; }
      }
      if (/视频播放中|播放中/.test(p.txt)) playing = true;
    }

    // 日志：取面板里形如 HH:MM:SS 开头的行
    const logs = [];
    if (p) for (const ln of p.lines) { if (/^\d{1,2}:\d{2}:\d{2}/.test(ln)) logs.push(ln); }

    out.chapter = chapter;
    out.course = course;
    out.progress = progress;
    out.playing = playing;
    out.running = !!(p && /=== 学习通自动刷课已启动 ===/.test(p.txt));
    out.logs = logs.slice(-40);
    out.keySaved = !!(p && !/尚未保存 API Key/.test(p.txt));
    return out;
  }

  /* ---------- 4. 接收侧边栏指令 ---------- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg.type === 'cmd') {
        if (msg.action === 'start') return sendResponse(clickText('开始'));
        if (msg.action === 'stop') return sendResponse(clickText('停止'));
        if (msg.action === 'next') return sendResponse(clickText('下一节'));
        if (msg.action === 'key') return sendResponse(setKey(msg.key || ''));
        if (msg.action === 'test') return sendResponse(clickText('测试'));
        if (msg.action === 'clear') return sendResponse(clickText('清空日志'));
        if (msg.action === 'snapshot') return sendResponse({ ok: true, state: collectState() });
        return sendResponse({ ok: false, error: '未知指令' });
      }
      if (msg.type === 'collect') {
        sendResponse({ ok: true, state: collectState() });
        return;
      }
      sendResponse({ ok: false, error: 'unknown' });
    })();
    return true;
  });

  /* ---------- 5. 定期上报 ---------- */
  setInterval(() => {
    try {
      const st = collectState();
      chrome.runtime.sendMessage({ type: 'pageState', patch: st }).catch(() => {});
    } catch (e) {}
  }, 2000);
})();
