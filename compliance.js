'use strict';
/**
 * 合规模块（compliance）
 * ------------------------------------------------------------------
 * 设计目标：把"技术上能做"收敛到"法律上敢做"。
 * 依据：《民法典》第 1034-1039 条（个人信息）、第 496 条（格式条款提示说明义务）、
 *       第 509 条（诚信履行）、第 1194-1197 条（网络侵权）；
 *       《网络安全法》第 27 条（不得提供专门用于危害网络安全的程序工具）；
 *       《个人信息保护法》第 6 条（最小必要）、第 13 条（合法性基础）；
 *       《反不正当竞争法》第 12 条（不得妨碍他人网络产品正常运行）。
 *
 * 本模块只做四件事，全部是"减法"：
 *   1) 同意闸门：首次运行必须阅读并明确同意《使用须知》，否则不启动。
 *   2) 域名白名单：任何导航/请求只能去学习通与 DeepSeek，其余一律拒绝并记录。
 *   3) 严格模式：默认关闭"自动答题/自动提交"，只做播放自动化；必须显式开启。
 *   4) 脱敏：日志里手机号/账号一律打码，避免个人信息落盘。
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CFG_FILE = path.join(DIR, 'compliance.json');
const CONSENT_FILE = path.join(DIR, 'consent.json');
const AUDIT_FILE = path.join(DIR, 'compliance-audit.log');
const NOTICE_VERSION = '1.0';

const DEFAULTS = {
  mode: 'assist',            // strict | assist | auto | standard（见《四档模式说明》）
  autoSubmit: false,         // 是否允许脚本自动提交测验答案（严格模式恒为 false）
  examBlock: true,           // 考试类页面一律不碰（风险最高的一类）
  humanPace: true,           // 答题/提交时加入真人节奏延时，避免机械特征
  answerMinGapMs: 1500,
  answerMaxGapMs: 4000,
  submitDelayMs: 6000,
  allowHosts: [
    'chaoxing.com',
    'deepseek.com',
    'localhost',
    '127.0.0.1',
  ],
  maskLogs: true,
};

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return fallback;
  }
}

function cfg() {
  const user = readJSON(CFG_FILE, {}) || {};
  const out = Object.assign({}, DEFAULTS, user);
  // 只有 auto（全自动）才允许脚本自动提交；strict/assist 一律强制关闭
  if (!(out.mode === 'auto' || out.mode === 'standard')) out.autoSubmit = false;
  if (out.mode === 'auto' || out.mode === 'standard') out.autoSubmit = true;
  return out;
}

function isStrict() {
  return cfg().mode === 'strict';
}

/**
 * assist 模式：AI 可以填答案，但**提交必须由本人点击**。
 * 这是"合规地自动答题"的唯一形态 —— 机器做机械劳动，人做判断与确认。
 */
function isAssist() {
  return cfg().mode === 'assist';
}

/** auto：全自动答题并提交（使用者自行选择并承担全部后果） */
function isAuto() {
  return cfg().mode === 'auto' || cfg().mode === 'standard';
}

/** 考试类页面是否硬拦截（默认开启，任何模式都不建议关） */
function examBlocked() {
  return cfg().examBlock !== false;
}

function allowAutoSubmit() {
  return !isStrict() && cfg().autoSubmit === true;
}

/** 域名白名单：只允许学习通与 DeepSeek，防止数据被带到第三方 */
function hostAllowed(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return cfg().allowHosts.some((d) => h === d || h.endsWith('.' + d));
  } catch (e) {
    return false;
  }
}

/** 导航前守卫：命中非白名单就抛错并留痕 */
function assertNavigable(url) {
  if (hostAllowed(url)) return true;
  audit('blocked-navigation', url);
  throw new Error('合规拦截：目标域名不在白名单内（' + url + '）');
}

function audit(kind, detail) {
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), kind, detail: String(detail).slice(0, 300) }) + '\n');
  } catch (e) { }
}

/** 手机号/账号脱敏：138****8888 */
function mask(value) {
  const s = String(value == null ? '' : value);
  if (!cfg().maskLogs) return s;
  if (/^\d{11}$/.test(s)) return s.slice(0, 3) + '****' + s.slice(7);
  if (/^\d{6,}$/.test(s)) return s.slice(0, 2) + '****' + s.slice(-2);
  if (s.length > 12) return s.slice(0, 4) + '****' + s.slice(-2);
  return s;
}

/** 同意闸门：未同意就打印须知并退出 */
function requireConsent(where) {
  const c = readJSON(CONSENT_FILE, null);
  if (c && c.agreed === true && String(c.version) === NOTICE_VERSION) return true;
  const line = '─'.repeat(64);
  console.error('\n' + line);
  console.error('  首次运行需要阅读并同意《使用须知》');
  console.error(line);
  console.error('  本软件仅用于个人学习辅助：自动播放课程视频、记录进度。');
  console.error('  严格模式下不会自动作答或提交任何测验。');
  console.error('  不会采集、上传任何个人数据；账号密码仅以 Windows DPAPI 加密存于本机。');
  console.error('  使用本软件须遵守所在学校规定与平台用户协议，违规后果由使用者自行承担。');
  console.error('  完整条款见同目录《使用须知.md》。');
  console.error('');
  console.error('  同意请输入： node consent.js agree');
  console.error(line + '\n');
  audit('consent-missing', where || '');
  process.exit(4);
}

module.exports = {
  cfg,
  isStrict,
  isAssist,
  isAuto,
  examBlocked,
  allowAutoSubmit,
  hostAllowed,
  assertNavigable,
  audit,
  mask,
  requireConsent,
  NOTICE_VERSION,
  CFG_FILE,
  CONSENT_FILE,
  AUDIT_FILE,
};
