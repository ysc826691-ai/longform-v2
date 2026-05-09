@echo off
chcp 65001 > nul
echo.
echo ========================================
echo  LONGFORM v2 Install
echo ========================================
echo.

cd /d "%~dp0"

echo [1/2] Node.js 확인 중...
where node >nul 2>nul
if %errorlevel% equ 0 (
    echo       OK - Node.js 설치됨
    goto npm_install
)

echo       Node.js가 없습니다. 자동 설치를 시도합니다...
echo.

winget --version >nul 2>nul
if %errorlevel% equ 0 (
    echo       winget 으로 Node.js LTS 설치 중...
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    if %errorlevel% equ 0 (
        echo       설치 완료. 이 창을 닫고 다시 install.bat 을 실행하세요.
        pause
        exit /b 0
    )
)

echo       설치 파일 다운로드 중...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.19.1/node-v20.19.1-x64.msi' -OutFile '%TEMP%\node-installer.msi' -UseBasicParsing"
if %errorlevel% neq 0 (
    echo.
    echo [오류] 다운로드 실패. https://nodejs.org 에서 Node.js LTS 설치 후 다시 실행하세요.
    pause
    exit /b 1
)
msiexec /i "%TEMP%\node-installer.msi" /quiet /norestart
echo       설치 완료. 이 창을 닫고 다시 install.bat 을 실행하세요.
pause
exit /b 0

:npm_install
echo.
echo [2/2] 패키지 설치 중...
call npm install
if %errorlevel% neq 0 (
    echo [오류] 패키지 설치 실패. 인터넷 연결 확인 후 다시 실행하세요.
    pause
    exit /b 1
)

echo.
echo ========================================
echo  설치 완료! "시작.bat" 을 실행하세요.
echo ========================================
echo.
pause