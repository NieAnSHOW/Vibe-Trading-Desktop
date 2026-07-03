"""会话目录解析:VIBE_SESSIONS_DIR 覆盖,未设则用代码相对默认。

照搬 cli/main.py 的 VIBE_RUNTIME_LIBS 模式(env 注入路径,未设时不变)。
桌面 sidecar 设 VIBE_SESSIONS_DIR=~/.vibe-trading/sessions/,使会话幸存
runtime/ 重建;本地/Docker 未设该 env,逐字节回退到 code_default —— 与
重构前行为一致(设计文档 D4)。
"""

from __future__ import annotations

import os
from pathlib import Path


def resolve_sessions_dir(code_default: Path) -> Path:
    """Return the sessions dir, honoring VIBE_SESSIONS_DIR when set & non-empty.

    Args:
        code_default: 调用方的代码相对默认(重构前的路径),env 未设时返回它。

    Returns:
        VIBE_SESSIONS_DIR 指向的路径(设置且非空),否则 ``code_default``。
    """
    override = os.environ.get("VIBE_SESSIONS_DIR")
    if override and override.strip():
        return Path(override)
    return code_default
