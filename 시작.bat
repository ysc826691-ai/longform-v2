@echo off
chcp 65001 > nul
echo.
echo ========================================
echo  LONGFORM v2 시작
echo ========================================
echo.

cd /d "%~dp0"

if not exist "node_modules" (
    echo [오류] install.bat 을 먼저 실행하세요.
    pause
    exit /b 1
)

start /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:5500"

echo  서버 시작 중... 잠시 후 브라우저가 열립니다.
echo  종료: 이 창을 닫거나 Ctrl+C
echo.

node server.js
pause