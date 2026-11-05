# 给 DSH 的完整部署指令（从零开始 · 全文可执行）

> 用法：把本文件**从「一、你的任务」到最后一行**整段复制，粘贴进她的 DSH 对话框，发出去。
> DSH 会自己执行、自己校验、自己处理报错，最后按验收清单回报。

---

## 一、你的任务

你是执行代理，在一台 **Windows 10/11 x64** 上，从零部署开源项目 `wzlwzl19/xxt-chaoxing-automation`（XXT 学习通学习助手）。

要求：

1. **你自己动手执行命令**，不要让我手动复制粘贴。除非遇到「必须人工介入」的阻塞（例如需要重启电脑、需要我登录账号），否则不要征求我意见。
2. 每完成一个阶段，简要说一行结果，再继续下一阶段。
3. 全程不要做系统级破坏性操作：不改注册表、不动防火墙、不卸载任何软件、不改系统 PATH。
4. 最后按「十、验收清单」逐条回报。
5. 遇到报错，**先查「九、故障分支」**，那里有对应的补救命令；照做，不要自己猜。

---

## 二、前置事实（先读完再动手，不要凭猜测操作）

| 项 | 事实 |
|---|---|
| 仓库地址 | `https://github.com/wzlwzl19/xxt-chaoxing-automation`（**public**，MIT 许可） |
| 项目性质 | 纯 Node.js 脚本 + 浏览器扩展，**零 npm 依赖**（不要执行 `npm install`，没有必要） |
| 运行原理 | 启动一个**独立配置的 Edge 实例**（`--remote-debugging-port`），通过 CDP 控制页面：自动进课程 → 找未完成任务点 → 2 倍速播放 → 自动答章节测验 → 自动跳节 |
| 安装目录 | `%USERPROFILE%\XXT`（如果该目录已存在，**覆盖代码但保留** `cdp-profile`、`profiles`、`apikey.txt`、`consent.json`、`license.key`、`creds.dpapi`、`account.txt`、`account-meta.json`） |
| 硬依赖 | Node.js **20 或 22 LTS**；Microsoft Edge（Win10/11 自带） |
| 软依赖 | 学习通账号（用户自己登录一次）；DeepSeek API Key（**可选**，仅自动答题需要）；DSH 桌面版（**可选**，仅侧边栏面板需要） |
| 明确不做 | 不破解、不伪造、不代考、不采集人脸；**检测到考试页面会自动跳过** |
| 权限 | 普通用户权限即可。只有「用 winget 装 Node」这一步可能需要一次 UAC 确认 |

---

## 三、阶段 0：环境探测（先跑这 3 条，把结果记下来）

```powershell
$PSVersionTable.PSVersion.ToString()
node -v
Test-Path "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

**判读**：

- PowerShell `5.1` 或 `7.x` → 都可以继续
- `node -v` 输出 `v20.x` / `v22.x` → 依赖满足，跳到阶段 1
- `node -v` 报「不是内部或外部命令」→ 先执行阶段 3.1 装 Node，再回来
- Edge 那行输出 `True` → 满足；`False` 则检查 `C:\Program Files\Microsoft\Edge\Application\msedge.exe`

---

## 四、阶段 1：快车道（首选，一条命令装完）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/wzlwzl19/xxt-chaoxing-automation/main/install-all.ps1 -OutFile $env:TEMP\xxt-install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\xxt-install.ps1"
```

这条命令会依次做：建目录 → 查/装 Node → 下载代码 → 解压覆盖 → 校验依赖与语法 → 写知情同意 → 建 `apikey.txt` → 装 DSH 插件 → 跑体检。

**成功判据**（必须同时满足）：

- 退出码 `0`
- 输出里出现 `部署完成`
- `%USERPROFILE%\XXT\autopilot.js` 存在

→ 满足就直接跳到 **阶段 5**（体检与插件复核），失败则进入 **阶段 2**。

---

## 五、阶段 2：手工下载（快车道失败时用，逐条执行）

### 2.1 建目录

```powershell
$XXT = "$env:USERPROFILE\XXT"
New-Item -ItemType Directory -Force -Path $XXT | Out-Null
```

### 2.2 下载压缩包

```powershell
Invoke-WebRequest "https://codeload.github.com/wzlwzl19/xxt-chaoxing-automation/zip/refs/heads/main" -OutFile "$env:TEMP\xxt.zip" -UseBasicParsing -TimeoutSec 120
```

