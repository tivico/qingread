"""Package a disposable source tree; never package the user's local data."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which('pwsh') or shutil.which('powershell')


@unittest.skipUnless(os.name == 'nt' and POWERSHELL, 'Windows PowerShell packaging')
class PackageTest(unittest.TestCase):
    def setUp(self):
        (ROOT / 'test-results').mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=ROOT / 'test-results')
        self.root = Path(self.temporary.name)
        for folder in ('extension', 'tests', 'scripts', 'docs'):
            shutil.copytree(ROOT / folder, self.root / folder,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        (self.root / 'companion').mkdir()
        for item in (ROOT / 'companion').iterdir():
            if item.is_file() and item.suffix in ('.py', '.cmd', '.txt'):
                shutil.copy2(item, self.root / 'companion' / item.name)
        shutil.copytree(ROOT / 'companion/licenses', self.root / 'companion/licenses')
        for name in ('README.md', 'CHANGELOG.md', 'THIRD_PARTY.md', 'package.json', '.gitignore', '.gitattributes'):
            shutil.copy2(ROOT / name, self.root / name)
        self.version = json.loads((self.root / 'package.json').read_text(encoding='utf-8'))['version']

    def tearDown(self):
        self.temporary.cleanup()

    def package(self):
        return subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-File',
                               str(self.root / 'scripts/package.ps1')], cwd=self.root,
                              capture_output=True, text=True, encoding='utf-8', timeout=90)

    def test_archives_include_current_sources_docs_and_hashes_but_exclude_local_data(self):
        marker = secrets.token_urlsafe(32).encode()
        for name in ('companion/data/config.json', 'companion/.venv/private.txt',
                     'extension/private-note.txt', 'extension/private.json',
                     'tests/__pycache__/private.pyc', 'tests/private.pdf', '.env'):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(marker)
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        names = [f'qingread-{self.version}.zip', f'qingread-complete-{self.version}.zip']
        for name in names:
            with zipfile.ZipFile(self.root / 'releases' / name) as archive:
                files = {item.filename.replace('\\', '/'): archive.read(item)
                         for item in archive.infolist() if not item.is_dir()}
            self.assertTrue(files)
            for relative, content in files.items():
                self.assertFalse(relative.startswith('/'))
                self.assertNotIn('..', relative.split('/'))
                self.assertNotIn(marker, content)
                original = self.root / ('extension' if name == names[0] else '') / relative
                self.assertEqual(content, original.read_bytes(), relative)
            if name == names[0]:
                self.assertIn('manifest.json', files)
                self.assertIn('video-offscreen.js', files)
                self.assertIn('INSTALL.txt', files)
                self.assertNotIn('private.json', files)
                self.assertEqual(json.loads(files['manifest.json'])['version'], self.version)
            else:
                for required in ('docs/PROGRESS.md', 'CHANGELOG.md', 'README.md', '.gitignore',
                                 'companion/install.cmd', 'companion/start.cmd',
                                 'companion/licenses/BabelDOC-AGPL-3.0.txt',
                                 'tests/fixtures/youtube-caption-timing.json', 'scripts/package.ps1'):
                    self.assertIn(required, files)
                self.assertFalse(any('/data/' in p or '/.venv/' in p or '__pycache__' in p for p in files))
        metadata = json.loads((self.root / 'releases' / f'qingread-{self.version}-release.json').read_text(encoding='utf-8-sig'))
        sums = (self.root / 'releases' / f'qingread-{self.version}-SHA256SUMS.txt').read_text()
        self.assertEqual(metadata['version'], self.version)
        self.assertEqual({a['name'] for a in metadata['artifacts']}, set(names))
        for artifact in metadata['artifacts']:
            content = (self.root / 'releases' / artifact['name']).read_bytes()
            self.assertEqual(artifact['bytes'], len(content))
            self.assertEqual(artifact['sha256'], hashlib.sha256(content).hexdigest())
            self.assertIn(artifact['sha256'] + '  ' + artifact['name'], sums)
        self.assertEqual(list((self.root / 'build').glob('package-*')), [])

    def test_version_mismatch_stops_before_creating_release_archives(self):
        app = self.root / 'companion/app.py'
        app.write_text(app.read_text(encoding='utf-8').replace(
            f'VERSION = "{self.version}"', 'VERSION = "0.0.0"'), encoding='utf-8')
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('versions must match', result.stderr + result.stdout)
        self.assertFalse((self.root / 'releases').exists())


if __name__ == '__main__':
    unittest.main()
