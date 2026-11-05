@echo off
chcp 65001 >nul
title 安装：学习通刷课 DSH 侧边栏插件
cd /d "%~dp0"

set "SRC=%~dp0dsh-plugin"
set "PROF=%USERPROFILE%\.dsh\profiles\desktop"
set "DST=%PROF%\node_modules\dsh-panel-xuexitong"

if not exist "%SRC%\package.json" (
  echo [X] 找不到插件源目录：%SRC%
  pause & exit /b 1
)

echo ==== 1/3 复制插件到 DSH profile ====
if exist "%DST%" rmdir /s /q "%DST%"
xcopy "%SRC%" "%DST%\" /E /I /Y /Q >nul
if errorlevel 1 ( echo [X] 复制失败 & pause & exit /b 1 )
echo      OK -> %DST%

echo ==== 2/3 写入 profile/package.json ====
if not exist "%PROF%\package.json.bak-xxt" copy "%PROF%\package.json" "%PROF%\package.json.bak-xxt" >nul
node "%~dp0install-dsh-plugin.js"
if errorlevel 1 ( echo [X] 写配置失败 & pause & exit /b 1 )

echo ==== 3/3 重启 DeepSeek Harness 让它加载 ====
echo.
echo 请点任意键重启 DSH（当前对话会断开，重开即可）
pause >nul
taskkill /IM "DeepSeek Harness.exe" /F >nul 2>nul
timeout /t 3 /nobreak >nul
start "" "%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"
echo 已重启。界面出来后，左侧栏底部会多一个 ▶ 按钮。
timeout /t 5 /nobreak >nul
exit /b 0