> 这个地址返回的就是仓库的 zip，不需要 token、不需要登录。如果它超时，见「九、故障分支」第 3 条。

### 2.3 解压

```powershell
Expand-Archive "$env:TEMP\xxt.zip" -DestinationPath "$env:TEMP\xxtsrc" -Force
```

### 2.4 复制到安装目录（保留用户数据）

```powershell
$src = (Get-ChildItem "$env:TEMP\xxtsrc" -Directory | Select-Object -First 1).FullName
$KEEP = @('cdp-profile','profiles','apikey.txt','consent.json','license.key','account.txt','account-meta.json','creds.dpapi','.git')
Get-ChildItem $src -Force | Where-Object { $KEEP -notcontains $_.Name } | ForEach-Object {
  Copy-Item $_.FullName -Destination $XXT -Recurse -Force
}
```

### 2.5 校验

```powershell
(Get-ChildItem $XXT -File | Measure-Object).Count
Test-Path "$XXT\autopilot.js"
Test-Path "$XXT\extension-xxt\manifest.json"
Test-Path "$XXT\dsh-plugin\package.json"
```

**判据**：文件数 ≥ 50，三个 `Test-Path` 全为 `True`。

### 2.6 清理临时文件

```powershell
Remove-Item "$env:TEMP\xxt.zip","$env:TEMP\xxtsrc" -Recurse -Force -ErrorAction SilentlyContinue
```

---

## 六、阶段 3：依赖与语法校验

### 3.1 没有 Node 时安装

```powershell
winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
```

装完刷新当前会话 PATH，再验证：

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
node -v
```

> 如果 `winget` 不存在、或安装失败：**停下来告诉我**「请手动安装 Node LTS（nodejs.org 下 msi，一路下一步），装完回来说一声」。不要尝试从第三方站点下载安装包。

### 3.2 全量语法检查（防半截下载）

```powershell
$bad = 0
Get-ChildItem "$env:USERPROFILE\XXT" -Filter *.js -File | ForEach-Object {
  node --check $_.FullName 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { $bad++; Write-Host "语法异常: $($_.Name)" }
}
"异常文件数: $bad"
```

**判据**：`异常文件数: 0`。若大于 0，回到 2.2 重新下载。

---

## 七、阶段 4：合规闸门与 Key

### 4.1 写入知情同意（必做，不做程序拒绝启动）

```powershell
Set-Location "$env:USERPROFILE\XXT"
node consent.js agree
```

**判据**：输出含「已记录同意」，且 `consent.json` 存在。

> 说明：不写这个文件时，程序会打印《使用须知》并以退出码 `4` 停止。这是设计如此，不是 bug。

### 4.2 授权说明（很重要，别误判）

```powershell
node license.js show
```

- 开源版**没有** `license.key` 也**能正常跑**，启动时会打印 `[license] 开发模式（无 plan.json），跳过授权校验`
- 只有当看到「授权校验未通过」并退出码 `3` 时，才说明这是**商业包**，需要向提供者索取 `license.key` 放到安装目录

### 4.3 DeepSeek Key（可选）

```powershell
$key = Read-Host "粘贴 DeepSeek API Key（没有就直接回车跳过）"
if ($key) {
  [IO.File]::WriteAllText("$env:USERPROFILE\XXT\apikey.txt", $key.Trim(), [Text.UTF8Encoding]::new($false))
  "已写入 apikey.txt"
} else {
  Set-Content "$env:USERPROFILE\XXT\apikey.txt" -Value '' -Encoding ASCII
  "已跳过：只影响自动答题，不影响刷视频"
}
```

> Key 从 <https://platform.deepseek.com/api_keys> 自建，`sk-` 开头。不要让别人代填，也不要把 Key 写进任何聊天记录或仓库。

---

## 八、阶段 5：DSH 侧边栏插件（可选但强烈建议）

### 5.1 先判断 DSH 是否已安装

```powershell
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop"
```

- `True` → 继续 5.2
- `False` → **跳过本阶段**，告诉我：「没检测到 DSH 桌面版，面板插件先不装；想用侧边栏的话，先从官方渠道装 DSH，再回来双击 `安装DSH刷课插件.cmd`」

### 5.2 安装插件

```powershell
Set-Location "$env:USERPROFILE\XXT"
node install-dsh-plugin.js
```

### 5.3 校验注册是否写入

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Raw | Select-String 'dsh-panel-xuexitong'
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-panel-xuexitong\lib\panel.js"
```

**判据**：两行都为 `True` / 有命中。若配置里没有那一行，见「九、故障分支」第 12 条。

