"""Identify loaded helper code without exposing paths or credentials."""
import hashlib
import os
from pathlib import Path


def source_revision(root):
    root = Path(root)
    digest = hashlib.sha256()
    try:
        files = sorted(root.glob('*.py')) + [root / 'requirements-lock.txt']
        if not files or not (root / 'app.py').is_file():
            return None
        for file in files:
            content = file.read_bytes()
            digest.update(file.name.encode('utf-8') + b'\0')
            digest.update(len(content).to_bytes(8, 'big') + content)
        return digest.hexdigest()
    except OSError:
        return None


def installation_id(root, data):
    paths = [os.path.normcase(str(Path(path).resolve())) for path in (root, data)]
    return hashlib.sha256('\0'.join(paths).encode('utf-8')).hexdigest()
