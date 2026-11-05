@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal enabledelayedexpansion

:MENU
cls
echo ==========================================================
echo   多账号刷课 · 控制台
echo ==========================================================
echo.
node accounts.js list
echo.
echo ----------------------------------------------------------
echo   [1] 添加账号（手机号 + 密码）
echo   [2] 给账号登录一次（打开浏览器手动登录）
echo   [3] 开始刷课（全部账号）
echo   [4] 只刷一个账号
echo   [5] 设置同时刷几个（默认 2）
echo   [0] 退出
echo ----------------------------------------------------------
echo.
set /p CH=请输入序号后回车:
if "%CH%"=="1" goto ADD
if "%CH%"=="2" goto LOGIN
if "%CH%"=="3" goto RUN
if "%CH%"=="4" goto RUNONE
if "%CH%"=="5" goto PARALLEL
if "%CH%"=="0" goto END
goto MENU

:ADD
cls
echo === 添加账号 ===
node accounts.js add
echo.
pause
goto MENU

:LOGIN
cls
echo === 给账号登录一次 ===
node accounts.js list
echo.
set /p U=输入要登录的手机号:
if "%U%"=="" goto MENU
node accounts.js login %U%
echo.
pause
goto MENU

:RUN
cls
echo === 开始刷课（全部账号）===
echo.
set /p C=只刷某门课？留空=全部课程（直接回车跳过）:
if "%C%"=="" (node multi.js) else (node multi.js --course "%C%")
echo.
pause
goto MENU

:RUNONE
cls
echo === 只刷一个账号 ===
node accounts.js list
echo.
set /p U=输入要刷的手机号:
if "%U%"=="" goto MENU
set /p C=只刷某门课？留空=全部课程（直接回车跳过）:
if "%C%"=="" (node multi.js --user %U%) else (node multi.js --user %U% --course "%C%")
echo.
pause
goto MENU

:PARALLEL
cls
set /p N=同时刷几个账号（1-6，建议 2）:
if "%N%"=="" goto MENU
node accounts.js parallel %N%
echo.
pause
goto MENU

:END
endlocal
exit /b 0