### 5.4 体检

```powershell
Set-Location "$env:USERPROFILE\XXT"
node preflight.js
```

**怎么读这份报告（别误报为错误）**：

| 字段 | 首次安装时的正常表现 | 说明 |
|---|---|---|
| `bridge.ok` | `false` | 还没启动过，正常 |
| `status.running` | `false` | 同上 |
| `creds` | `null` | 还没登录过，正常 |
| `checks[].ok`（端口/headless/webdriver/插件数/倍速） | 多数 `true` | 若 `webdriver=true` 才是问题 |
| `memory` | 任意 | 低于 1.5 GB 建议提醒用户关掉别的程序 |

---

## 九、故障分支（命中哪条就照着做）

1. **`irm` 报「无法连接远程服务器 / 超时」**
   → 直接用阶段 2 的 codeload 地址；两者都失败则第 3 条。

2. **`npm` 相关报错**
   → **忽略**。本项目零依赖，不需要 `npm install`。

3. **GitHub 直连不通（`github.com` / `codeload` / `raw` 全超时）**
   → 停下来告诉我：「需要你手动下载 https://github.com/wzlwzl19/xxt-chaoxing-automation 的 zip，解压到 `%USERPROFILE%\XXT`，然后回来说一声，我继续做剩下 3 步。」**不要**去第三方镜像站下，也不要编造地址。

4. **「无法加载文件 … 未对文件进行数字签名」**
   → 命令前加 `-ExecutionPolicy Bypass`，例如：
   `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\xxt-install.ps1"`

5. **中文显示成乱码**
   → 先执行 `chcp 65001`；脚本本身已带 UTF-8 BOM，用 `powershell -File` 方式运行不会乱。

6. **`node` 找不到但明明装了**
   → 用绝对路径：`& "$env:ProgramFiles\nodejs\node.exe" -v`

7. **`winget` 不存在**
   → 不要找替代品，直接让我手动装 Node（见 3.1 的停止条件）。

8. **`node consent.js agree` 报 `EACCES` / 权限不足**
   → 确认当前目录是 `%USERPROFILE%\XXT`；若目录在 `C:\Program Files` 下，改到用户目录重装。

9. **`node --check` 大量失败**
   → 压缩包没下全，回阶段 2.2 重下，别试图单个修文件。

10. **`node license.js show` 显示「授权状态：无效 —— 未找到授权文件 license.key」**
    → **开源版正常现象**，只要启动时打印的是「开发模式…跳过授权校验」就不影响使用。

11. **启动时打印《使用须知》后退出码 4**
    → 没做 4.1，补执行 `node consent.js agree`。

12. **DSH 左侧没有 ▶ 图标**
    → 依次检查并回报：
    ```powershell
    Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Raw
    Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-panel-xuexitong\lib\panel.js"
    ```
    两样都在仍无图标 → 让用户完全退出 DSH（托盘也退出）再重开；仍无 → 说明 DSH 版本过旧，改用「页面悬浮面板」或「Edge 扩展」。

13. **启动后提示「端口 9222 已被占用」**
    → 有别的东西占着调试端口：
    ```powershell
    Get-NetTCPConnection -State Listen -LocalPort 9222 -ErrorAction SilentlyContinue
    ```
    是旧的 msedge 就结束它（**只结束命令行里带 `XXT` 或 `cdp-profile` 的**，别碰用户日常浏览器）。

14. **浏览器反复闪退 / 登录态反复丢失**
    → 常见原因是有两个刷课进程抢同一个浏览器配置。检查：
    ```powershell
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'autopilot\.js' } | Select-Object ProcessId, CommandLine
    ```
    多于 1 个就全结束，然后只启动一次。

15. **视频一直显示「暂停」**
    → 程序会自动强推播放；连续 6 轮推不动会自动跳过该节。若长期不动，让用户把浏览器窗口别最小化到托盘，稍等 1 分钟。

16. **弹出滑块 / 图形验证码**
    → **这是风控试探，程序会立即停止并锁 60 分钟**。不要尝试绕过；告诉用户手动处理滑块后重新启动。

17. **弹出「人脸信息采集 / 请使用手机 APP」**
    → 程序会自动关闭该弹窗；连续 3 次仍弹说明老师开了课程级人脸监控，**必须用手机 APP 扫一次**，无法绕过。不要尝试伪造人脸。

18. **进入考试页面**
    → 程序会**立刻停止该课程并跳过**，这是写死的行为。不要试图让它参加考试。

