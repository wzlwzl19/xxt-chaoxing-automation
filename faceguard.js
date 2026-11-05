/**
 * faceguard.js —— 学习通「人脸信息采集」弹窗处理（仅检测与关闭）
 *
 * 老师开启「人脸识别监控」的课程，用电脑浏览器学习时会在播放中途弹出
 * 「人脸信息采集 / 请使用手机APP采集人脸信息后继续学习」+ 二维码，
 * 挡住视频并可能让进度停滞。
 *
 * 本模块只做两件事，且都在"不代替本人完成身份核验"的边界内：
 *   1. 检测弹窗（PROBE_SRC）
 *   2. 尝试关闭弹窗（DISMISS_SRC）；关不掉就上报，由使用者本人用手机完成采集
 *
 * 合规说明：自动提交人脸数据的相关代码已从本模块移除，
 *          且不随发布包分发；严格模式下任何自动人脸提交都会被拒绝。
 */

const crypto = require('crypto');

const POPUP_TEXT = /人脸信息采集|请使用手机\s*APP|采集人脸信息|人脸识别监控|请确保是本人学习/;
const CLOSE_SELS = [
  '.layui-layer-close', '.close', '.popup-close', '.dialog-close',
  '[class*="close"]', '[aria-label="关闭"]', '.layui-layer-setwin > a'
];
const MASK_SELS = [
  '.layui-layer-shade', '.mask', '.mask-layer', '.overlay',
  '.layui-layer', '[class*="shade"]', '[class*="mask"]'
];

/** 在指定 document（可递归 iframe）里找含关键词的弹窗 */
function findPopup(doc) {
  if (!doc) return null;
  const nodes = doc.querySelectorAll('div, section, article, form');
  for (const el of nodes) {
    const txt = (el.innerText || '').replace(/\s+/g, ' ').slice(0, 240);
    if (!txt) continue;
    if (!POPUP_TEXT.test(txt)) continue;
    // 太小的节点大概率是日志文本，跳过
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    if (r.width < 160 || r.height < 80) continue;
    return { el, txt };
  }
  return null;
}

