"""venv 路径解析与创建 —— stdlib venv,零额外打包负担(设计 D2)。"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def venv_dir(home_vibe: Path) -> Path:
    """Return ``<home_vibe>/venv``."""
    return home_vibe / "venv"


def venv_python(home_vibe: Path) -> Path:
    """Return the venv interpreter path for the current platform."""
    vd = venv_dir(home_vibe)
    if sys.platform.startswith("win"):
        return vd / "Scripts" / "python.exe"
    return vd / "bin" / "python"


def ensure_venv(home_vibe: Path) -> Path:
    """Create the venv if absent; return the interpreter path.

    Idempotent: an existing venv (interpreter present) is reused, matching
    the "venv 已就绪则跳过" scenario.
    """
    py = venv_python(home_vibe)
    if py.exists():
        return py
    home_vibe.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [sys.executable, "-m", "venv", str(venv_dir(home_vibe))],
        check=True,
        stdin=subprocess.DEVNULL,
    )
    return py
