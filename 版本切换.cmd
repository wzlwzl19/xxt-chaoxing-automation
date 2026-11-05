@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 学习通刷课 - 版本切换 A/B/C

:menu
cls
echo ================================================
echo   学习通刷课  版本切换
echo ================================================
echo.
echo   当前版本：
node switch-version.js 2>nul | findstr "当前版本"
echo.
echo   [1]  A 版   一机一号  （不开数量选择）
echo   [2]  B 版   一机三号  （数量 1~3，最多三台）
echo   [3]  C 版   一机六号  （数量 1~6，最多六台）
echo   [4]  查看当前版本
echo   [0]  退出
echo.
set /p CH=请选择： 

if "%CH%"=="1" goto seta
if "%CH%"=="2" goto setb
if "%CH%"=="3" goto setc
if "%CH%"=="4" goto show
if "%CH%"=="0" goto end
goto menu

:seta
node switch-version.js a
goto after

:setb
node switch-version.js b
goto after

:setc
node switch-version.js c
goto after

:show
node switch-version.js
goto after

:after
echo.
echo --------------------------------------------------
echo   已生效。到 DSH 里关掉面板窗口重新打开（或按 Ctrl+R）
echo   就能看到对应版本的页面。
echo --------------------------------------------------
echo.
pause
goto menu

:end
endlocal