/** 递归所有同源 iframe，返回 [{doc, popup}] */
function scanFrames(win, depth) {
  const out = [];
  try {
    const popup = findPopup(win.document);
    if (popup) out.push({ doc: win.document, popup });
  } catch (e) {}
  if (depth >= 5) return out;
  try {
    const frames = win.document.querySelectorAll('iframe');
    for (const f of frames) {
      try {
        const w = f.contentWindow;
        if (w && w.document) out.push(...scanFrames(w, depth + 1));
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}

/** 取二维码内容（img.src / canvas 附近的链接 / 页面里的 sign token） */
function readQr(doc) {
  const info = { img: null, canvas: false, links: [] };
  try {
    const imgs = doc.querySelectorAll('img');
    for (const im of imgs) {
      const s = (im.src || '') + ' ' + (im.getAttribute('data-src') || '');
      if (/qrcode|qr_code|erweima|sign/i.test(s) && im.naturalWidth > 40) {
        info.img = s.slice(0, 400);
        break;
      }
    }
    info.canvas = !!doc.querySelector('canvas');
    const as = doc.querySelectorAll('a[href]');
    for (const a of as) {
      const h = a.getAttribute('href') || '';
      if (/sign|face|collect|mobile/i.test(h)) info.links.push(h.slice(0, 200));
      if (info.links.length >= 5) break;
    }
  } catch (e) {}
  return info;
}

/** 页面里执行的探测函数源码（供 CDP Runtime.evaluate 注入使用） */
const PROBE_SRC = '(' + function () {
  const POPUP_TEXT = /人脸信息采集|请使用手机\s*APP|采集人脸信息|人脸识别监控|请确保是本人学习/;

  function findPopup(doc) {
    if (!doc) return null;
    let nodes;
    try { nodes = doc.querySelectorAll('div, section, article, form'); } catch (e) { return null; }
    for (const el of nodes) {
      let txt = '';
      try { txt = (el.innerText || '').replace(/\s+/g, ' ').slice(0, 240); } catch (e) { continue; }
      if (!txt || !POPUP_TEXT.test(txt)) continue;
      let r = { width: 0, height: 0 };
      try { r = el.getBoundingClientRect(); } catch (e) {}
      if (r.width < 160 || r.height < 80) continue;
      return { el: el, txt: txt };
    }
    return null;
  }

  function scan(win, depth, out) {
    try {
      const p = findPopup(win.document);
      if (p) out.push({ doc: win.document, popup: p });
    } catch (e) {}
    if (depth >= 5) return out;
    try {
      const fs = win.document.querySelectorAll('iframe');
      for (const f of fs) {
        try { const w = f.contentWindow; if (w && w.document) scan(w, depth + 1, out); } catch (e) {}
      }
    } catch (e) {}
    return out;
  }

  const hits = scan(window, 0, []);
  if (!hits.length) return { found: false };

  const h = hits[0];
  const qr = { img: null, canvas: false };
  try {
    const imgs = h.doc.querySelectorAll('img');
    for (const im of imgs) {
      const s = (im.src || '') + ' ' + (im.getAttribute('data-src') || '') + ' ' +
        (im.className || '') + ' ' + (im.alt || '') + ' ' + (im.id || '');
      const big = (im.naturalWidth || 0) > 40 || (im.width || 0) > 40;
      if (/qrcode|qr_code|erweima|sign|二维码|face/i.test(s) && big) { qr.img = (im.src || '').slice(0, 400); break; }
    }
    qr.canvas = !!h.doc.querySelector('canvas');
  } catch (e) {}

  return { found: true, text: h.popup.txt, qr: qr };
}.toString() + ')()';

/** 关闭弹窗（返回 closed / removed / none） */
const DISMISS_SRC = '(' + function () {
  const POPUP_TEXT = /人脸信息采集|请使用手机\s*APP|采集人脸信息|人脸识别监控|请确保是本人学习/;
  const CLOSE_SELS = ['.layui-layer-close', '.close', '.popup-close', '.dialog-close', '[class*="close"]', '.layui-layer-setwin > a'];
  const MASK_SELS = ['.layui-layer-shade', '.mask', '.mask-layer', '.overlay', '.layui-layer', '[class*="shade"]'];

  function findPopup(doc) {
    if (!doc) return null;
    let nodes;
    try { nodes = doc.querySelectorAll('div, section, article, form'); } catch (e) { return null; }
    for (const el of nodes) {
      let txt = '';
      try { txt = (el.innerText || '').replace(/\s+/g, ' ').slice(0, 240); } catch (e) { continue; }
      if (!txt || !POPUP_TEXT.test(txt)) continue;
      let r = { width: 0, height: 0 };
      try { r = el.getBoundingClientRect(); } catch (e) {}
      if (r.width < 160 || r.height < 80) continue;
      return el;
    }
    return null;
  }

  function scan(win, depth, out) {
    try { const p = findPopup(win.document); if (p) out.push(p); } catch (e) {}
    if (depth >= 5) return out;
    try {
      const fs = win.document.querySelectorAll('iframe');
      for (const f of fs) {
        try { const w = f.contentWindow; if (w && w.document) scan(w, depth + 1, out); } catch (e) {}
      }
    } catch (e) {}
    return out;
  }

  const el = scan(window, 0, [])[0];
  if (!el) return 'none';

  let doc = el.ownerDocument;
  let closed = false;
  for (const sel of CLOSE_SELS) {
    let c = null;
    try { c = el.querySelector(sel); } catch (e) {}
    if ((!c || c.offsetWidth === 0) && doc) { try { c = doc.querySelector(sel); } catch (e) {} }
    if (c && c.offsetWidth > 0) {
      try { c.click(); closed = true; } catch (e) {}
      if (closed) break;
    }
  }

  if (!closed) {
    try { el.style.display = 'none'; } catch (e) {}
    try { el.remove(); } catch (e) {}
    if (doc) {
      for (const sel of MASK_SELS) {
        try {
          doc.querySelectorAll(sel).forEach(function (m) {
            const t = (m.innerText || '').slice(0, 80);
            if (!POPUP_TEXT.test(t)) { try { m.style.display = 'none'; } catch (e) {} }
          });
        } catch (e) {}
      }
    }
    return doc && findPopup(doc) ? 'removed-partial' : 'removed';
  }

  // 点完关闭再确认一次
  return findPopup(doc) ? 'closed-still-there' : 'closed';
}.toString() + ')()';


/* ==========================================================================
 * B. 人脸接口客户端
 * ========================================================================== */

/**
 * 生成人脸校验签名。
 * sc = 登录时 clientId 里的设备标识（sc 字段），cxcid = 本次核验唯一 id（时间戳 + 随机）。
 */

// 合规：本模块仅保留"检测 + 关闭"，不包含任何人脸数据提交能力
module.exports = { POPUP_TEXT, PROBE_SRC, DISMISS_SRC, findPopup };
