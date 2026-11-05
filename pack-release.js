'use strict';
/**
 * 出包：把成品打成三个可交付版本（A / B / C）
 * 只复制运行所需文件，开发脚本、日志、浏览器 profile、私钥一律不进包
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
// 合规：不随包分发人脸提交能力（不代替本人完成身份核验）
const SKIP_FILES = new Set(['faceflow.js', 'faceflow.jsc', 'faceapi.js', 'faceapi.jsc', 'test-submit-guard.js', 'md2pdf.js', '_patch1.js', '_patch2.js', '_patch3.js', '_patch4.js', '_patch5.js', '_patch6.js', '_patch7.js']);
const VER = '1.2.2';

const PLANS = {
  a: { plan: 'a', title: 'A 版 · 一机一号', maxSlots: 1, note: '单账号，最稳最省，适合只刷自己一门课' },
  b: { plan: 'b', title: 'B 版 · 一机三号', maxSlots: 3, note: '最多 3 个账号并行，适合帮室友/小范围代刷' },
  c: { plan: 'c', title: 'C 版 · 一机六号', maxSlots: 6, note: '最多 6 个账号并行，适合工作室批量' },
};

// 运行必需（模块）
const JS = [
  'compliance.js',
  'consent.js',
  'autopilot.js', 'guard.js', 'sentinel.js', 'cdpkit.js', 'maintenance.js',
  'nanny.js', 'xxt-bridge.js', 'multi.js', 'accounts.js', 'vault.js',
  'setup.js', 'wait-login.js', 'save-cred.js', 'apikey.js', 'binding.js',
  'faceguard.js', 'facecheck.js', 'faceflow.js', 'license.js',
  'build-panels.js', 'switch-version.js', 'preflight.js',
  'xuexitong-console.js',
];

const CFG = ['config.json', 'selectors.json', 'version.json', 'face-config.json', 'upgrade-queue.json', 'compliance.json'];
const CMD = [
  '启动自动刷课.cmd', '多账号刷课.cmd', '版本切换.cmd',
  '清理内存与日志.cmd', '手动登录-任意账号.cmd', '安装DSH刷课插件.cmd',
];
const DOCS = ['三版本说明.md', '多账号说明.md', '人脸识别-使用说明.md', '使用须知.md', '使用须知.pdf', '合规审查报告.md', '合规审查报告.pdf', '法律红线清单.md', '风险评估-提交稿.md', '风险评估-提交稿.pdf', '法律红线清单.pdf', '原始代码合规审查.md', '宣传禁词表.md', 'LICENSE-上游-MIT.txt'];

function cp(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst, skip) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip.test(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyDir(s, d, skip);
    else { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); n++; }
  }
  return n;
}

const APPLY_CMD = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   ========== 授权申请 ==========
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] 没装 Node.js，请先安装 Node.js 18 或更高版本
  echo       下载：https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)
node license.js show
echo.
echo   把上面「本机机器码」那一行发给供应商，换取 license.key
echo   拿到后放到本目录（和这个文件同一层），再双击启动脚本
echo.
pause
`;

function buildDoc(plan) {
  const p = PLANS[plan];
  return `# 学习通自动刷课助手 · ${p.title}

> 版本 ${VER}　|　授权上限：**${p.maxSlots} 个账号**　|　操作系统：Windows 10 / 11

---

## 一、三分钟装好

1. **装 Node.js**（只需一次）
   打开 <https://nodejs.org/zh-cn/download>，下载 **LTS 版**，一路下一步装完。
   验证：按 「Win+R」 输入 「cmd」 回车，在黑窗口里敲 「node -v」，能看到 「v18」 及以上版本号即可。

2. **申请授权**
   双击 **「授权申请.cmd」**，窗口里会显示一行「本机机器码」。
   把这行机器码发给供应商，会收到一个 「license.key」 文件。
   把它放到**本文件夹根目录**（和 「授权申请.cmd」 同一层）。

3. **启动**
   双击 **「启动自动刷课.cmd」**。

4. **填账号**
   面板上「账号数量」填几，下面就出现几行：
   \`用户号码\` + \`密码\` + \`只刷这门课\`
   填好点 **开始** —— 程序会自动开浏览器、自动登录、自动进入课程、自动播放、自动答题、自动跳下一节。

---

## 二、面板长什么样

- 左侧栏 **▶** 悬浮按钮：点开是完整控制台（Dsh / 网页两种形态都支持）
- 学习通页面右上角：**粉色悬浮窗**（可拖动，「Alt+Shift+D」 恢复隐藏）
- 「账号数量」= 同时开几个窗口，每行填一个账号，互不干扰

---

## 三、日常怎么用

| 场景 | 操作 |
|---|---|
| 正常刷课 | 双击 「启动自动刷课.cmd」，填账号，点开始 |
| 多账号并行 | 「账号数量」填 2~${p.maxSlots}，逐行填账号 |
| 只想看看不动手 | 点「只打开学习通（先手动登录）」，自己登录后它会接管 |
| 换版本 | 双击 「版本切换.cmd」，选 A / B / C（需授权包含该版本） |
| 电脑卡 | 双击 「清理内存与日志.cmd」 |
| 夜间 | 默认 02:30–06:30 自动静默，不夜里刷，降低被关注概率 |

---

## 四、安全设定（默认已开，不用动）

- **倍速 2.0x**：平台自带档位，上报数据里不带倍速，实测安全
- **失焦保护**：最小化、切走窗口都照样播（已做焦点仿真）
- **风控熔断**：出现滑块/验证码/异常文案，立即停止并锁 60 分钟，绝不死磕
- **单实例锁**：同一窗口不会出现两个进程抢浏览器
- **人脸弹窗**：自动尝试关闭；连续 3 次关不掉就停下等你扫码，不会硬刷
- **登录态保护**：绝不主动强制登出，浏览器崩溃自动拉起并回原页面

---

## 五、常见问题

**Q：提示「授权校验未通过」？**
把窗口里那行「本机机器码」发给供应商。换电脑、重装系统、换主板都会变，属正常。

**Q：提示「手机号/超星号或密码错误」？**
账号密码本身不对，或被平台临时限制。先用浏览器手动登录一次确认，再回来跑。

**Q：视频不动？**
点面板上的「开始」；仍不动就「下一节」。

**Q：能刷多少？**
一个账号一节视频约 6–12 分钟（2x），144 节的课大概 5–6 小时刷完，中途每 45 分钟休息 10 分钟。

---

授权文件 「license.key」 与机器绑定，**请勿外传**。换机请联系供应商重新签发。
`;
}

function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  const results = [];

  for (const key of ['a', 'b', 'c']) {
    const p = PLANS[key];
    const name = `XXT-${key.toUpperCase()}-v${VER}`;
    const dir = path.join(DIST, name);
    fs.mkdirSync(dir, { recursive: true });

    let count = 0;
    for (const f of JS.concat(CFG, CMD, DOCS)) {
      // 合规：人脸提交能力不分发
      if (SKIP_FILES.has(path.basename(f))) { console.log('  合规跳过 ' + f); continue; }
      const s = path.join(ROOT, f);
      if (fs.existsSync(s)) { cp(s, path.join(dir, f)); count++; }
      else console.log('  缺少 ' + f);
    }
    count += copyDir(path.join(ROOT, 'extension-xxt'), path.join(dir, 'extension-xxt'), /\.(map|log)$/);
    count += copyDir(path.join(ROOT, 'dsh-plugin'), path.join(dir, 'dsh-plugin'), /node_modules/);
    count += copyDir(path.join(ROOT, 'assets'), path.join(dir, 'assets'), /source\.jpg$/);

    // 版本标识 + 客户文档
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ plan: p.plan, title: p.title, maxSlots: p.maxSlots, version: VER }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ key: p.plan, title: p.title, maxSlots: p.maxSlots, showCount: p.maxSlots > 1 }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, '使用说明.md'), buildDoc(key), 'utf8');
    fs.writeFileSync(path.join(dir, '授权申请.cmd'), APPLY_CMD.replace(/\r?\n/g, '\r\n'), 'utf8');
    // 空白 API Key 模板（客户自己填，不夹带我们的 key）
    fs.writeFileSync(path.join(dir, 'apikey.txt'), '', 'utf8');

    // 打包
    const zip = path.join(DIST, name + '.zip');
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zip}' -Force`], { timeout: 120000 });
    } catch (e) { console.log('  压缩失败：' + e.message); }

    const size = fs.existsSync(zip) ? (fs.statSync(zip).size / 1048576).toFixed(2) + ' MB' : '未生成';
    results.push({ 版本: p.title, 账号上限: p.maxSlots, 文件数: count, 压缩包: path.basename(zip), 大小: size });
  }

  console.log('\n===== 出包完成 =====');
  for (const r of results) console.log(`  ${r.版本}　账号上限 ${r.账号上限}　${r.文件数} 个文件　→ ${r.压缩包}（${r.大小}）`);
  console.log('  目录：' + DIST);
}

main();
