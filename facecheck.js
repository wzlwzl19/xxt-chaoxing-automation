/**
 * facecheck.js —— 人脸识别状态检测与配置
 *
 * 只做「检测 + 告知」，不替用户做任何采集动作：
 *   1. 从课程页/播放页找有没有人脸校验的开关与活动（activeId / faceField 等）
 *   2. 读本机配置 face-config.json，告诉用户当前处于哪一档
 *   3. 把结论写进日志，让 DSH 面板 / 桥接状态里能看见
 *
 * 配置档位（face-config.json）：
 *   {
 *     "mode": "notify",              // notify=只检测并提醒（默认）| auto=检测到就尝试接口化解
 *     "photo": "face.jpg",           // auto 模式下使用的人脸照（项目目录内）
 *     "userId": "",                  // 留空自动取当前 uid
 *     "sc": "",                      // 设备 sc（留空自动从 cookie/clientId 取）
 *     "dismissOnly": true            // 只关弹窗不调接口
 *   }
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CFG_FILE = path.join(DIR, 'face-config.json');

const DEFAULT_CFG = {
  mode: 'notify',
  photo: 'face.jpg',
  userId: '',
  sc: '',
  dismissOnly: true,
};

function cfg() {
  try {
    const t = fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, '');
    return Object.assign({}, DEFAULT_CFG, JSON.parse(t));
  } catch (e) {
    return Object.assign({}, DEFAULT_CFG);
  }
}

function saveCfg(next) {
  const merged = Object.assign({}, cfg(), next || {});
  fs.writeFileSync(CFG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/** 页面里执行：查找人脸校验相关标记，返回结构化信息 */
const DETECT_SRC = '(' + function () {
  const KEY = /人脸|face|faceCheck|faceCollect|LiveDetection/i;
  const out = { enabled: false, hits: [], params: {} };

  function walk(win, depth) {
    let doc;
    try { doc = win.document; } catch (e) { return; }
    if (!doc) return;

    // 1) 全局变量
    try {
      if (win.faceCheck || win.faceCollect || win.openFaceCheck || win.needFaceCheck) out.enabled = true;
    } catch (e) {}

    // 2) 隐藏域 / data 属性
    try {
      const inputs = doc.querySelectorAll('input[type=hidden]');
      for (const i of inputs) {
        const n = (i.name || '') + (i.id || '');
        if (KEY.test(n)) {
          out.hits.push({ type: 'hidden', name: n, value: String(i.value || '').slice(0, 120) });
          if (String(i.value || '') === '1' || /true/i.test(String(i.value || ''))) out.enabled = true;
        }
      }
    } catch (e) {}

    try {
      const all = doc.querySelectorAll('[data-face], [data-facecheck], [data-face-check]');
      for (const a of all) {
        out.hits.push({ type: 'data', tag: a.tagName, val: String(a.getAttribute('data-face') || a.getAttribute('data-facecheck') || '').slice(0, 60) });
        out.enabled = true;
      }
    } catch (e) {}

    // 3) 脚本里的活动参数
    const srcs = [];
    try { for (const s of doc.scripts) if (s.src) srcs.push(s.src); } catch (e) {}
    out.scriptsWithFace = srcs.filter((s) => /face/i.test(s)).slice(0, 5);

    // 4) 递归同源 iframe
    if (depth < 5) {
      try {
        for (const f of doc.querySelectorAll('iframe')) {
          try { if (f.contentWindow && f.contentWindow.document) walk(f.contentWindow, depth + 1); } catch (e) {}
        }
      } catch (e) {}
    }
  }

  walk(window, 0);

  // 常见参数抓取（活动 id 等）
  try {
    const m = location.search.match(/activeId=(\d+)/);
    if (m) out.params.activeId = m[1];
    const p = location.search.match(/activePrimaryId=(\d+)/);
    if (p) out.params.activePrimaryId = p[1];
  } catch (e) {}

  return out;
}.toString() + ')()';

/** 从 cookie 字符串里找 uid 与 sc */
function parseCookie(cookieStr) {
  const out = { uid: '', sc: '', fid: '', _uid: '' };
  const s = String(cookieStr || '');
  let m;
  if ((m = s.match(/(?:^|;\s*)_uid=([^;]+)/))) out._uid = m[1];
  if ((m = s.match(/(?:^|;\s*)UID=([^;]+)/))) out.uid = m[1];
  if ((m = s.match(/(?:^|;\s*)fid=([^;]+)/))) out.fid = m[1];
  if ((m = s.match(/(?:^|;\s*)sc=([^;]+)/))) out.sc = m[1];
  if (!out.uid) out.uid = out._uid;
  return out;
}

/** 读人脸照并转 base64（去掉 data: 前缀） */
function loadPhoto(file) {
  const p = path.isAbsolute(file) ? file : path.join(DIR, file);
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return { path: p, bytes: buf.length, mime, base64: buf.toString('base64') };
}

module.exports = { cfg, saveCfg, DETECT_SRC, parseCookie, loadPhoto, CFG_FILE, DEFAULT_CFG };
