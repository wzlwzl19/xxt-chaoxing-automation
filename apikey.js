// 把 DeepSeek API Key 统一种到页面 localStorage 里。
// 背景：脚本把 key 存在 localStorage['xxt_dpx_apiKey']（JSON 字符串），
// 而 localStorage 是「按 origin + 按浏览器 profile」隔离的：
//   · 每个刷课窗口是独立 profile → 新窗口里没有 key
//   · mooc1.chaoxing.com / mooc2-ans.chaoxing.com 是两个 origin → 各存一份
// 所以以前会出现「有时能读到、有时要重输」。这里改成：
//   apikey.txt 为唯一真源，任何时候发现当前 origin 没有 key 就补进去。

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const KEY_FILE = path.join(DIR, 'apikey.txt');
const LS_KEY = 'xxt_dpx_apiKey';

function readKey() {
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
    return /^sk-[A-Za-z0-9]{16,}$/.test(raw) ? raw : '';
  } catch (e) {
    return '';
  }
}

function saveKey(key) {
  fs.writeFileSync(KEY_FILE, String(key || '').trim(), 'utf8');
}

// 返回 'ok' 已有 / 'seeded' 刚写入 / 'no-key' 没有 key / 'no-ls' 页面不是可写 origin
async function seedKey(s) {
  const key = readKey();
  if (!key) return 'no-key';
  try {
    const cur = await s.eval(`(function(){try{var v=localStorage.getItem(${JSON.stringify(LS_KEY)});if(!v)return '';try{return JSON.parse(v)||''}catch(e){return String(v)}}catch(e){return null}})()`, {}, 8000);
    if (cur === null) return 'no-ls';
    if (cur === key) return 'ok';
    await s.eval(`(function(){try{localStorage.setItem(${JSON.stringify(LS_KEY)},JSON.stringify(${JSON.stringify(key)}));return true}catch(e){return false}})()`, {}, 8000);
    const back = await s.eval(`(function(){try{return JSON.parse(localStorage.getItem(${JSON.stringify(LS_KEY)}))||''}catch(e){return ''}})()`, {}, 8000);
    return back === key ? 'seeded' : 'failed';
  } catch (e) {
    return 'failed';
  }
}

module.exports = { readKey, saveKey, seedKey, KEY_FILE, LS_KEY };
