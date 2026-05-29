@echo off
chcp 65001 > nul
echo.
echo ========================================
echo  LONGFORM v2 동기화 (git pull)
echo ========================================
echo.

cd /d "%~dp0"

echo 최신 코드 받아오는 중...
git pull

echo.
echo 동기화 완료! 브라우저에서 Ctrl+Shift+R 눌러서 새로고침하세요.
echo.
pause
