@echo off
rem Double-click this file to sync .scaffold-secrets to your Bitwarden vault.
rem Runs bw-push.ps1 (unlock -> push -> discard session) and keeps the
rem window open afterward so you can see the result.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bw-push.ps1"
echo.
pause
