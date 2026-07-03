"""requirements.txt hash marker —— 增量同步判定(设计 D5)。

启动比对 requirements.txt 的 sha256 与 marker;不一致则跑 pip install -r
(pip 自做差量,已满足的跳过),而非删重建整个 venv。照搬 runtime_dir.rs 的
.installed_version marker 模式。
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional


def compute_hash(requirements: Path) -> str:
    """Return the sha256 hex of the requirements file bytes."""
    return hashlib.sha256(requirements.read_bytes()).hexdigest()


def read_marker(marker: Path) -> Optional[str]:
    """Return the stored hash, or None when the marker is absent/unreadable."""
    try:
        return marker.read_text(encoding="utf-8").strip()
    except OSError:
        return None


def write_marker(marker: Path, digest: str) -> None:
    """Persist the requirements hash to the marker file."""
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(digest, encoding="utf-8")


def needs_sync(requirements: Path, marker: Path) -> bool:
    """True when requirements changed since the last recorded install."""
    return read_marker(marker) != compute_hash(requirements)
