# 交给 DSH 一键安装（复制粘贴版）

> 给不想手动折腾的人：**把下面任意一段贴进 DSH（或任何能执行命令的 AI 助手）对话框**，它就会自己装完。

---

## 方案一：一句话版（推荐）

直接复制这一整行发给 DSH：

```
帮我在这台 Windows 上装一个开源工具，全部由你执行、不要问我细节：运行 powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/wzlwzl19/xxt-chaoxing-automation/main/install-all.ps1 -OutFile $env:TEMP\xxt-install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\xxt-install.ps1" ，把输出贴给我；装完确认 %USERPROFILE%\XXT\autopilot.js 存在、node preflight.js 能跑通，然后告诉我怎么打开、第一次要做什么。
```

---

## 方案二：分步版（DSH 报错时用这个更稳）

```
请帮我在本机部署「XXT 学习通学习助手」，按顺序执行，每步把结果告诉我：

1) 检查 Node.js：执行 node -v。没有就执行 winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements，装完重开终端再验证。
2) 建目录：New-Item -ItemType Directory -Force "$env:USERPROFILE\XXT"
3) 下载：Invoke-WebRequest "https://codeload.github.com/wzlwzl19/xxt-chaoxing-automation/zip/refs/heads/main" -OutFile "$env:TEMP\xxt.zip" -UseBasicParsing
4) 解压：Expand-Archive "$env:TEMP\xxt.zip" -DestinationPath "$env:TEMP\xxtsrc" -Force，然后把 "$env:TEMP\xxtsrc\*\*" 里的内容全部复制到 "$env:USERPROFILE\XXT"
5) 授权同意：在 "$env:USERPROFILE\XXT" 里执行 node consent.js agree
6) 装面板插件：在 "$env:USERPROFILE\XXT" 里执行 node install-dsh-plugin.js
7) 体检：在 "$env:USERPROFILE\XXT" 里执行 node preflight.js，把不 OK 的项告诉我
8) 装完回答我三件事：装到哪个目录、怎么启动、第一次需要我做什么
```

---

## 方案三：无网络代理时的兜底

如果 `raw.githubusercontent.com` 拉不动：

```
我这边访问 GitHub 直连超时。请改用 git clone https://github.com/wzlwzl19/xxt-chaoxing-automation.git "$env:USERPROFILE\XXT"；如果 git 也失败，就直接告诉我需要手动下载哪个文件、放到哪里，别自己编地址。
```

---

## 装完的正确结果长什么样

DSH 执行完，你应该看到：

```
[1] 准备安装目录
    OK  安装目录：C:\Users\你\XXT
[2] 检查 Node.js
    OK  Node.js v22.x.x  (C:\Program Files\nodejs\node.exe)
[3] 下载程序代码
    OK  下载完成 620 KB
[4] 解压并覆盖代码（保留登录态与配置）
    OK  已写入 50+ 项
[5] 检查运行依赖
    OK  核心文件齐全（9 项）
    OK  全部 js 语法正确
[6] 写入知情同意
    OK  已同意《使用须知》
[7] 配置 DeepSeek Key（用于自动答题）
    !!  apikey.txt 已创建但为空 —— 不填也能刷视频，只是不会自动答题
[8] 安装 DSH 侧边栏面板插件
    OK  插件已注册到 DSH（重启 DSH 后左侧出现 ▶ 图标）
[9] 运行环境体检
...
==========================================================
  部署完成
==========================================================
```

**验收三条**（缺一条就是没装好）：

```bat
:: ① 主程序在
dir "%USERPROFILE%\XXT\autopilot.js"

:: ② 同意已写入
type "%USERPROFILE%\XXT\consent.json"

:: ③ 体检能跑
cd /d "%USERPROFILE%\XXT" && node preflight.js
```

---

## 装完之后你要做的 3 件事

1. **配 Key（可选）**：去 <https://platform.deepseek.com/api_keys> 建一个 `sk-` 开头的，粘进 `%USERPROFILE%\XXT\apikey.txt`，保存。
   不配也能刷视频，只是测验不会自动答。
2. **重启 DSH**：左边会出现 ▶ 图标，点开就是刷课面板（没有的话用页面里的粉色悬浮面板，一样能用）。
3. **第一次启动**：双击 `启动自动刷课.cmd` → 弹出的独立 Edge 窗口里登录学习通 → 登录完自动开始。

---

## 常见失败与对应说法（直接甩给 DSH）

| DSH 卡在哪 | 你就回它这句 |
|---|---|
| 说找不到 `install-all.ps1` | `用 codeload 的 zip 地址下载：https://codeload.github.com/wzlwzl19/xxt-chaoxing-automation/zip/refs/heads/main` |
| 说 `git` 命令不存在 | `跳过 git，改用 Invoke-WebRequest 下载 zip` |
| 说 `无法加载文件，未数字签名` | `加 -ExecutionPolicy Bypass 再执行一次` |
| 说 Node 不在 PATH | `用 "$env:ProgramFiles\nodejs\node.exe" 的绝对路径执行` |
| 说 winget 装 Node 失败 | `别装了，告诉我手动下载哪个 msi，我自己装完再回来` |
| 说 `node_modules` 缺失 | `这个项目零依赖，不需要 npm install，跳过` |
| 装完侧边栏没图标 | `检查 %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml 有没有 dsh-panel-xuexitong 这一行` |

---

## 一句提醒（也请转告）

本程序只做**学习辅助**：开独立浏览器窗口 → 你登录一次 → 自动播放 2 倍速 → 自动答**章节测验** → 自动跳节。
**考试页面一律自动跳过**，不参与、不代考。是否使用请你自行判断学校规定。
