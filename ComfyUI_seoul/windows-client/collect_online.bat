@echo off
chcp 65001 >nul
setlocal
set ROOT=%~dp0..
mkdir "%~dp0wheels" 2>nul
where py >nul 2>&1
if %ERRORLEVEL%==0 (
  py -3.11 -m pip download -d "%~dp0wheels" -r "%~dp0requirements.txt"
) else (
  python -m pip download -d "%~dp0wheels" -r "%~dp0requirements.txt"
)
echo wheels 수집 완료. windows-client 폴더를 폐쇄망 PC로 복사하세요.
