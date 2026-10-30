"""Isolated BabelDOC process. Pinned integration; document cache stays inside its job."""
from __future__ import annotations
import json
import logging
import os
from pathlib import Path
import sys
from unittest.mock import patch
from pdf_progress import write_progress, track_events


def configure_assets(asset_dir, job_cache=None):
    asset_dir = Path(asset_dir).resolve()
    asset_dir.mkdir(parents=True, exist_ok=True)
    # BabelDOC 0.6.4 has no configurable cache root. Override Path.home only while
    # importing its constants, then use explicit folders; do not change OS settings.
    with patch.object(Path, "home", return_value=asset_dir / "home"):
        import babeldoc.const as constants
    constants.CACHE_FOLDER = asset_dir / "cache"
    constants.CACHE_FOLDER.mkdir(parents=True, exist_ok=True)
    constants.TIKTOKEN_CACHE_FOLDER = constants.CACHE_FOLDER / "tiktoken"
    constants.TIKTOKEN_CACHE_FOLDER.mkdir(parents=True, exist_ok=True)
    os.environ["TIKTOKEN_CACHE_DIR"] = str(constants.TIKTOKEN_CACHE_FOLDER)
    if job_cache is not None:
        shared = constants.CACHE_FOLDER
        constants.CACHE_FOLDER = Path(job_cache)
        import babeldoc.translator.cache  # initializes the DB in job_cache
        constants.CACHE_FOLDER = shared


def add_ocr_layer(source, destination):
    """English black-on-white scans only; image content is preserved unchanged."""
    import numpy as np
    import pymupdf
    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()
    found = 0
    with pymupdf.open(source) as document:
        for index,page in enumerate(document):
            write_progress(Path(destination).parent,'ocr',index,len(document))
            if len(page.get_text().strip()) > 30:
                continue
            pix = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
            image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            result, _ = engine(image)
            for polygon, text, confidence in result or []:
                if confidence < .6 or not text.strip(): continue
                # Tiny chart labels are better retained as original pixels. Giving
                # them an OCR box can make the layout engine erase part of a glyph.
                if len(text.strip()) < 3 or text.strip().isdigit(): continue
                # This mode is deliberately scoped to English scans.
                if any(ord(character) > 255 for character in text): continue
                xs, ys = [p[0] / 2 for p in polygon], [p[1] / 2 for p in polygon]
                width, height = max(xs) - min(xs), max(ys) - min(ys)
                fontsize = min(height * .8, width / max(pymupdf.get_text_length(text, fontsize=1), .1))
                if fontsize < 3: continue
                page.insert_text((min(xs), min(ys) + fontsize), text, fontname="helv", fontsize=fontsize, render_mode=3)
                found += 1
        if found == 0 and not any(page.get_text().strip() for page in document):
            raise RuntimeError("OCR_EMPTY")
        document.save(destination)
        write_progress(Path(destination).parent,'ocr',len(document),len(document))


def run(directory):
    directory = Path(directory).resolve()
    options = json.loads((directory / "options.json").read_text(encoding="utf-8"))
    write_progress(directory,'analysis')
    assets = Path(os.environ["QINGREAD_ASSETS"])
    configure_assets(assets, directory / "cache")
    import babeldoc.main
    if babeldoc.main.__version__ != "0.6.4":
        raise RuntimeError("PDF_VERSION")
    source = directory / "input.pdf"
    if options["scanned"]:
        if options["source"] != "en": raise RuntimeError("OCR_LANGUAGE")
        source = directory / "ocr.pdf"
        add_ocr_layer(directory / "input.pdf", source)
    output = directory / "output"
    args = ["babeldoc", "--files", str(source), "--output", str(output), "--working-dir", str(directory / "work"),
            "--lang-in", options["source"], "--lang-out", "zh-TW", "--openai",
            "--openai-model", options["model"], "--openai-base-url", options["base_url"],
            "--openai-api-key", options["token"], "--qps", "1", "--pool-max-workers", "1",
            "--no-auto-extract-glossary", "--watermark-output-mode", "no_watermark",
            "--custom-system-prompt", "/no_think Translate faithfully into Traditional Chinese used in Taiwan. Preserve all formula placeholders, tags, identifiers and numbers exactly. Return only the requested translation."]
    if options["pages"]: args += ["--pages", options["pages"]]
    if options["scanned"]: args += ["--ocr-workaround"]
    sys.argv = args
    # Avoid saving or printing document contents through third-party diagnostics.
    logging.disable(logging.CRITICAL)
    import babeldoc.format.pdf.high_level as high_level
    original=high_level.async_translate
    state={'finished':False,'error':False}
    def tracked(*args,**kwargs):return track_events(original(*args,**kwargs),directory,state)
    with patch.object(high_level,'async_translate',tracked):
        babeldoc.main.cli()
    if state['error'] or not state['finished']:raise RuntimeError(state.get('error_code','PDF_NO_OUTPUT'))
    write_progress(directory,'output')
    if not list(output.glob("*.pdf")):
        raise RuntimeError("PDF_NO_OUTPUT")
    (directory / "result.json").write_text(json.dumps({"ok": True}), encoding="utf-8")


if __name__ == "__main__":
    directory = Path(sys.argv[1]).resolve()
    try:
        run(directory)
    except BaseException as error:
        code = str(error) if str(error) in {"OCR_EMPTY", "OCR_LANGUAGE", "PDF_VERSION", "PDF_NO_OUTPUT","PDF_SCAN_DETECTED"} else type(error).__name__
        message='文件引擎判定為掃描 PDF。請確認掃描模式；若原檔可選取文字，可先用不同頁碼測試。' if code=='PDF_SCAN_DETECTED' else "文件引擎失敗（" + code + "）。請確認資源已準備，並以少量頁數重試。"
        (directory / "result.json").write_text(json.dumps({"ok": False, "message":message}, ensure_ascii=False), encoding="utf-8")
        raise SystemExit(1)
