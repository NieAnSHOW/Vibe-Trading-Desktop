"""Detect the current platform tag and pre-check wheel availability.

The install API rejects a package whose registry ``platforms`` list does
not include the current tag — this avoids triggering a source build
(which would fail without a local compiler) for packages like
``vnpy_ctp`` that only ship a ``win_amd64`` wheel.
"""

from __future__ import annotations

import platform as _platform
import sys
from typing import Iterable


def current_platform_tag() -> str:
    """Return the registry platform tag for the running interpreter.

    Maps the Python ``platform.machine()`` + ``sys.platform`` to one of
    the registry's known tags.
    """
    machine = _platform.machine().lower()
    if sys.platform.startswith("win"):
        # CPython wheels on 64-bit Windows are tagged ``win_amd64``.
        return "windows_amd64"
    if sys.platform == "darwin":
        if machine in {"arm64", "aarch64"}:
            return "macos_arm64"
        return "macos_x86_64"
    # Linux desktop is not a first-class target for this change, but we
    # tag it as the closest arch so a Linux dev box can still install the
    # pure-Python brokers for testing.
    if machine in {"arm64", "aarch64"}:
        return "macos_arm64"
    return "macos_x86_64"


def is_supported_on_current_platform(supported: Iterable[str]) -> bool:
    """Return True when the current tag is in ``supported``.

    An empty ``supported`` list means "no platform restriction declared"
    (treat as universally available) so a registry entry with a missing
    platforms field does not block every install.
    """
    tags = list(supported)
    if not tags:
        return True
    return current_platform_tag() in tags
