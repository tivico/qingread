"""Runtime freshness, authenticated idle handoff, and isolated real startup."""
import contextlib
import io
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'companion'))
from app import Companion, make_server
from runtime_status import installation_id, source_revision
from launcher import StartupError, choose_action, ensure_running, request, read_token, legacy_message, legacy_process_details


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        (ROOT / 'test-results').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / 'test-results')
        self.addCleanup(self.temp.cleanup)
        self.app = Companion(self.temp.name, lambda *a, **k: {'models': []})
        self.addCleanup(self.app.inference_jobs.close)

    def test_health_detects_same_version_changed_code_without_exposing_paths_or_tokens(self):
        health = self.app.health()
        self.assertFalse(health['runtime']['updateRequired'])
        self.assertEqual(len(health['runtime']['revision']), 64)
        self.assertNotIn(self.app.config['token'], json.dumps(health))
        self.assertNotIn(str(self.app.data), json.dumps(health))
        with patch('app.source_revision', return_value='f' * 64):
            changed = self.app.health()
        self.assertEqual(health['version'], changed['version'])
        self.assertTrue(changed['runtime']['updateRequired'])

    def test_fingerprint_tracks_sources_and_dependencies_but_ignores_personal_data(self):
        root = Path(self.temp.name)
        (root / 'app.py').write_text('one')
        (root / 'requirements-lock.txt').write_text('dependency')
        before = source_revision(root)
        (root / 'config.json').write_text('personal')
        self.assertEqual(before, source_revision(root))
        (root / 'app.py').write_text('two')
        self.assertNotEqual(before, source_revision(root))
        (root / 'requirements-lock.txt').unlink()
        self.assertIsNone(source_revision(root))

    def server(self):
        server = make_server(self.app, 0)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), worker.join(3)))
        return server

    def stop(self, server, **overrides):
        body = {'installationId': self.app.installation_id, 'revision': self.app.runtime_revision}
        body.update(overrides)
        return request('/maintenance/stop', self.app.config['token'], body, port=server.server_port)

    def test_idle_stop_rejects_other_installations_and_all_kinds_of_active_work(self):
        server = self.server()
        with self.assertRaisesRegex(StartupError, '不一致'):
            self.stop(server, installationId='f' * 64)
        resources = [self.app.inference, self.app.speech_lock]
        for resource in resources:
            resource.acquire()
            try:
                with self.assertRaisesRegex(StartupError, '還有'):
                    self.stop(server)
            finally:
                resource.release()
        job, _ = self.app.new_job('pdf')
        with self.assertRaisesRegex(StartupError, '還有'):
            self.stop(server)
        job['state'] = 'done'
        self.app.pairing.dialog_active = True
        with self.assertRaisesRegex(StartupError, '還有'):
            self.stop(server)
        self.app.pairing.dialog_active = False
        server.active_requests = 1
        with self.assertRaisesRegex(StartupError, '還有'):
            self.stop(server)
        server.active_requests = 0
        self.assertFalse(server.stopping)
        self.assertTrue(self.stop(server)['stopping'])
        self.assertTrue(server.stopping)

    def test_stop_requires_authentication_and_rejects_web_origins(self):
        server = self.server()
        for token, origin, expected in [('wrong', None, 401), (self.app.config['token'], 'https://web.test', 403)]:
            req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/maintenance/stop', data=b'{}',
                headers={'Authorization': 'Bearer ' + token, **({'Origin': origin} if origin else {})})
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=3)
            self.assertEqual(error.exception.code, expected)
            error.exception.close()
        self.assertFalse(server.stopping)

    def test_stale_helper_rejects_new_work_while_reads_and_cancellation_remain_available(self):
        server = self.server()
        with patch('app.source_revision', return_value='f' * 64):
            self.assertTrue(request('/health', self.app.config['token'], port=server.server_port)['runtime']['updateRequired'])
            with self.assertRaises(StartupError):
                request('/translate', self.app.config['token'], {'text': 'private source'}, port=server.server_port)
            self.assertEqual(request('/jobs', self.app.config['token'], port=server.server_port)['jobs'], [])
        self.assertFalse(server.stopping)

    def test_stop_cannot_race_an_admitted_request(self):
        entered, release = threading.Event(), threading.Event()
        server = self.server()
        outcome = []
        def translate(*args):
            entered.set()
            release.wait(4)
            return {'text': '譯文'}
        def run():
            try:
                outcome.append(request('/translate', self.app.config['token'], {'text': 'sample'}, port=server.server_port))
            except Exception as error:
                outcome.append(error)
        with patch.object(self.app, 'translate', side_effect=translate):
            worker = threading.Thread(target=run)
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                with self.assertRaisesRegex(StartupError, '還有'):
                    self.stop(server)
            finally:
                release.set(); worker.join(5)
        self.assertEqual(outcome, [{'text': '譯文'}])
        self.assertTrue(self.stop(server)['stopping'])

    def test_stopping_refuses_late_posts_without_starting_work(self):
        server = self.server()
        server.stopping = True
        with patch.object(self.app, 'translate') as translate:
            with self.assertRaises(StartupError):
                request('/translate', self.app.config['token'], {'text': 'sample'}, port=server.server_port)
            translate.assert_not_called()
        self.assertEqual(server.active_requests, 0)

    def test_launcher_reuses_current_rejects_legacy_and_never_targets_another_installation(self):
        root, data = ROOT / 'companion', Path(self.temp.name)
        health = self.app.health()
        self.assertEqual(choose_action(health, root, data), 'reuse')
        health['runtime']['revision'] = 'e' * 64
        self.assertEqual(choose_action(health, root, data), 'update')
        with self.assertRaises(StartupError):
            choose_action(health, root / 'elsewhere', data)
        with self.assertRaisesRegex(StartupError, '首次升級'):
            choose_action({'version': '0.3.9'}, root, data)
        (data / 'config.json').write_text('{broken')
        with self.assertRaises(StartupError):
            read_token(data)

    def test_legacy_error_distinguishes_background_helper_and_reports_only_verified_pid(self):
        with self.assertRaises(StartupError) as caught:
            choose_action({'version': '0.3.9'}, ROOT / 'companion', self.temp.name)
        self.assertEqual(caught.exception.code, 'LEGACY_HELPER')
        self.assertIn('關閉這個提示視窗不會關閉舊助手', str(caught.exception))
        with patch('launcher.legacy_process_details', return_value=[{'processId': 12345, 'startedAt': '2026-11-05 10:56:10'}]):
            message = legacy_message(caught.exception, ROOT / 'companion')
        self.assertIn('PID 12345', message)
        self.assertIn('詳細資料', message)
        with patch('launcher.legacy_process_details', return_value=[]):
            self.assertIn('未能核對', legacy_message(caught.exception, ROOT / 'companion'))

    def test_legacy_diagnostics_handle_unavailable_or_malformed_process_metadata(self):
        from types import SimpleNamespace
        with patch('launcher.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='[{"processId":0,"startedAt":"2026-11-05 10:00:00"},{"processId":123,"startedAt":"2026-11-05 10:00:00"}]')):
            if sys.platform == 'win32':
                self.assertEqual(legacy_process_details(ROOT / 'companion'), [{'processId':123,'startedAt':'2026-11-05 10:00:00'}])
        with patch('launcher.subprocess.run', side_effect=OSError()):
            self.assertEqual(legacy_process_details(ROOT / 'companion'), [])

    def test_real_launcher_deduplicates_and_updates_its_own_idle_child_preserving_config(self):
        root = Path(self.temp.name) / 'isolated-helper'
        root.mkdir()
        for file in (ROOT / 'companion').glob('*.py'):
            shutil.copy2(file, root / file.name)
        shutil.copy2(ROOT / 'companion/requirements-lock.txt', root / 'requirements-lock.txt')
        data = root / 'data'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        real_popen, children = subprocess.Popen, []
        def spawn(*args, **kwargs):
            child = real_popen(*args, **kwargs, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            children.append(child)
            return child
        try:
            with patch('launcher.subprocess.Popen', side_effect=spawn), contextlib.redirect_stdout(io.StringIO()):
                first = ensure_running(root, data, port)
                config = (data / 'config.json').read_bytes()
                self.assertIsNone(ensure_running(root, data, port))
                with (root / 'prepare.py').open('a', encoding='utf-8') as file:
                    file.write('\n# isolated update test\n')
                second = ensure_running(root, data, port)
                self.assertIsNot(first, second)
                self.assertEqual(first.wait(5), 0)
                self.assertEqual((data / 'config.json').read_bytes(), config)
                self.assertIsNone(ensure_running(root, data, port))
                self.assertEqual(len(children), 2)
            token = read_token(data)
            health = request('/health', token, port=port)
            self.assertFalse(health['runtime']['updateRequired'])
            request('/maintenance/stop', token, {'installationId': installation_id(root, data),
                    'revision': health['runtime']['revision']}, port=port)
            self.assertEqual(second.wait(5), 0)
        finally:
            for child in children:
                if child.poll() is None:
                    child.terminate()
                child.wait(5)


if __name__ == '__main__':
    unittest.main()
