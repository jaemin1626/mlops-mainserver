@echo off
chcp 65001 >nul
setlocal
set ROOT=%~dp0..
where py >nul 2>&1
if %ERRORLEVEL%==0 (
  py -3.11 -m venv "%ROOT%\.venv"
) else (
  python -m venv "%ROOT%\.venv"
)
call "%ROOT%\.venv\Scripts\activate.bat"
python -m pip install --upgrade pip
if exist "%~dp0wheels" (
  dir /b "%~dp0wheels\*.whl" >nul 2>&1
  if %ERRORLEVEL%==0 (
    python -m pip install --no-index --find-links "%~dp0wheels" -r "%~dp0requirements.txt"
    goto done
  )
)
echo wheels가 없어 PyPI에서 설치합니다. 폐쇄망이면 먼저 collect_online.bat 을 실행하세요.
python -m pip install -r "%~dp0requirements.txt"
:done
echo Windows 클라이언트 설치 완료. run.bat 으로 실행하세요.
