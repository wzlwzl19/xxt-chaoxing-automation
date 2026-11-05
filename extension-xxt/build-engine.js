// build-engine.js —— 把原油猴脚本 + 扩展版 GM_* 兼容层拼成 engine.js
// 兼容层：键值走 localStorage（同步），网络走 postMessage → content.js → background（无 CORS）
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'xuexitong-deepseek.user.js');
const OUT = path.join(__dirname, 'engine.js');

const shim = `/* ===== 扩展版 GM_* 兼容层 ===== */
(function(){
  var P = 'xxt_ext_';
  window.GM_getValue = function(k, def){
    try { var v = localStorage.getItem(P + k); return v === null ? def : JSON.parse(v); } catch(e){ return def; }
  };
  window.GM_setValue = function(k, v){
    try { localStorage.setItem(P + k, JSON.stringify(v === undefined ? null : v)); } catch(e){}
  };
  window.GM_deleteValue = function(k){ try { localStorage.removeItem(P + k); } catch(e){} };
  window.GM_listValues = function(){
    var out = [];
    try { for (var i = 0; i < localStorage.length; i++){ var k = localStorage.key(i); if (k && k.indexOf(P) === 0) out.push(k.slice(P.length)); } } catch(e){}
    return out;
  };
  window.GM_registerMenuCommand = function(){};
  window.unsafeWindow = window;

  var seq = 0, waiting = {};
  window.addEventListener('message', function(ev){
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || !d.__xtGm) return;
    var cb = waiting[d.__xtGm];
    if (!cb) return;
    delete waiting[d.__xtGm];
    if (d.res && d.res.ok) { try { cb.onload && cb.onload(d.res.value); } catch(e){} }
    else { try { cb.onerror && cb.onerror(d.res || { error: 'bridge failed' }); } catch(e){} }
  });

  window.GM_xmlhttpRequest = function(details){
    details = details || {};
    var id = 'r' + (++seq) + '_' + Math.random().toString(36).slice(2);
    waiting[id] = details;
    if (details.timeout) {
      setTimeout(function(){ if (waiting[id]) { var c = waiting[id]; delete waiting[id]; try { c.ontimeout && c.ontimeout({}); } catch(e){} } }, details.timeout);
    }
    window.postMessage({
      __xtGmReq: id,
      url: details.url,
      method: details.method || 'GET',
      headers: details.headers || {},
      data: details.data === undefined ? null : details.data
    }, '*');
    return { abort: function(){ var c = waiting[id]; delete waiting[id]; try { c && c.onabort && c.onabort({}); } catch(e){} } };
  };
})();
/* ===== 原脚本开始 ===== */
`;

const src = fs.readFileSync(SRC, 'utf8');
fs.writeFileSync(OUT, shim + src, 'utf8');
console.log('engine.js 生成完成：' + fs.statSync(OUT).size + ' 字节');
