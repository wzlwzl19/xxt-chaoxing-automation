@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   学习通自动刷课 - 手动登录任意账号
echo ============================================
echo.
echo 1) 先起浏览器（独立配置目录，不碰你日常用的那个）
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
start "" "%EDGE%" --user-data-dir="%~dp0cdp-profile" --remote-debugging-port=9222 --no-first-run --no-default-browser-check --window-size=1440,900 "https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%%3A%%2F%%2Fmooc1.chaoxing.com%%2Fvisit%%2Finteraction"
timeout /t 8 /nobreak >nul
echo.
echo 2) 在刚弹出的窗口里填你要刷的账号和密码，点「登录」
echo    （想刷谁就登谁，脚本不认死账号）
echo.
echo 3) 登录成功后我会自动开始，不用再点别的
echo.
node wait-login.js %*
echo.
pause
