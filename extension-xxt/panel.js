// panel.js —— 侧边栏逻辑
const $ = (id) => document.getElementById(id);
const dot = $('dot');

let currentTabId = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isCoursePage(url) {
  return !!url && /chaoxing\.com\/(mycourse|mooc2-ans\/mycourse)\/studentstudy/.test(url);
}

function render(state) {
  const st = state || {};
  $('course').textContent = st.course || '—';
  $('chapter').textContent = st.chapter || '—';
  $('progress').textContent = st.progress || '—';

  // 进度条
  let pct = 0;
  const m = /(\d+):(\d+)\s*\/\s*(\d+):(\d+)/.exec(st.progress || '');
  if (m) {
    const cur = (+m[1]) * 60 + (+m[2]);
    const tot = (+m[3]) * 60 + (+m[4]);
    if (tot > 0) pct = Math.min(100, (cur / tot) * 100);
  }
  $('bar').style.width = pct.toFixed(1) + '%';

  if (st.running) {
    $('status').textContent = st.playing ? '运行中 · 视频播放' : '运行中';
    dot.className = 'dot run';
  } else if (st.injected) {
    $('status').textContent = st.playing ? '已就绪 · 视频在播' : '已就绪 · 待开始';
    dot.className = 'dot on';
  } else {
    $('status').textContent = '未连接（打开课程播放页）';
    dot.className = 'dot';
  }

  $('keyState').textContent = st.keySaved ? '已保存' : '未保存';
  $('keyState').style.color = st.keySaved ? 'var(--ok)' : 'var(--dim)';

  if (Array.isArray(st.logs) && st.logs.length) {
    const box = $('log');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    box.textContent = st.logs.join('\n');
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
}

async function pull() {
  try {
    const tab = await activeTab();
    if (!tab) return render({});
    currentTabId = tab.id;
    if (!isCoursePage(tab.url)) return render({ injected: false, url: tab.url });
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'collect' }).catch(() => null);
    if (resp && resp.state) render(resp.state);
    else render({});
  } catch (e) { render({}); }
}

async function send(action, extra) {
  const tab = await activeTab();
  if (!tab) return toast('没有活动标签页');
  if (!isCoursePage(tab.url)) return toast('当前页不是学习通课程播放页');
  const resp = await chrome.tabs.sendMessage(tab.id, { type: 'cmd', action, ...(extra || {}) }).catch((e) => ({ ok: false, error: String(e) }));
  if (resp && resp.ok === false) toast(resp.error || '操作失败');
  setTimeout(pull, 600);
}

function toast(msg) {
  $('status').textContent = msg;
  dot.className = 'dot err';
  setTimeout(pull, 1600);
}

$('start').onclick = () => send('start');
$('stop').onclick = () => send('stop');
$('next').onclick = () => send('next');
$('testKey').onclick = () => send('test');
$('clearLog').onclick = () => { $('log').textContent = ''; send('clear'); };
$('refresh').onclick = pull;

$('saveKey').onclick = async () => {
  const k = $('key').value.trim();
  if (!k) return toast('先填 Key');
  if (!/^sk-/.test(k)) return toast('Key 一般以 sk- 开头');
  await send('key', { key: k });
  $('key').value = '';
  toast('已保存');
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'state') {
    activeTab().then((tab) => {
      if (tab && msg.state && msg.state.url && msg.state.url === tab.url) render(msg.state);
    });
  }
});

pull();
setInterval(pull, 2500);
