"""Explicit first-run resource download; never takes a document or recording."""
import json
from pathlib import Path
import sys
from pdf_worker import configure_assets


def main():
    kind, root = sys.argv[1], Path(sys.argv[2]).resolve()
    if kind == "speech":
        from faster_whisper.utils import download_model
        download_model("small", output_dir=str(root / "models" / "whisper-small"))
    elif kind == "pdf-assets":
        configure_assets(root / "assets")
        import babeldoc.main
        sys.argv = ["babeldoc", "--warmup"]
        # Warmup may finish through SystemExit(0).
        try: babeldoc.main.cli()
        except SystemExit as error:
            if error.code not in (None, 0): raise
        (root / "assets" / "ready.json").write_text(json.dumps({"babeldoc": "0.6.4"}), encoding="utf-8")
    else:
        raise ValueError("Unknown resource type")


if __name__ == "__main__": main()
