"""从已安装的 RapidOCR 标准模型制作可拷贝到断网 Windows 的能力包。"""

from __future__ import annotations

import hashlib
import json
from importlib.metadata import version
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import rapidocr


ROOT = Path(__file__).resolve().parent
SOURCE = Path(rapidocr.__file__).parent / "models"
OUTPUT = ROOT.parent / "output" / "Zhanlu-OCR-standard-offline.zip"
FILES = (
    "PP-OCRv6_det_small.onnx",
    "PP-OCRv6_rec_small.onnx",
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
)


def main() -> None:
    manifest = {"tier": "standard", "rapidocr_version": version("rapidocr"), "files": []}
    for name in FILES:
        path = SOURCE / name
        if not path.is_file() or path.stat().st_size < 100_000:
            raise RuntimeError(f"标准档 OCR 模型缺失或不完整：{path}")
        manifest["files"].append({
            "name": name,
            "size": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        })

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUTPUT, "w", ZIP_DEFLATED, compresslevel=6) as package:
        package.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        # Windows PowerShell 5.1 treats a script without BOM as ANSI.
        package.writestr("install.ps1", b"\xef\xbb\xbf" + (ROOT / "ocr_offline_pack" / "install.ps1").read_bytes())
        package.write(ROOT / "ocr_offline_pack" / "README.txt", "README.txt")
        for name in FILES:
            package.write(SOURCE / name, f"models/{name}")
    print(f"{OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
