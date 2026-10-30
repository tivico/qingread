@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%USERPROFILE%\.local\bin;%PATH%"
where uv >nul 2>nul
if errorlevel 1 (
  echo 正在安裝 uv，用來管理清讀專用的 Python 環境。
  winget install --id=astral-sh.uv -e --source winget
  if errorlevel 1 goto uvfailed
)
set "UV_CACHE_DIR=%~dp0data\install-cache"
if not exist .venv\Scripts\python.exe (
  uv venv --python 3.12 .venv
  if errorlevel 1 goto failed
)
uv pip install --python .venv\Scripts\python.exe -r requirements-lock.txt
if errorlevel 1 goto failed
echo 助手套件安裝完成。這個視窗可關閉，下次直接點 start.cmd。
echo 請確認已安裝並啟動 Ollama，且已下載至少一個本機文字模型。
echo Ollama 官方下載：https://ollama.com/download/windows
echo PDF 字型及語音模型可在外掛的「PDF 與助手設定」準備。
pause
exit /b 0
:uvfailed
echo uv 安裝未完成，請從 https://docs.astral.sh/uv/getting-started/installation/ 安裝。
echo 安裝後關閉此視窗，再重新開啟 install.cmd。
pause
exit /b 1
:failed
echo 安裝失敗。請保留上方錯誤訊息，確認網路與磁碟空間後重試。
pause
exit /b 1
