"""Short-lived, locally approved pairing. No tokens or requests are written to disk."""
import ctypes
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time

PAIR_TTL = 120


def confirm_on_desktop(origin, code, cancelled):
    if os.name != 'nt':
        raise RuntimeError('Desktop confirmation requires Windows')
    # A separate process allows cancellation/expiry to close the native dialog.
    process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), origin, code],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    deadline = time.monotonic() + 90
    try:
        while process.poll() is None:
            if cancelled.wait(.1) or time.monotonic() >= deadline:
                return False
        if process.returncode not in (0, 1, 2):
            raise RuntimeError('Desktop confirmation failed')
        return process.returncode == 0
    finally:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=5)


class Pairing:
    def __init__(self, confirm=confirm_on_desktop, clock=time.monotonic):
        self.confirm, self.clock = confirm, clock
        self.lock = threading.Lock()
        self.pending = None
        self.dialog_active = False
        self.next_start = 0

    def start(self, origin, nonce):
        with self.lock:
            if self.dialog_active or self.clock() < self.next_start:
                return None
            if self.pending:
                self.pending['cancel'].set()
            request = dict(id=secrets.token_urlsafe(32), origin=origin, nonce=nonce,
                code=f'{secrets.randbelow(1000000):06d}', expires=self.clock()+PAIR_TTL,
                state='pending', cancel=threading.Event())
            self.pending = request
            self.dialog_active = True
            self.next_start = self.clock() + 10
        threading.Thread(target=self._confirm, args=(request,), daemon=True).start()
        return {'id': request['id'], 'code': request['code'], 'expires_in': PAIR_TTL}

    def _confirm(self, request):
        try:
            state = 'approved' if self.confirm(request['origin'], request['code'], request['cancel']) else 'denied'
        except Exception:
            state = 'unavailable'
        with self.lock:
            if request['state'] == 'pending' and not request['cancel'].is_set():
                request['state'] = state if self.clock() < request['expires'] else 'expired'
            self.dialog_active = False

    def poll(self, origin, identifier, nonce, cancel=False):
        with self.lock:
            request = self.pending
            if not request or request['origin'] != origin or not secrets.compare_digest(request['id'], identifier) or not secrets.compare_digest(request['nonce'], nonce):
                return None
            if cancel or self.clock() >= request['expires']:
                request['cancel'].set()
                request['state'] = 'cancelled' if cancel else 'expired'
            state = request['state']
            # Successful credential delivery and terminal responses are single-use.
            if state != 'pending':
                self.pending = None
            return {'state': state}

    def close(self):
        with self.lock:
            if self.pending:
                self.pending['cancel'].set()


if __name__ == '__main__':
    origin, code = sys.argv[1:]
    # Also expire if the parent is forcibly closed while the dialog is open.
    expiry = threading.Timer(90, lambda: os._exit(2))
    expiry.daemon = True
    expiry.start()
    message = (f'瀏覽器外掛要求連接這台電腦的清讀助手。\n\n'
               f'確認數字：{code}\n\n'
               '請確認清讀「連接本機助手」畫面顯示相同數字。\n'
               '允許後，此外掛可使用本機翻譯、摘要、語音與文件功能。\n'
               '若不是你剛剛發起的連線，請選「否」。\n\n'
               f'外掛識別：{origin.removeprefix("chrome-extension://")}\n\n'
               '允許連接嗎？（此視窗最多顯示 90 秒）')
    # Yes/No, question icon, default No, foreground, topmost. No credential in UI/argv.
    result = ctypes.windll.user32.MessageBoxW(None, message, '清讀 · 允許本機連線', 0x4 | 0x20 | 0x100 | 0x10000 | 0x40000)
    if result == 0:
        sys.exit(3)
    sys.exit(0 if result == 6 else 1)
