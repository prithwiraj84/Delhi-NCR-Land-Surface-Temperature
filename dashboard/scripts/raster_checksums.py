"""Regenerate src/data/__fixtures__/demo_raster_checksums.json from public/demo/raster/*.png with Pillow.

The vitest "decodes every demo raster to the same R/G bytes as Pillow" (reviewFixes.data.test.js) compares the
pure-JS PNG decoder against these Pillow-derived checksums (D22 d). Run it after the demo bundle is regenerated:

    python dashboard/scripts/raster_checksums.py

Needs Pillow and NumPy (the notebook's local venv has both).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RASTER_DIR = ROOT / "public" / "demo" / "raster"
OUT = ROOT / "src" / "data" / "__fixtures__" / "demo_raster_checksums.json"


def _sha1(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


def main() -> None:
    files = {}
    for path in sorted(RASTER_DIR.glob("*.png")):
        img = Image.open(path)
        mode = img.mode
        arr = np.asarray(img.convert("RGB"), dtype=np.uint8)
        files[path.name] = {
            "mode": mode,
            "width": int(arr.shape[1]),
            "height": int(arr.shape[0]),
            "r_sha1": _sha1(np.ascontiguousarray(arr[:, :, 0]).tobytes()),
            "g_sha1": _sha1(np.ascontiguousarray(arr[:, :, 1]).tobytes()),
            "file_sha1": _sha1(path.read_bytes()),
        }
    if not files:
        raise SystemExit(f"no PNG rasters under {RASTER_DIR}")
    doc = {"source": "PIL (Pillow) decode of dashboard/public/demo/raster/*.png; sha1 of the R (value) and G (flags) "
                     "planes, row-major; regenerate with dashboard/scripts/raster_checksums.py",
           "files": files}
    OUT.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(files)} checksums to {OUT}")


if __name__ == "__main__":
    main()