19. **用户想换电脑 / 想换账号**
    → 换账号：删 `%USERPROFILE%\XXT\profiles\` 下对应 slot 目录，重新填。
    换电脑：开源版无需授权，直接重装即可。

20. **用户想彻底卸载**
    ```powershell
    Set-Location "$env:USERPROFILE"
    Remove-Item "XXT" -Recurse -Force
    ```

---

## 十、验收清单（你必须逐条回报）

装完后，用下面这段一次性核对，并把结果整理成表格发给用户：

```powershell
$XXT = "$env:USERPROFILE\XXT"
[pscustomobject]@{
  '安装目录'      = $XXT
  '目录存在'      = Test-Path $XXT
  '文件数'        = (Get-ChildItem $XXT -File -ErrorAction SilentlyContinue | Measure-Object).Count
  '主程序'        = Test-Path "$XXT\autopilot.js"
  '扩展清单'      = Test-Path "$XXT\extension-xxt\manifest.json"
  'DSH 插件'      = Test-Path "$XXT\dsh-plugin\package.json"
  '知情同意'      = Test-Path "$XXT\consent.json"
  'Key 文件'      = Test-Path "$XXT\apikey.txt"
  'Key 已填'      = (Test-Path "$XXT\apikey.txt") -and ((Get-Item "$XXT\apikey.txt").Length -gt 10)
  'Node 版本'     = (node -v)
  '启动器'        = Test-Path "$XXT\启动自动刷课.cmd"
}
```

期望：`目录存在/主程序/扩展清单/DSH 插件/知情同意/启动器` 全 `True`，`文件数 ≥ 50`，`Node 版本` 为 v20/v22。

---

## 十一、装完告诉她这三件事（原话照抄）

1. **打开方式**：双击 `%USERPROFILE%\XXT\启动自动刷课.cmd`
   → 会弹出一个**独立的 Edge 窗口**（不影响你平时用的浏览器和书签）
   → 在窗口里登录学习通，**只需登录这一次**
   → 登录成功后自动开始：自动进课程 → 找未完成 → 2 倍速播放 → 自动答章节测验 → 自动跳节

2. **想让它自动答题**：去 <https://platform.deepseek.com/api_keys> 建一个 `sk-` 开头的 Key，粘进 `%USERPROFILE%\XXT\apikey.txt`，保存即可。不填也能刷，只是测验不会自动答。

3. **想用侧边栏面板**：重启 DSH，左侧会出现 ▶ 图标；没有的话，页面右上角的粉色悬浮面板一样能用。

---

## 十二、可选增强（用得上再问，不要主动乱配）

| 需求 | 做法 |
|---|---|
| 多账号（2~6 个窗口） | 双击 `多账号刷课.cmd`，或在面板填「账号数量」，每行填手机号+密码+只刷这门课（留空=全部） |
| 切换 A/B/C 版 | 双击 `版本切换.cmd` → `a`/`b`/`c`（A 一机一号 / B 三号 / C 六号，C 版建议 ≥4 GB 空闲内存） |
| 改倍速 | 改 `config.json` 的 `speed`，**上限 2.0**（平台自带档位，>2x 会被程序拒绝） |
| 夜间不跑 | 改 `config.json` 的 `nightQuiet`（默认 `02:30~06:30` 自动暂停） |
| 只刷某一门课 | 面板里「只刷这门课」填课程名关键词，例如 `军事理论` |
| 清理日志与内存 | 双击 `清理内存与日志.cmd` |

---

## 十三、禁止事项（违反会装坏）

- ❌ 不要执行 `npm install` / `npm ci`（零依赖项目）
- ❌ 不要修改注册表、防火墙、系统 PATH
- ❌ 不要从任何第三方站点下载 exe / Node / DSH 安装包
- ❌ 不要编造 DSH 安装包直链（官方只通过自己的渠道分发）
- ❌ 不要让程序参与**考试**；检测到考试页跳过是设计行为，不要改
- ❌ 不要尝试绕过滑块验证码或伪造人脸
- ❌ 不要把 `apikey.txt`、`consent.json`、`profiles\` 内容发到任何地方

---

## 十四、一句话背景（给她的 DSH 理解用）

本程序只做**学习辅助**：开独立浏览器窗口 → 用户登录一次 → 自动播放（2 倍速）→ 自动完成**章节测验** → 自动跳节；**考试页面一律自动跳过**，不破解、不伪造、不代考；所有数据留在本机，除用户自配的 DeepSeek Key 外不上传第三方。
