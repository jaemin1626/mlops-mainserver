@echo off
chcp 65001 >nul
rem GPU 리눅스 서버가 없을 때 쓰는 개발용 가짜 생성 서버입니다.
set ROOT=%~dp0..
if exist "%ROOT%\.venv\Scripts\activate.bat" (
  call "%ROOT%\.venv\Scripts\activate.bat"
) else (
  echo 먼저 install.bat 을 실행하세요.
  exit /b 1
)
set PYTHONPATH=%ROOT%\src
echo 가짜 생성 서버: http://127.0.0.1:8188  (창을 닫으면 종료됩니다)
python "%ROOT%\scripts\mock_comfy_server.py" --host 127.0.0.1 --port 8188
