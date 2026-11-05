/* 学习通刷课 · DSH 左侧栏面板 —— 纯原生 JS，挂一个 Shadow DOM，不污染宿主样式 */
(function () {
  'use strict';
  if (window.__xxtPanelMounted) return;
  window.__xxtPanelMounted = true;

  var API = '/xxt-panel/api';

  // 背景图：粉色小猪抱枕（内联 data URI，离线可用）
  var BG = '';
  var POLL_MS = 2000;

  // ===== 版本配置（由 build-panels.js 改写这一行生成 A/B/C 三套面板）=====
  var VER = {"key":"c","title":"C 版 · 一机六号","maxSlots":6,"showCount":true,"countLabel":"账号数量（最多六台）","hint":"1~6 个窗口，每窗一个账号、各自独立登录"};

  var CSS = [
    ":host,*{box-sizing:border-box}",
    ".fab{position:fixed;left:10px;bottom:118px;z-index:2147483001;width:46px;height:46px;border-radius:15px;",
    "background:linear-gradient(160deg,#ffb3cc,#f27ba4);border:1px solid rgba(255,255,255,.75);color:#fff;",
    "display:flex;align-items:center;justify-content:center;cursor:pointer;",
    "box-shadow:0 8px 22px rgba(226,110,150,.42),inset 0 1px 0 rgba(255,255,255,.6);",
    "transition:transform .15s ease,box-shadow .15s ease;font:600 17px/1 system-ui;position:fixed}",
    ".fab:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(226,110,150,.55)}",
    ".fab.run{background:linear-gradient(160deg,#8fe0b4,#48bd85);border-color:rgba(255,255,255,.8)}",
    ".fab .dot{position:absolute;right:-3px;top:-3px;width:11px;height:11px;border-radius:50%;background:#fff;",
    "border:2px solid #f27ba4;display:none}",
    ".fab.run .dot{display:block;background:#35c47a;border-color:#eafff3;animation:pulse 1.6s infinite}",
    "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}",
    ".drawer{position:fixed;left:64px;bottom:118px;z-index:2147483002;width:436px;max-height:74vh;",
    "display:none;flex-direction:column;border-radius:18px;overflow:hidden;",
    "background-image:linear-gradient(180deg,rgba(255,247,251,.34),rgba(255,232,242,.58)),url(__BG__);",
    "background-size:cover;background-position:center;background-repeat:no-repeat,no-repeat;",
    "border:1px solid rgba(255,255,255,.95);",
    "box-shadow:0 20px 54px rgba(180,120,150,.35),inset 0 2px 0 rgba(255,255,255,.9);",
    "color:#61505a;font:13px/1.5 system-ui,\"Segoe UI\",\"Microsoft YaHei\"}",
    ".drawer.open{display:flex}",
    ".hd{display:flex;align-items:center;gap:8px;padding:12px 14px;",
    "border-bottom:1px solid rgba(255,190,214,.55);background:rgba(255,255,255,.62)}",
    ".hd b{font-size:13px;font-weight:700;letter-spacing:.3px;color:#b1567f}",
    ".hd .st{margin-left:auto;font-size:11px;color:#ad8b9b}",
    ".hd .x{cursor:pointer;color:#c49aa9;font-size:16px;padding:0 4px;line-height:1}",
    ".hd .x:hover{color:#b1567f}",
    ".bd{padding:12px 14px;overflow:auto}",
    ".fld{margin-bottom:9px}",
    ".fld label{display:block;font-size:11px;color:#a4818f;margin-bottom:4px;font-weight:600}",
    ".fld input{width:100%;padding:8px 10px;border-radius:10px;border:1px solid #f4d2e0;",
    "background:rgba(255,255,255,.92);color:#5f4b55;font:13px/1.4 inherit;outline:none;",
    "box-shadow:inset 0 1px 2px rgba(200,150,175,.12);transition:border-color .15s,box-shadow .15s}",
    ".fld input::placeholder{color:#c9aebb}",
    ".fld input:focus{border-color:#f79ab8;box-shadow:0 0 0 3px rgba(247,154,184,.25)}",
    ".row{display:flex;gap:8px;margin-top:10px}",
    "button{flex:1;padding:9px 10px;border-radius:11px;border:1px solid transparent;cursor:pointer;",
    "font:600 13px/1 inherit;transition:filter .15s,transform .1s}",
    "button:hover{filter:brightness(1.06)}",
    "button:active{transform:translateY(1px)}",
    "button:disabled{opacity:.5;cursor:not-allowed;filter:none}",
    "#start{background:linear-gradient(180deg,#ff9dbd,#ef6f9c);color:#fff;",
    "box-shadow:0 4px 12px rgba(239,111,156,.38),inset 0 1px 0 rgba(255,255,255,.55)}",
    "#stop{background:rgba(255,255,255,.85);color:#8a6c79;border-color:#f0cadb}",
    ".ghost{background:rgba(255,255,255,.55);color:#a4818f;border:1px solid #f0cadb;margin-top:8px;width:100%}",
    ".card{margin-top:12px;padding:10px 12px;border-radius:12px;",
    "background:rgba(255,255,255,.74);border:1px solid rgba(255,255,255,.95);",
    "box-shadow:0 2px 10px rgba(190,140,165,.14)}",
    ".card .k{display:flex;justify-content:space-between;font-size:11px;color:#a4818f;margin-bottom:6px}",
    ".card .v{font-size:12px;color:#5f4b55;word-break:break-all}",
    ".card .v.face{color:#c07a2e}",
    ".card .v.slots{color:#8a6c79;font-size:11px}",
    ".bar{height:6px;border-radius:4px;background:rgba(255,214,229,.8);overflow:hidden;margin-top:8px}",
    ".bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ffb3cc,#f27ba4);transition:width .4s}",
    ".log{margin-top:10px;max-height:150px;overflow:auto;background:rgba(255,255,255,.68);",
    "border:1px solid rgba(255,200,222,.7);border-radius:11px;padding:8px 10px;",
    "font:11px/1.65 ui-monospace,Consolas,monospace;color:#7a6670;white-space:pre-wrap}",
    ".log b{color:#b395a1;font-weight:400}",
    ".tip{font-size:11px;color:#a4818f;margin-top:8px}",
    ".hint{font-size:10.5px;color:#b092a0;margin:-4px 0 10px;line-height:1.45}",
    ".err{color:#d1436b}",
    ".rows{margin:0 0 10px}",
    ".srow{display:flex;align-items:center;gap:5px;margin-bottom:5px}",
    ".stagn{flex:0 0 17px;height:17px;border-radius:9px;background:#ffd9e6;color:#b1567f;",
    "font:700 9.5px/17px system-ui;text-align:center}",
    ".srow input{flex:1 1 0;min-width:0;padding:6px 7px;border-radius:9px;border:1px solid #f4d2e0;",
    "background:rgba(255,255,255,.92);color:#5f4b55;font:11.5px/1.2 system-ui;outline:none}",
    ".srow input::placeholder{color:#c9aebb}",
    ".srow input:focus{border-color:#f79ab8;box-shadow:0 0 0 3px rgba(247,154,184,.22)}",
    ".srow .sphone{flex:0 0 100px}",
    ".srow .spass{flex:0 0 84px}",
    ".bd::-webkit-scrollbar,.log::-webkit-scrollbar{width:8px}",
    ".bd::-webkit-scrollbar-thumb,.log::-webkit-scrollbar-thumb{background:rgba(240,180,205,.85);border-radius:4px}",
    ".bd::-webkit-scrollbar-track,.log::-webkit-scrollbar-track{background:transparent}",
  ].join('').replace('__BG__', BG);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function mount() {
    var host = document.createElement('div');
    host.id = 'xxt-panel-host';
    host.style.cssText = 'position:fixed;inset:auto auto 0 0;width:0;height:0;z-index:2147483000';
    var root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    var fab = el('div', 'fab', '▶');
    fab.title = '学习通刷课';
    var dot = el('span', 'dot');
    fab.appendChild(dot);

    var drawer = el('div', 'drawer');
    var hd = el('div', 'hd');
    hd.appendChild(el('b', null, '学习通刷课 · ' + VER.title));
    var hdSt = el('span', 'st', '待机');
    hd.appendChild(hdSt);
    var close = el('span', 'x', '×');
    hd.appendChild(close);

    var bd = el('div', 'bd');

    function field(labelText, inputEl) {
      var f = el('div', 'fld');
      var lb = el('label', null, labelText);
      f.appendChild(lb);
      f.appendChild(inputEl);
      bd.appendChild(f);
      return inputEl;
    }

    // 账号数量：A 版固定 1 行（不显示）；B/C 版可 1~N 行
    var inpCount = el('input');
    inpCount.type = 'number';
    inpCount.value = '1';
    inpCount.min = '1';
    inpCount.max = String(VER.maxSlots);
    if (VER.showCount) {
      field(VER.countLabel, inpCount);
    } else {
      inpCount.value = '1';
      inpCount.style.display = 'none';
    }
    var countHint = el('div', 'hint', VER.hint);
    bd.appendChild(countHint);

    var inpMax = el('input');
    inpMax.type = 'number';
    inpMax.value = '0';
    inpMax.min = '0';
    field('每门课最多几节（0 = 全部）', inpMax);

    // 每个账号一行：用户号码 + 只刷这门课（一行一个账号，改数量就增减行）
    var rowsBox = el('div', 'rows');
    bd.appendChild(rowsBox);
    var slotRows = [];

    function renderRows(n) {
      var keep = slotRows.map(function (r) { return { phone: r.phone.value, pass: r.pass.value, course: r.course.value }; });
      rowsBox.innerHTML = '';
      slotRows = [];
      for (var i = 0; i < n; i++) {
        var rowEl = el('div', 'srow');
        var tag = el('span', 'stagn', String(i + 1));
        var ph = el('input');
        ph.type = 'tel';
        ph.autocomplete = 'off';
        ph.spellcheck = false;
        ph.placeholder = '用户号码';
        ph.className = 'sphone';
        var pw = el('input');
        pw.type = 'password';
        pw.autocomplete = 'new-password';
        pw.spellcheck = false;
        pw.placeholder = '密码';
        pw.className = 'spass';
        var cr = el('input');
        cr.placeholder = '只刷这门课（空=全部）';
        cr.className = 'scourse';
        if (keep[i]) { ph.value = keep[i].phone; pw.value = keep[i].pass; cr.value = keep[i].course; }
        rowEl.appendChild(tag);
        rowEl.appendChild(ph);
        rowEl.appendChild(pw);
        rowEl.appendChild(cr);
        rowsBox.appendChild(rowEl);
        slotRows.push({ phone: ph, pass: pw, course: cr });
      }
    }

    // writeBack=false：输入过程中只按当前值渲染，不回写输入框（回写会抢光标，打字变成「输什么都变同一个数」）
    function readCount(writeBack) {
      var n = VER.showCount ? parseInt(inpCount.value, 10) : 1;
      if (!isFinite(n)) n = 1;
      if (n < 1) n = 1;
      if (n > VER.maxSlots) n = VER.maxSlots;
      if (writeBack) inpCount.value = String(n);
      return n;
    }

    renderRows(1);
    inpCount.addEventListener('input', function () { renderRows(readCount(false)); });
    inpCount.addEventListener('change', function () { renderRows(readCount(true)); });
    inpCount.addEventListener('blur', function () { renderRows(readCount(true)); });

    var row = el('div', 'row');
    var btnStart = el('button', null, '开始');
    btnStart.id = 'start';
    var btnStop = el('button', null, '停止');
    btnStop.id = 'stop';
    row.appendChild(btnStart);
    row.appendChild(btnStop);
    bd.appendChild(row);

    var btnOpen = el('button', 'ghost', '只打开学习通（先手动登录）');
    bd.appendChild(btnOpen);

    var card = el('div', 'card');
    var k1 = el('div', 'k');
    k1.appendChild(el('span', null, '状态'));
    var vState = el('span', null, '—');
    k1.appendChild(vState);
    card.appendChild(k1);
    var vCourse = el('div', 'v', '课程 —');
    card.appendChild(vCourse);
    var vChapter = el('div', 'v', '章节 —');
    card.appendChild(vChapter);
    var vFace = el('div', 'v face', '人脸校验 —');
    vFace.style.display = 'none';
    card.appendChild(vFace);
    var vSlots = el('div', 'v slots', '');
    vSlots.style.display = 'none';
    card.appendChild(vSlots);
    var bar = el('div', 'bar');
    var barFill = el('i');
    bar.appendChild(barFill);
    card.appendChild(bar);
    bd.appendChild(card);

    var logBox = el('div', 'log');
    bd.appendChild(logBox);

    var tip = el('div', 'tip', '');
    bd.appendChild(tip);

    drawer.appendChild(hd);
    drawer.appendChild(bd);
    root.appendChild(fab);
    root.appendChild(drawer);
    document.body.appendChild(host);

    // —— 交互 ——
    var open = false;
    function toggle(v) {
      open = v == null ? !open : !!v;
      drawer.classList.toggle('open', open);
      if (open) pull(true);
    }
    fab.addEventListener('click', function () { toggle(); });
    close.addEventListener('click', function () { toggle(false); });

    function setRunning(on) {
      fab.classList.toggle('run', !!on);
      btnStart.disabled = !!on;
      btnStop.disabled = !on;
    }

    btnStart.addEventListener('click', function () {
      // 面板不保存任何账号密码：点「开始」= 打开浏览器登录页，由用户自己输入
      var n = readCount(true);
      renderRows(n);
      var slots = slotRows.map(function (r) {
        return {
          phone: String(r.phone.value || '').replace(/\s/g, ''),
          pass: String(r.pass.value || ''),
          course: String(r.course.value || '').trim(),
        };
      });
      btnStart.disabled = true;
      var autoN = slots.filter(function (x) { return x.phone && x.pass; }).length;
      flash(n > 1
        ? ('正在打开 ' + n + ' 个窗口' + (autoN ? '，其中 ' + autoN + ' 个自动填账号密码' : '，请在每个窗口分别登录') + '…')
        : (autoN ? '正在打开浏览器并自动填入账号密码…' : '正在打开浏览器登录页，请在窗口里手动输入账号密码…'));
      fetch(API + '/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slots: slots,
          // 提交后清掉号码与密码，防止同一批旧号码被反复点「开始」重复提交
          clearRowsAfterStart: true,
          maxChapters: parseInt(inpMax.value, 10) || 0,
          count: n,
          version: VER.key,
        }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) { flash(j.error || '启动失败', true); btnStart.disabled = false; }
        else {
          // 启动成功后清掉每行的号码与密码，避免这批旧号码被再次提交
          slotRows.forEach(function (r2) { r2.phone.value = ''; r2.pass.value = ''; });
          flash('已启动，正在打开浏览器');
          pull(true);
        }
      }).catch(function (e) {
        flash('连不上后台：' + e.message, true);
        btnStart.disabled = false;
      });
    });

    btnStop.addEventListener('click', function () {
      flash('正在停止…');
      fetch(API + '/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function () { flash('已停止'); pull(true); })
        .catch(function (e) { flash('停止失败：' + e.message, true); });
    });

    btnOpen.addEventListener('click', function () {
      fetch(API + '/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (j) { flash(j.ok ? '已打开学习通' : (j.error || '打开失败'), !j.ok); });
    });

    var flashTimer = 0;
    function flash(msg, isErr) {
      tip.textContent = msg;
      tip.className = 'tip' + (isErr ? ' err' : '');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(function () { tip.textContent = ''; }, 6000);
    }

    // —— 状态轮询 ——
    var lastSeq = 0;
    var lastLines = [];

    function renderLog(lines) {
      if (!lines || !lines.length) return;
      for (var i = 0; i < lines.length; i++) lastLines.push(lines[i]);
      if (lastLines.length > 200) lastLines = lastLines.slice(-200);
      var frag = document.createDocumentFragment();
      for (var k = 0; k < lastLines.length; k++) {
        var ln = lastLines[k];
        var d = document.createElement('div');
        var b = document.createElement('b');
        b.textContent = ln.t + ' ';
        d.appendChild(b);
        d.appendChild(document.createTextNode(ln.m));
        if (ln.l === 'err') d.className = 'err';
        frag.appendChild(d);
      }
      logBox.textContent = '';
      logBox.appendChild(frag);
      logBox.scrollTop = logBox.scrollHeight;
    }

    function pull(force) {
      fetch(API + '/status').then(function (r) { return r.json(); }).then(function (s) {        setRunning(!!s.running);
        hdSt.textContent = s.running ? '运行中' : (s.phase === 'done' ? '已完成' : (s.phase === 'error' ? '已停止' : '待机'));
        vState.textContent = s.note || s.phase || '—';
        vState.className = s.phase === 'error' ? 'err' : '';
        vCourse.textContent = '课程 ' + (s.course || '—');
        vChapter.textContent = '章节 ' + (s.chapter || '—') + (s.count > 1 ? ' · ' + s.count + ' 个窗口' : '');
        // 多窗口：逐窗口显示绑定情况，方便一眼看出哪个窗口是谁（防串号的可见性保证）
        if (s.slots && s.slots.length > 1) {
          var txt = s.slots.map(function (x) {
            return 'slot' + x.slot + ' ' + (x.phone || '未指定') + (x.state && x.state !== '已绑定' ? '（' + x.state + '）' : '');
          }).join(' | ');
          vSlots.style.display = '';
          vSlots.textContent = txt;
        } else {
          vSlots.style.display = 'none';
        }
        // 人脸校验：只在发生过时显示，避免平时占位
        if (s.face && (s.face.seen > 0 || s.face.last)) {
          vFace.style.display = '';
          vFace.textContent = (s.face.seen > 0 ? '⚠ 人脸校验弹窗 ×' + s.face.seen + ' · ' : '✓ 人脸校验 · ') + (s.face.last || '');
          vFace.style.color = s.face.seen > 0 ? '#ffb454' : '';
        } else {
          vFace.style.display = 'none';
        }
        barFill.style.width = Math.max(0, Math.min(100, s.percent || 0)) + '%';
        // 日志不在这里补 tail：下面 /log?since=0 会拉全量，这里补了会重复显示
      }).catch(function () {
        hdSt.textContent = '后台未连接';
      });

      fetch(API + '/log?since=' + lastSeq).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.ok && j.lines && j.lines.length) {
          renderLog(j.lines);
          lastSeq = j.last || lastSeq;
        }
      }).catch(function () { });
    }

    pull(true);
    setInterval(function () { if (document.visibilityState !== 'hidden') pull(false); }, POLL_MS);

    // 拉一次已存账号数量，用于窗口数量提示
    fetch(API + '/accounts').then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) { window.__xxtSavedAccounts = j.accounts || []; pull(true); }
    }).catch(function () { });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
