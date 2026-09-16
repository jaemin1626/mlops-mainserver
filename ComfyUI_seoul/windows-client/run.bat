@echo off
chcp 65001 >nul
set ROOT=%~dp0..
if exist "%ROOT%\.venv\Scripts\activate.bat" (
  call "%ROOT%\.venv\Scripts\activate.bat"
) else (
  echo 먼저 install.bat 을 실행하세요.
  exit /b 1
)
set PYTHONPATH=%ROOT%\src
set SEOUL_STUDIO_HOST=127.0.0.1
set SEOUL_STUDIO_PORT=7860
echo 브라우저에서 http://127.0.0.1:7860 을 여세요.
start http://127.0.0.1:7860
python -m seoul_studio
