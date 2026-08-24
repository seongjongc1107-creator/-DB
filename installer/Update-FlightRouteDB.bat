@echo off
chcp 65001 >nul
title 항로 DB 업데이트
setlocal enabledelayedexpansion

set "INSTALL_DIR=C:\FlightRouteDB"
set "PORT=8001"

if exist "%INSTALL_DIR%\backend\.env" (
    for /f "tokens=2 delims==" %%P in ('findstr /b "PORT=" "%INSTALL_DIR%\backend\.env"') do set "PORT=%%P"
)

echo ==========================================
echo   항로 DB 지금 업데이트
echo ==========================================
echo.
set /p ADMIN_PW=관리자 비밀번호를 입력하세요:

echo.
echo 업데이트 확인 중...
curl -s -X POST "http://localhost:%PORT%/api/admin/update-now" --data-urlencode "password=%ADMIN_PW%"
echo.
echo.
echo (updated:true 이면 적용됨 — 서버가 몇 초 후 자동으로 재시작됩니다)
echo (403 오류면 비밀번호가 틀렸습니다)
echo.
pause
