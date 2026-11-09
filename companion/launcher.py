"""Idempotent local startup; update only this installation and only while idle."""
import argparse
from contextlib import contextmanager
import errno
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

from runtime_status import installation_id, source_revision

ROOT = Path(__file__).resolve().parent
PORT = 8765


class StartupError(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def legacy_process_details(root, port=PORT):
    """Read-only Windows diagnostics; never infer a process to terminate here."""
    if os.name != 'nt':
        return []
    environment = os.environ.copy()
    environment['QINGREAD_DIAGNOSTIC_ROOT'] = str(Path(root).resolve())
    environment['QINGREAD_DIAGNOSTIC_PORT'] = str(int(port))
    script = r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$expectedPython = [IO.Path]::GetFullPath((Join-Path $env:QINGREAD_DIAGNOSTIC_ROOT '.venv\Scripts\python.exe'))
$expectedApp = [IO.Path]::GetFullPath((Join-Path $env:QINGREAD_DIAGNOSTIC_ROOT 'app.py'))
$owners = @(Get-NetTCPConnection -LocalPort ([int]$env:QINGREAD_DIAGNOSTIC_PORT) -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -gt 0 } | Select-Object -ExpandProperty OwningProcess -Unique)
$found = @()
foreach ($owner in $owners) {
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owner)
    if (-not $process -or $process.Name -notin @('python.exe','pythonw.exe')) { continue }
    $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.ParentProcessId)
    $relativeApp = $process.CommandLine -match '(?:^|\s)"?app\.py"?(?:\s|$)'
    $absoluteApp = $process.CommandLine -match [regex]::Escape($expectedApp)
    $ownEnvironment = $process.ExecutablePath -eq $expectedPython -or ($parent -and $parent.ExecutablePath -eq $expectedPython)
    if (($relativeApp -and $ownEnvironment) -or $absoluteApp) {
        $found += [pscustomobject]@{ processId = [int]$process.ProcessId; startedAt = $process.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') }
    }
}
ConvertTo-Json -InputObject @($found) -Compress
'''
    try:
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
            capture_output=True, text=True, encoding='utf-8', errors='replace',
            env=environment, timeout=8, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            return []
        rows = json.loads(result.stdout)
        if not isinstance(rows, list):
            return []
        return [row for row in rows if isinstance(row, dict) and type(row.get('processId')) is int
                and row['processId'] > 0 and isinstance(row.get('startedAt'), str)
                and re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', row['startedAt'])]
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return []


def legacy_message(error, root, port=PORT):
    message = str(error)
    if error.code != 'LEGACY_HELPER':
        return message
    details = legacy_process_details(root, port)
    if details:
        message += '\n已核對此安裝位置的背景程序：' + '；'.join(
            f"PID {row['processId']}（啟動於 {row['startedAt']}）" for row in details)
        message += '\n請先停止字幕、等工作結束，再到工作管理員的「詳細資料」依 PID 結束該程序，然後重開 start.cmd。不要結束所有 Python。'
    else:
        message += '\n未能核對背景程序識別。請依 README 的背景助手排查步驟確認安裝路徑；不要結束所有 Python。'
    return message


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def read_token(data):
    file = Path(data) / 'config.json'
    if not file.exists():
        return None
    try:
        token = json.loads(file.read_text(encoding='utf-8'))['token']
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{30,100}', token):
            raise ValueError()
        return token
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise StartupError('無法讀取助手設定。請保留 data 資料夾，確認 config.json 與資料夾權限；不要刪除配對設定。') from error


def listening(port=PORT):
    # Probe availability without sending a connection to a closed port. Some
    # Windows firewall configurations silently drop those instead of refusing.
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', port))
            return False
        except OSError as error:
            if error.errno == errno.EADDRINUSE or getattr(error, 'winerror', None) == 10048:
                return True
            raise StartupError('無法檢查本機連接埠。請確認安全軟體與連接埠保留設定。') from error


def request(route, token, body=None, port=PORT):
    headers = {'Authorization': 'Bearer ' + token} if token else {}
    raw = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        raw = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(f'http://127.0.0.1:{port}' + route, data=raw, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(req, timeout=5) as response:
            value = json.loads(response.read(262145))
            if not isinstance(value, dict):
                raise ValueError()
            return value
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise StartupError('本機連線由另一份助手或不同配對設定使用，未停止任何程序。請確認開啟的是原本的清讀資料夾。') from error
        if error.code == 409:
            value = json.loads(error.read(262145))
            messages = {
                'COMPANION_BUSY': '還有翻譯、語音、配對或文件工作，未重新啟動。請先停止字幕並等工作結束，再開 start.cmd。',
                'COMPANION_STOPPING': '另一個啟動視窗正在更新助手，請稍候再試。',
                'INSTALLATION_MISMATCH': '執行中的助手與此資料夾不一致，未停止任何程序。',
            }
            raise StartupError(messages.get(value.get('error'), '助手狀態已改變，未重新啟動；請稍候再試。')) from error
        raise StartupError('執行中的助手不支援這次操作。請先結束工作並關閉原本的助手，再開 start.cmd。') from error
    except (OSError, ValueError, urllib.error.URLError) as error:
        raise StartupError('本機連線沒有回傳有效的清讀狀態。請檢查原助手視窗或連接埠是否被其他程式使用，未停止任何程序。') from error


def choose_action(health, root, data):
    runtime = health.get('runtime')
    if not isinstance(runtime, dict) or not runtime.get('shutdownSupported'):
        raise StartupError('舊助手仍在執行，而且尚不支援自動交接；它可能在背景，關閉這個提示視窗不會關閉舊助手。首次升級需結束實際的舊助手程序一次，再開 start.cmd。', 'LEGACY_HELPER')
    if runtime.get('installationId') != installation_id(root, data):
        raise StartupError('執行中的助手來自其他安裝位置，未停止任何程序。請使用原本的清讀資料夾。')
    if not isinstance(runtime.get('revision'), str) or not re.fullmatch(r'[0-9a-f]{64}', runtime['revision']):
        raise StartupError('助手程式識別不完整。請先結束工作並關閉原助手，再開 start.cmd。')
    revision = source_revision(root)
    if revision is None:
        raise StartupError('助手程式檔案不完整或無法讀取。請重新解壓完整套件，保留自己的 data 資料夾。')
    if runtime.get('revision') == revision and runtime.get('updateRequired') is False:
        return 'reuse'
    return 'update'


@contextmanager
def startup_lock(data):
    # Lock only the short startup/health handshake, never the service lifetime.
    Path(data).mkdir(parents=True, exist_ok=True)
    with (Path(data) / 'startup.lock').open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0'); handle.flush()
        deadline = time.monotonic() + 15
        while True:
            try:
                handle.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise StartupError('另一個視窗正在啟動助手，請稍後再試。')
                time.sleep(.1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def ensure_running(root, data, port=PORT):
    root, data = Path(root).resolve(), Path(data).resolve()
    with startup_lock(data):
        token = read_token(data)
        if listening(port):
            health = request('/health', token, port=port)
            if choose_action(health, root, data) == 'reuse':
                print('助手已啟動，而且已載入目前程式。請回到清讀按「重新檢查連線」。', flush=True)
                return None
            runtime = health['runtime']
            request('/maintenance/stop', token, {
                'installationId': runtime['installationId'], 'revision': runtime['revision']
            }, port=port)
            deadline = time.monotonic() + 10
            while listening(port):
                if time.monotonic() >= deadline:
                    raise StartupError('舊助手尚未結束，未啟動第二份。請檢查原助手狀態後重試。')
                time.sleep(.1)
            print('舊助手已在沒有工作的狀態下結束，正在載入更新；原配對與模型設定保留。', flush=True)
        child = subprocess.Popen([sys.executable, '-B', str(root / 'app.py'), '--data-dir', str(data), '--port', str(port)], cwd=root)
        deadline = time.monotonic() + 25
        while child.poll() is None:
            token = read_token(data)
            if token and listening(port):
                health = request('/health', token, port=port)
                if choose_action(health, root, data) != 'reuse':
                    raise StartupError('啟動期間程式又有更新，請等更新完成後再開 start.cmd。')
                print('啟動檢查完成。請回清讀連接助手；功能缺少什麼可在設定頁逐項查看。', flush=True)
                return child
            if time.monotonic() >= deadline:
                raise StartupError('助手啟動尚未完成。請保留這個視窗查看錯誤，不要反覆啟動。')
            time.sleep(.15)
        raise StartupError('助手未能啟動。請查看上方錯誤；若缺少套件，先執行 install.cmd，保留 data 與既有模型。')


def main():
    parser = argparse.ArgumentParser(description='清讀啟動與更新檢查')
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'data')
    parser.add_argument('--check', action='store_true', help='只檢查，不啟動或停止助手')
    args = parser.parse_args()
    try:
        if args.check:
            if not listening():
                raise StartupError('助手尚未啟動，請雙擊 companion/start.cmd。')
            health = request('/health', read_token(args.data_dir))
            action = choose_action(health, ROOT, args.data_dir)
            print('助手程式：' + ('已載入更新' if action == 'reuse' else '需要更新，請先停止字幕並等工作結束，再開 start.cmd'))
            print('Ollama：' + ('已啟動' if health.get('ollama') else '未連線，請先啟動 Ollama'))
            print('文字模型：' + ('已選擇且可用' if health.get('selected_model') in health.get('models', []) else '尚未就緒，請在清讀設定選擇已下載模型'))
            print('PDF 資源：' + ('已準備' if health.get('pdf_assets_ready') else '尚未準備，可在設定頁下載'))
            print('語音模型：' + ('已準備' if health.get('speech_ready') else '尚未準備，可在設定頁下載'))
            return 0 if action == 'reuse' and health.get('ollama') and health.get('selected_model') in health.get('models', []) else 2
        child = ensure_running(ROOT, args.data_dir)
        return child.wait() if child else 0
    except StartupError as error:
        print(legacy_message(error, ROOT), file=sys.stderr, flush=True)
        return 1
    except KeyboardInterrupt:
        return 130
    except OSError:
        print('啟動失敗。請確認資料夾寫入權限、磁碟空間及 Python 環境；不要刪除 data。', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
