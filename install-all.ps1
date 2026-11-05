# =====================================================================
#  XXT 学习通学习助手 —— 一键部署脚本（可交给 DSH / 任何 AI 助手执行）
#  用法：
#    powershell -NoProfile -ExecutionPolicy Bypass -File install-all.ps1
#  可选参数：
#    -Target "D:\XXT"    指定安装目录（默认 %USERPROFILE%\XXT）
#    -ApiKey "sk-xxx"    顺便写入 DeepSeek Key
#    -NoPlugin           跳过 DSH 侧边栏插件安装
# =====================================================================
param(
  [string]$Target = "",
  [string]$ApiKey = "",
  [switch]$NoPlugin
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$ProgressPreference = 'SilentlyContinue'

$REPO   = 'wzlwzl19/xxt-chaoxing-automation'
$BRANCH = 'main'
$ZIPURL = "https://codeload.github.com/$REPO/zip/refs/heads/$BRANCH"
$RAW    = "https://raw.githubusercontent.com/$REPO/$BRANCH"

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Step($n, $msg) { Write-Host ""; Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host ""; Write-Host "[X] $msg" -ForegroundColor Red; exit 1 }

Say "==========================================================" DarkCyan
Say "  XXT 学习通学习助手 · 一键部署" DarkCyan
Say "==========================================================" DarkCyan

# ---------------------------------------------------------------- 1 目录
Step 1 "准备安装目录"
if (-not $Target) { $Target = Join-Path $env:USERPROFILE 'XXT' }
if ($Target -match '[^\x00-\x7F]') { Warn "安装路径含中文，可能导致异常：$Target" }
if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Path $Target -Force | Out-Null }
$Target = (Resolve-Path $Target).Path
Ok "安装目录：$Target"

# ---------------------------------------------------------------- 2 Node
Step 2 "检查 Node.js"
function Get-NodeExe {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}
$node = Get-NodeExe
if (-not $node) {
  Warn "没有找到 Node.js，尝试用 winget 自动安装（需要联网，约 1-2 分钟）…"
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    $node = Get-NodeExe
  }
}
if (-not $node) {
  Die "Node.js 安装失败或未在 PATH 中。请手动安装 LTS 版本后重新运行本脚本：https://nodejs.org/zh-cn/download"
}
$ver = (& $node -v).Trim()
Ok "Node.js $ver  ($node)"

# ---------------------------------------------------------------- 3 下载代码
Step 3 "下载程序代码"
$tmpZip = Join-Path $env:TEMP ("xxt-" + [guid]::NewGuid().ToString('N').Substring(0,8) + ".zip")
$tmpDir = Join-Path $env:TEMP ("xxt-" + [guid]::NewGuid().ToString('N').Substring(0,8))
Say "    下载中：$ZIPURL"
try {
  Invoke-WebRequest -Uri $ZIPURL -OutFile $tmpZip -UseBasicParsing -TimeoutSec 120
} catch {
  Die "下载失败：$($_.Exception.Message)。请检查网络，或手动下载 https://github.com/$REPO 后解压到 $Target"
}
Ok ("下载完成 " + [math]::Round((Get-Item $tmpZip).Length / 1KB, 0) + " KB")

Step 4 "解压并覆盖代码（保留登录态与配置）"
Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
$inner = Get-ChildItem $tmpDir -Directory | Select-Object -First 1
if (-not $inner) { Die "压缩包结构异常，未找到内容目录" }
# 覆盖代码，但不动用户数据目录
$KEEP = @('cdp-profile','profiles','apikey.txt','consent.json','license.key','account.txt','account-meta.json','creds.dpapi','.git')
$copied = 0
Get-ChildItem $inner.FullName -Force | ForEach-Object {
  if ($KEEP -contains $_.Name) { return }
  $dest = Join-Path $Target $_.Name
  if ($_.PSIsContainer) {
    Copy-Item $_.FullName -Destination $dest -Recurse -Force
  } else {
    Copy-Item $_.FullName -Destination $dest -Force
  }
  $copied++
}
Ok "已写入 $copied 项"
Remove-Item $tmpZip, $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

if (-not (Test-Path (Join-Path $Target 'autopilot.js'))) { Die "部署异常：autopilot.js 不存在" }
Ok "主程序就位"

