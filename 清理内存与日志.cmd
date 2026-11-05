@echo off
chcp 65001 >nul
title XueXiTong 清理：日志 / 临时文件 / 浏览器内存
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没找到 Node.js
  pause
  exit /b 1
)

if /i "%~1"=="daemon" goto daemon
if /i "%~1"=="watch"  goto watch

echo ==== 现在清理一轮 ====
node maintenance.js
echo.
echo 想让它常驻自动清？双击本文件时加参数：
echo   清理内存与日志.cmd daemon   每 15 分钟自动清一次
echo   清理内存与日志.cmd watch    跟随刷课进程，刷课结束就自己退出
echo.
pause
exit /b 0

:daemon
echo ==== 常驻清理（每 15 分钟一轮，关窗口即停）====
node maintenance.js --daemon --every-min 15
pause
exit /b 0

:watch
echo ==== 跟随刷课进程清理（每 10 分钟一轮）====
node maintenance.js --watch --every-min 10
pause
exit /b 0
