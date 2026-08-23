"""venv 路径解析与创建 —— stdlib venv,零额外打包负担(设计 D2)。"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

_PROBE_TIMEOUT_S = 30.0


def venv_dir(home_vibe: Path) -> Path:
    """Return ``<home_vibe>/venv``."""
    return home_vibe / "venv"


def venv_python(home_vibe: Path) -> Path:
    """Return the venv interpreter path for the current platform."""
    vd = venv_dir(home_vibe)
    if sys.platform.startswith("win"):
        return vd / "Scripts" / "python.exe"
    return vd / "bin" / "python"


def _venv_healthy(py: Path) -> bool:
    """venv 解释器能否独立完成初始化。

    ``-I`` 忽略 PYTHONHOME/PYTHONPATH 等环境干扰,恰好检验 venv 经
    pyvenv.cfg 绑定的基础运行时是否仍然可用:基础运行时被移走或丢失
    标准库时,解释器启动即 fatal(init_fs_encoding / no 'encodings')。
    """
    try:
        proc = subprocess.run(
            [str(py), "-I", "-c", "pass"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=_PROBE_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0


def ensure_venv(home_vibe: Path) -> Path:
    """Create the venv if absent; return the interpreter path.

    Idempotent: an existing *working* venv (interpreter present and able to
    start) is reused. A venv left over from a removed/moved python runtime
    (pyvenv.cfg ``home`` gone, interpreter dies at startup) is rebuilt from
    scratch — 复用残缺 venv 会让后续 pip install 永久失败。
    """
    py = venv_python(home_vibe)
    if py.exists() and _venv_healthy(py):
        return py
    if venv_dir(home_vibe).exists():
        shutil.rmtree(venv_dir(home_vibe))
    home_vibe.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [sys.executable, "-m", "venv", str(venv_dir(home_vibe))],
        check=True,
        stdin=subprocess.DEVNULL,
    )
    return py
