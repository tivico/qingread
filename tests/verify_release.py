"""Verify the actual release ZIPs, helper health and optionally native Chrome."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    results = ROOT / 'test-results'
    results.mkdir(exist_ok=True)
    metadata = json.loads((ROOT / 'releases' / f'qingread-{version}-release.json').read_text(encoding='utf-8-sig'))
    assert metadata['version'] == version
    report = {'version': version, 'archives': [], 'nativeChrome': False}
    with tempfile.TemporaryDirectory(prefix='release-check-', dir=results) as directory:
        extracted = Path(directory)
        for artifact in metadata['artifacts']:
            name = artifact['name']
            assert name in (f'qingread-{version}.zip', f'qingread-complete-{version}.zip')
            raw = (ROOT / 'releases' / name).read_bytes()
            assert len(raw) == artifact['bytes']
            assert hashlib.sha256(raw).hexdigest() == artifact['sha256']
            complete = name.startswith('qingread-complete-')
            with zipfile.ZipFile(ROOT / 'releases' / name) as archive:
                count = 0
                for item in archive.infolist():
                    relative = item.filename.replace('\\', '/')
                    path = PurePosixPath(relative)
                    assert not path.is_absolute() and '..' not in path.parts and ':' not in relative
                    assert not any(p in ('.venv', 'data', '__pycache__', 'test-results', 'output', '.git') for p in path.parts)
                    if item.is_dir():
                        continue
                    content = archive.read(item)
                    original = ROOT / ('' if complete else 'extension') / relative
                    assert original.read_bytes() == content, relative
                    if complete:
                        target = extracted / relative
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(content)
                    count += 1
            report['archives'].append({'name': name, 'files': count, 'sha256': artifact['sha256']})
        assert len(report['archives']) == 2
        helper = subprocess.Popen([sys.executable, str(extracted / 'tests/inference_fixture_server.py')],
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            port = json.loads(helper.stdout.readline())['port']
            request = urllib.request.Request(f'http://127.0.0.1:{port}/health', headers={'Authorization': 'Bearer ' + 'a' * 43})
            with urllib.request.urlopen(request, timeout=10) as response:
                health = json.load(response)
            assert health['version'] == version
            for capability in ('inference_jobs', 'inference_client_identity', 'video_inference', 'pdf_preview'):
                assert health[capability] is True, capability
            report['companionVersion'] = health['version']
            report['companionCapabilities'] = True
        finally:
            helper.terminate()
            helper.wait(timeout=10)
        if '--native' in sys.argv:
            env = os.environ.copy()
            env.pop('LIVE_SUMMARY', None)
            env.pop('CAPTURE_SUMMARY_SOURCE', None)
            env['QINGREAD_EXTENSION_PATH'] = str(extracted / 'extension')
            subprocess.run(['node', str(ROOT / 'tests/extension-smoke.cjs')], cwd=ROOT,
                           env=env, check=True, timeout=120)
            native = json.loads((results / 'extension-smoke.json').read_text(encoding='utf-8'))
            assert native['loaded'] is True and native['version'] == version
            assert native['realTranslationDisplayToggle'] is True
            report['nativeChrome'] = True
    report['passed'] = True
    (results / 'release-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
