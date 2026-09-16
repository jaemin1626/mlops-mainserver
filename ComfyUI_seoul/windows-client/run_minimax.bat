@echo off
chcp 65001 >nul
rem 테스트용 실행기입니다. 실제 운영은 run.bat 을 쓰세요.
rem 워크플로: workflows-minimax\i2v_api.json (MiniMax H3, 이미지→영상 전용)
set ROOT=%~dp0..
if exist "%ROOT%\.venv\Scripts\activate.bat" (
  call "%ROOT%\.venv\Scripts\activate.bat"
) else (
  echo 먼저 install.bat 을 실행하세요.
  pause
  exit /b 1
)
if not exist "%ROOT%\workflows-minimax\i2v_api.json" (
  echo workflows-minimax\i2v_api.json 이 없습니다.
  pause
  exit /b 1
)

set SEOUL_STUDIO_WORKFLOW_DIR=%ROOT%\workflows-minimax
set SEOUL_STUDIO_CONFIG=%USERPROFILE%\.seoul-studio\config-minimax.json
set SEOUL_STUDIO_OUTPUT_DIR=%USERPROFILE%\Videos\SeoulStudio-MiniMax
set PYTHONPATH=%ROOT%\src
set SEOUL_STUDIO_HOST=127.0.0.1
set SEOUL_STUDIO_PORT=7861

if not exist "%USERPROFILE%\.seoul-studio" mkdir "%USERPROFILE%\.seoul-studio"
if not exist "%SEOUL_STUDIO_CONFIG%" (
  if exist "%USERPROFILE%\.seoul-studio\config.json" copy "%USERPROFILE%\.seoul-studio\config.json" "%SEOUL_STUDIO_CONFIG%" >nul
)

echo [테스트용] MiniMax H3 이미지→영상 워크플로
echo 저장 폴더: %SEOUL_STUDIO_OUTPUT_DIR%
echo 브라우저에서 http://127.0.0.1:7861 을 여세요.
start http://127.0.0.1:7861
python -m seoul_studio
if errorlevel 1 pause
