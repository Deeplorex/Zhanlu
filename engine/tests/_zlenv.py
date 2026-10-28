"""测试共享环境：在任何 zhanlu 导入前固定 ZHANLU_HOME（unittest 按字母序导入模块）。"""

import os
import tempfile
from pathlib import Path

os.environ["ZHANLU_HOME"] = os.environ.get("ZHANLU_HOME") or str(
    Path(tempfile.mkdtemp(prefix="zhanlu-test-")) / "home")

_TMP = Path(os.environ["ZHANLU_HOME"]).parent
