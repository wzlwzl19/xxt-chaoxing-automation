@echo off
chcp 65001 >nul
title XueXiTong AutoPilot
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found in PATH.
  pause
  exit /b 1
)

if not exist "creds.dpapi" (
  echo First run: please enter your Chaoxing account once.
  node setup.js
  if errorlevel 1 (
    echo [X] Setup cancelled.
    pause
    exit /b 1
  )
)

rem 后台挂一个清理进程：截断日志 + 关多余标签 + 回收浏览器内存
start "xxt-cleanup" /min cmd /c node maintenance.js --watch --every-min 10

node autopilot.js %*
echo.
echo ---- stopped ----
pause
