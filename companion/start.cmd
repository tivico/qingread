@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
set "PYTHONUTF8=1"
set "OLLAMA_NO_CLOUD=1"
if not exist .venv\Scripts\python.exe (
  echo Please run install.cmd first.
  pause
  exit /b 1
)
.venv\Scripts\python.exe launcher.py
pause
