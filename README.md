# XXT —— 超星学习通 学习自动化工具

> 在**你自己的电脑**上，用 Chrome DevTools Protocol 驱动**你自己**的浏览器，完成课程视频的连续播放、章节测验的作答与提交。
>
> 本仓库是 MIT 开源的**学习/研究用**实现，包含一套完整可运行的自动化编排层，以及围绕它做的合规控制（域名白名单、考试页拦截、真人节奏、同意流程、日志脱敏）。

---

## ⚠️ 使用前必读（请认真看完这 6 条）

1. **本项目仅供学习浏览器自动化技术使用。** 是否使用、如何使用、后果如何，由使用者自行判断并承担。
2. **可能违反平台用户协议与学校学术诚信规定。** 借用自动化代替本人学习，多数高校明令禁止，最重可致处分。
3. **不参与任何考试。** 代码内硬编码拦截"考试/期末/期中/补考/试卷"页面，命中即跳过。请不要修改这一层。
4. **不破解、不伪造、不侵入。** 全程只做三件事：播放、点击、填值。不修改服务器数据、不伪造学习时长、不识别验证码、不代过人脸。
5. **仅限本人账号。** 不要把本工具用于他人账号，也不要代人刷课。
6. **无任何担保。** 见 `LICENSE` 的免责条款。

如果你不接受以上任何一条，请立刻停止使用并删除本仓库。

---

## 功能一览

| 能力 | 说明 |
|---|---|
| 自动登录 | 支持手动登录（推荐）或本机 DPAPI 加密存档自动登录；不会把密码写进任何日志 |
| 自动进课 | 从课程列表进入指定课程，自动定位未完成节点（支持课程名模糊匹配） |
| 连续播放 | 2.0x 倍速上限、跨 iframe 强推播放、播完自动跳节、无播放器自动跳过 |
| 章节测验 | 四档：`strict`（只播放）/ `assist`（AI 填答案，本人点提交）/ **`auto`（默认，AI 作答并提交）** / `standard` |
| 字体反爬 | 解析页面自定义字体的 `cmap` 表还原被替换的题目文字 |
| 风控熔断 | 7 类信号（验证码、风控文案、登录墙、答题失败、播放失败、倍速异常、视频卡死）加权计分，达阈值自动停机并锁定 |
| 最小化运行 | 页面遮挡/最小化时保持渲染与焦点，播放不中断 |
| 多账号 | A 版 1 号 / B 版 3 号 / C 版 6 号，每个窗口独立 profile、独立密码库、独立端口 |
| 防串号 | 窗口 ↔ 账号双向绑定，登录后校验真实 uid，不一致立即停机 |
| 三套界面 | DSH 侧栏面板 / Edge 扩展侧栏 / 页面内悬浮面板 |
| 夜间静默 | 默认 02:30–06:30 自动暂停 |
| 日志与清理 | 日志滚动截断、临时文件清理、内存回收 |

---

## 快速开始（Windows）

### 1. 环境

