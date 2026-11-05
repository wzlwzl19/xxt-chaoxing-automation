// guard.js —— 风控熔断引擎
// 设计原则：宁可少刷一节课，也不冒被检测的险。
// 评分制：每个信号有固定权重，累计分值决定动作。
//   score >= 100  → 立即全停 + 冷却锁定（写 STOP.lock）
//   60 <= score < 100 → 暂停 + 降速 + 复评
//   score < 60 → 继续
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const LOG = path.join(DIR, 'guard.log');
const LOCK = path.join(DIR, 'STOP.lock');
const STATE = path.join(DIR, 'guard-state.json');

// ---------- 页面侧采集表达式 ----------
const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const vis = (e) => { if (!e) return false; const st = getComputedStyle(e); const r = e.getBoundingClientRect(); return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0; };

  // 滑块 / 图形验证码（阿里 NoCaptcha 或超星自带）
  const captchaEl = q('#nc_1_n1z') || q('.nc_wrapper') || q('[class*="nc_container"]') || q('#captchaImg') || q('img[src*="captcha"]') || q('.yzm-img');
  const captcha = vis(captchaEl);

  // 会话是否被踢回登录页
  const loginWall = /passport2\\.chaoxing\\.com\\/login|passport\\.chaoxing\\.com/i.test(location.href);

  // 只有"弹层/提示条"里的风控文案才算数，避免把页面正常文字当信号
  const boxSel = '.dialog,.popup,.layer,.maskBox,.tip-box,.toast,.el-message,.layui-layer,[class*="alert"],[class*="warn"]';
  let popText = '';
  document.querySelectorAll(boxSel).forEach((e) => { if (vis(e)) popText += ' ' + (e.innerText || ''); });
  popText = popText.replace(/\\s+/g, ' ').slice(0, 400);

  // 刷课面板的日志区（脚本自己会写重试/失败）
  let panelText = '';
  const host = document.getElementById('xt-ds-host');
  if (host && host.shadowRoot) panelText = (host.shadowRoot.innerText || '').replace(/\\s+/g, ' ').slice(0, 1200);

  // 视频状态：学习通的播放器在 iframe 里，主文档 querySelector('video') 永远是 null
  // 所以要递归钻同源 iframe 才拿得到真实的 currentTime / paused
  const allVideos = [];
  const walk = (doc, depth) => {
    if (!doc || depth > 6) return;
    try { doc.querySelectorAll('video').forEach((x) => allVideos.push(x)); } catch (e) { }
    let frames = [];
    try { frames = doc.querySelectorAll('iframe'); } catch (e) { }
    for (const f of frames) {
      try { const d = f.contentDocument; if (d) walk(d, depth + 1); } catch (e) { }
    }
  };
  walk(document, 0);
  const v = allVideos.find((x) => !x.paused && x.duration > 0) || allVideos.find((x) => x.duration > 0) || allVideos[0] || null;
  const video = v ? { t: +Number(v.currentTime || 0).toFixed(1), d: +Number(v.duration || 0).toFixed(1), paused: v.paused, ended: !!v.ended, rate: v.playbackRate, err: !!(v.error), ready: v.readyState, n: allVideos.length } : null;

  return JSON.stringify({
    url: location.href.slice(0, 200),
    title: document.title,
    captcha, loginWall, popText, panelText, video,
    ts: Date.now()
  });
})()`;

// ---------- 规则 ----------
// w: 命中一次加的分；hold: 该信号需要"持续出现几次"才算数（瞬时抖动不算）
const RULES = [
  { id: 'captcha', w: 120, hold: 1, label: '出现滑块/图形验证码' },
  { id: 'loginWall', w: 120, hold: 1, label: '被踢回登录页（会话失效/风控下线）' },
  { id: 'riskText', w: 90, hold: 2, label: '页面弹层出现风控提示文案' },
  { id: 'answerFail', w: 55, hold: 3, label: '答题/提交连续失败' },
  { id: 'playFail', w: 45, hold: 5, label: '视频连续重试播放失败' },
  { id: 'speedAbnormal', w: 35, hold: 4, label: '播放倍速超过脚本上限（>3x，可能被篡改）' },
  { id: 'videoStuck', w: 30, hold: 6, label: '视频长时间无进度' },
];

const RISK_WORDS = [
  '检测到异常', '操作过于频繁', '请稍后再试', '账号存在风险', '安全验证',
  '设备异常', '异地登录', '访问受限', '异常访问', '请完成验证', '请重新登录',
  '刷课', '作弊', '违规',
];

function now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function logLine(obj) {
  const line = JSON.stringify({ ts: now(), ...obj });
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
  return line;
}

class Guard {
  constructor(opts = {}) {
    this.stopAt = opts.stopAt ?? 100;     // 立即全停
    this.pauseAt = opts.pauseAt ?? 60;    // 暂停复评
    this.lockMinutes = opts.lockMinutes ?? 60;
    this.onTrip = opts.onTrip || (() => {});
    this.onPause = opts.onPause || (() => {});
    this.counters = {};
    this.score = 0;
    this.lastSig = null;
  }

  static readLock() {
    try {
      if (!fs.existsSync(LOCK)) return null;
      return JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    } catch (e) { return null; }
  }

  static isLocked() {
    const l = Guard.readLock();
    if (!l) return null;
    if (l.until && Date.now() < l.until) return l;
    try { fs.unlinkSync(LOCK); } catch (e) {}
    return null;
  }

  static trip(lockMinutes, reason, detail) {
    const rec = { ts: now(), reason, detail: detail || '', until: Date.now() + lockMinutes * 60000 };
    try { fs.writeFileSync(LOCK, JSON.stringify(rec, null, 2)); } catch (e) {}
    logLine({ level: 'TRIP', reason, detail });
    return rec;
  }

  static release() { try { fs.unlinkSync(LOCK); } catch (e) {} }

  // 每次采集后调用；返回 {score, level, actions}
  evaluate(sig) {
    this.lastSig = sig;
    const hits = [];
    // 时间衰减：早期信号会慢慢"冷却"，避免一次抖动永久背锅
    this.score = Math.max(0, this.score - 2);

    const bump = (id, label, w, times) => {
      this.counters[id] = (this.counters[id] || 0) + 1;
      if (this.counters[id] >= times) {
        this.score += w;
        hits.push({ id, label, w });
        this.counters[id] = 0; // 达到阈值加一次分就重新计数，避免持续命中时每次都加分、分数无限膨胀
      }
    };

    if (sig.captcha) bump('captcha', '出现滑块/图形验证码', 120, 1);
    else this.counters.captcha = 0;

    if (sig.loginWall) bump('loginWall', '被踢回登录页', 120, 1);
    else this.counters.loginWall = 0;

    const popHit = RISK_WORDS.find((w) => (sig.popText || '').includes(w));
    if (popHit) bump('riskText', '风控提示：' + popHit, 90, 2);
    else this.counters.riskText = Math.max(0, (this.counters.riskText || 0) - 1);

    const ansFail = /提交失败|答题失败|接口错误|提交异常/.test(sig.panelText || '');
    if (ansFail) bump('answerFail', '答题提交失败', 55, 3);
    else this.counters.answerFail = 0;

    const playFail = /重试播放|播放异常|视频加载失败/.test(sig.panelText || '');
    if (playFail) bump('playFail', '视频重试播放', 45, 5);
    else this.counters.playFail = 0;

    const v = sig.video;
    // 脚本 UI 合法倍速范围是 1.0x~3.0x，用户正常开 2x/3x 不能算异常；
    // 只有超过 3x（被外部篡改或脚本异常）才当风控信号。
    if (v && v.rate > 3.1) bump('speedAbnormal', '倍速 ' + v.rate + 'x', 35, 4);
    else this.counters.speedAbnormal = 0;

    // 视频卡住：60 秒内 currentTime 未推进
    if (v && !v.paused) {
      const prev = this._lastVideo;
      if (prev && prev.t === v.t && Date.now() - prev.at > 60000) {
        bump('videoStuck', '视频 60 秒无进度', 30, 6);
        this._lastVideo = { t: v.t, at: Date.now() };
      } else if (!prev || prev.t !== v.t) {
        this._lastVideo = { t: v.t, at: Date.now() };
      }
    }

    let level = 'ok';
    if (this.score >= this.stopAt) level = 'trip';
    else if (this.score >= this.pauseAt) level = 'pause';

    return { score: this.score, level, hits, sig };
  }

  reset() { this.score = 0; this.counters = {}; this._lastVideo = null; }
}

module.exports = { Guard, PROBE, RULES, RISK_WORDS, logLine, now, LOCK, LOG };
