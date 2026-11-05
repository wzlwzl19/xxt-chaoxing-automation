/**
 * pace.js —— 真人节奏层（仅 auto 模式启用）
 *
 * 目的：让"程序点击"在时间分布上接近真人操作，减少机械化特征。
 * 做法：在页面上下文里包装 HTMLElement.prototype.click 与
 *       HTMLInputElement/HTMLTextAreaElement 的 value setter 相关点击，
 *       对「选项 / 提交 / 交卷」类点击插入随机延时。
 *
 * 注意：这不会改变 isTrusted（浏览器安全属性改不了），
 *       只是把时间间隔打散；assist 模式下不启用本模块。
 */

const INSTALL_SRC = `(function(){
  if (window.__xxtPaced) return 'already';
  window.__xxtPaced = true;
  var origClick = HTMLElement.prototype.click;
  function rnd(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function label(el) {
    try {
      var t = (el.innerText || el.textContent || el.value || '') + '';
      if (!t && el.querySelector) t = (el.querySelector('*') && el.querySelector('*').innerText) || '';
      return t.replace(/\\s+/g, ' ').trim().slice(0, 40);
    } catch (e) { return ''; }
  }
  HTMLElement.prototype.click = function () {
    var self = this, txt = label(self);
    var isSubmit = /提交|交卷|保存并提交|确认提交/.test(txt);
    var isOption = /^(A|B|C|D|E|正确|错误|对|错)/.test(txt) ||
                   /(answer|option|choice|选题|ti-)?/i.test(self.className || '');
    if (isSubmit) {
      // 提交前停顿 3.5~7.5 秒（模拟人复核）
      var d1 = rnd(3500, 7500);
      console.log('[xxt-pace] 提交前停顿 ' + d1 + 'ms');
      setTimeout(function () { origClick.call(self); }, d1);
      return;
    }
    if (isOption) {
      // 选项之间 0.8~2.6 秒
      var d2 = rnd(800, 2600);
      setTimeout(function () { origClick.call(self); }, d2);
      return;
    }
    return origClick.call(self);
  };
  return 'ok';
})()`;

/** 在页面里安装真人节奏层 */
async function install(session) {
  try {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTALL_SRC });
  } catch (e) { /* ignore */ }
  try {
    return await session.eval(INSTALL_SRC, {}, 6000);
  } catch (e) {
    return 'err:' + e.message;
  }
}

module.exports = { install, INSTALL_SRC };