- Windows 10/11
- [Node.js](https://nodejs.org/) ≥ 20（开发时用 v26）
- Microsoft Edge（推荐）或 Chrome

### 2. 安装依赖

本项目**零 npm 依赖**（`pack-bytecode.js` 用到时可选的 `bytenode`）。直接运行即可。

### 3. 首次运行

```bat
:: 双击，或命令行执行
启动自动刷课.cmd
```

首次会提示阅读并同意 `使用须知.md`：

```bat
node consent.js agree
```

然后：

1. 浏览器会打开学习通登录页；
2. 你在窗口里手动输入账号密码（推荐，不需要把密码交给程序）；
3. 登录成功后，程序自动接管：进课程 → 播放 → 测验 → 下一节。

### 4. 配置 API Key（答题需要）

把 DeepSeek API Key 写入 `apikey.txt`（一行，纯文本）：

```
sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

或在页面悬浮面板里粘贴保存。Key 只在本机使用，只发往 `api.deepseek.com`。

---

## 配置说明（`compliance.json`）

```json
{
  "mode": "auto",
  "autoSubmit": true,
  "examBlock": true,
  "humanPace": true,
  "answerMinGapMs": 1500,
  "answerMaxGapMs": 4000,
  "submitDelayMs": 6000,
  "allowHosts": ["chaoxing.com", "deepseek.com", "localhost", "127.0.0.1"],
  "maskLogs": true
}
```

| 字段 | 作用 |
|---|---|
| `mode` | `strict` / `assist` / `auto` / `standard`，见上表 |
| `autoSubmit` | 是否允许程序点"提交"；`strict`/`assist` 会强制为 `false` |
| `examBlock` | **建议永远保持 true**：考试类页面硬拦截 |
| `humanPace` | 选项点击与提交前插入随机延时，降低机械特征 |
| `allowHosts` | 域名白名单，任何其他地址的导航都会被拒绝 |
| `maskLogs` | 日志中手机号脱敏为 `138****8888` |

`config.json` 控制运行参数：倍速、章节间隔、休息节奏、单次时长上限、夜间静默窗口等。

---

## 架构

```
┌───────────────────────────── 你的电脑 ─────────────────────────────┐
│                                                                    │
│  启动器 .cmd                                                       │
│      │                                                             │
│      ├─▶ autopilot.js      编排：登录→课程→章节→播放→测验→跳节      │
│      │        │                                                    │
│      │        ├─▶ cdpkit.js  CDP 客户端（浏览器控制、跨 iframe 求值）│
│      │        ├─▶ guard.js   风控信号计分与熔断                     │
│      │        ├─▶ sentinel.js 运行前自检 / 登录后审计 / 心跳        │
│      │        ├─▶ compliance.js 合规闸门（同意、白名单、审计）       │
│      │        ├─▶ pace.js    真人节奏层（延时注入）                  │
│      │        └─▶ apikey.js  答题 Key 注入                         │
│      │                                                             │
│      ├─▶ xxt-bridge.js     本地 HTTP 服务（:9333），供界面调用       │
│      ├─▶ nanny.js          守护：防休眠、崩溃拉活（不抢浏览器）       │
│      └─▶ multi.js          多账号调度（每号独立 profile/端口/密码库） │
│                                                                    │
│  界面：dsh-plugin（DSH 侧栏） / extension-xxt（Edge 扩展） / 页面悬浮窗│
└────────────────────────────────────────────────────────────────────┘
```

模块职责：

| 文件 | 职责 |
|---|---|
| `autopilot.js` | 主编排循环（最大单体，约 60 KB） |
| `multi.js` | 多窗口调度、profile 隔离、换号清档 |
| `xxt-bridge.js` | 本地 API（`/start` `/stop` `/status` `/log` `/version`） |
| `nanny.js` | 守护进程：保持唤醒、单实例、崩溃恢复 |
| `guard.js` | 风控信号计分器 |
| `sentinel.js` | 自检 / 登录审计 / 运行时心跳 |
| `compliance.js` | 同意、白名单、审计日志、脱敏 |
| `pace.js` | 点击延时注入 |
| `binding.js` | 窗口 ↔ 账号绑定 |
| `vault.js` | Windows DPAPI 密码保管 |
| `license.js` | 发布包的 Ed25519 授权校验（**无 `plan.json` 时自动跳过，即开源/dev 模式**） |
| `preflight.js` | 只读体检脚本 |
| `switch-version.js` | A/B/C 三版本切换 |
| `pack-release.js` / `pack-bytecode.js` | 出包 / 字节码编译 |

---

## 版本

| 版本 | 账号上限 | 说明 |
|---|---|---|
| A | 1 | 单机单号 |
| B | 3 | 最多三窗口 |
| C | 6 | 最多六窗口 |

```bat
node switch-version.js c   :: 切换面板版本
```

---

## 界面

- **DSH 侧栏**：`node install-dsh-plugin.js` 安装到 DeepSeek Harness，重启后在侧栏打开。
- **Edge 扩展**：`edge://extensions/` → 开发者模式 → 加载已解压的扩展 → 选择 `extension-xxt`。
- **页面悬浮窗**：脚本注入后自动出现，可拖动。

三处界面共用同一份配置与状态。

---

## 已知边界

- 平台若强制要求**手机 APP 扫码/人脸核验**，网页端无法绕过——这是设计上的硬约束，本项目不做模拟。
- AI 答案不保证正确。
- 平台规则可能随时变化，熔断只能降低暴露面，不能保证零检测。
- 抖音式"全自动代刷"宣传请勿使用；`宣传禁词表.md` 有对照。

---

## 致谢

- 上游：[`aajddjkfkfke/xuexitong-zidong-shuake-jiaoben`](https://github.com/aajddjkfkfke/xuexitong-zidong-shuake-jiaoben)（MIT）—— 提供了页面侧播放、字体解码、DeepSeek 作答的原始实现。
- 字体反爬解码思路参考社区公开讨论。
- 第三方许可全文见 `THIRD-PARTY-NOTICES.md`。

---

## 许可

MIT，见 [`LICENSE`](LICENSE)。使用时请保留原始版权声明。