# ---------------------------------------------------------------- 4 依赖自检
Step 5 "检查运行依赖"
$need = @('autopilot.js','xxt-bridge.js','guard.js','sentinel.js','compliance.js','consent.js','license.js','extension-xxt\manifest.json','dsh-plugin\package.json')
$missing = @()
foreach ($f in $need) { if (-not (Test-Path (Join-Path $Target $f))) { $missing += $f } }
if ($missing.Count -gt 0) { Die ("缺少文件：" + ($missing -join ', ')) }
Ok "核心文件齐全（$($need.Count) 项）"

# 语法快速校验（防半截下载）
$bad = 0
Get-ChildItem $Target -Filter *.js -File | ForEach-Object {
  & $node --check $_.FullName 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { $bad++ }
}
if ($bad -gt 0) { Warn "$bad 个 js 文件语法异常，建议删目录重装" } else { Ok "全部 js 语法正确" }

# ---------------------------------------------------------------- 5 知情同意
Step 6 "写入知情同意"
Push-Location $Target
try {
  & $node consent.js agree 2>&1 | ForEach-Object { "    $_" }
  Ok "已同意《使用须知》"
} catch { Warn "同意写入失败（首次运行时还会再问一次）" }

# ---------------------------------------------------------------- 6 API Key
Step 7 "配置 DeepSeek Key（用于自动答题）"
$keyFile = Join-Path $Target 'apikey.txt'
if ($ApiKey) {
  [IO.File]::WriteAllText($keyFile, $ApiKey.Trim(), [Text.UTF8Encoding]::new($false))
  Ok "已写入 apikey.txt"
} elseif (Test-Path $keyFile) {
  Ok "已存在 apikey.txt，保持不变"
} else {
  Set-Content -Path $keyFile -Value '' -Encoding ASCII
  Warn "apikey.txt 已创建但为空 —— 不填也能刷视频，只是不会自动答题"
  Say "    去 https://platform.deepseek.com/api_keys 建一个 sk- 开头的 key，粘进 $keyFile" Yellow
}

# ---------------------------------------------------------------- 7 DSH 插件
Step 8 "安装 DSH 侧边栏面板插件"
$dshProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
if ($NoPlugin) {
  Warn "已按参数跳过"
} elseif (-not (Test-Path $dshProfile)) {
  Warn "没检测到 DSH（$dshProfile 不存在），跳过。装好 DSH 后可再双击 安装DSH刷课插件.cmd"
} else {
  try {
    & $node install-dsh-plugin.js 2>&1 | ForEach-Object { "    $_" }
    $patch = Join-Path $dshProfile 'cordis.patch.yml'
    if ((Test-Path $patch) -and ((Get-Content $patch -Raw -ErrorAction SilentlyContinue) -match 'dsh-panel-xuexitong')) {
      Ok "插件已注册到 DSH（重启 DSH 后左侧出现 ▶ 图标）"
    } else {
      Warn "插件文件已复制，但加载配置未写入，需要手动检查 $patch"
    }
  } catch { Warn "插件安装异常：$($_.Exception.Message)" }
}

# ---------------------------------------------------------------- 8 体检
Step 9 "运行环境体检"
try { & $node preflight.js 2>&1 | Select-Object -First 40 | ForEach-Object { "    $_" } } catch { Warn "体检脚本异常，可忽略" }

Pop-Location

# ---------------------------------------------------------------- 完成
Say ""
Say "==========================================================" Green
Say "  部署完成" Green
Say "==========================================================" Green
Say "  安装目录：$Target"
Say "  下一步："
Say "    1) 双击 $Target\启动自动刷课.cmd"
Say "    2) 弹出的 Edge 窗口里登录学习通（只需登录一次）"
Say "    3) 登录后自动开始：2 倍速播放 → 自动答测验 → 自动跳节"
Say "  想用侧边栏面板：重启 DSH 后点左侧 ▶ 图标"
Say "  版本切换：双击 版本切换.cmd（A 一机一号 / B 三号 / C 六号）"
Say "  出问题先跑：node preflight.js"
Say ""
Say "  安全提示：本程序不参与任何考试（考试页自动跳过），仅作学习辅助。" DarkYellow
Say ""
