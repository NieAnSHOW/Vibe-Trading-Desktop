"""Verify the Windows-native Tauri background and bundled icon resources."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image


REQUIRED_SIZES = frozenset({16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256})
REPO_ROOT = Path(__file__).resolve().parents[1]
WINDOWS_CONFIG_PATH = REPO_ROOT / "src-tauri" / "tauri.windows.conf.json"
ICON_PATH = REPO_ROOT / "src-tauri" / "icons" / "icon.ico"


def main() -> None:
    """Assert that the Windows launch surface and ICO meet the asset contract."""
    config = json.loads(WINDOWS_CONFIG_PATH.read_text(encoding="utf-8"))
    window = config["app"]["windows"][0]
    assert window["backgroundColor"] == "#323d43"

    with Image.open(ICON_PATH) as icon:
        icon_sizes = {width for width, height in icon.info["sizes"] if width == height}
    assert REQUIRED_SIZES <= icon_sizes

    print("Windows bundle assets verified")


if __name__ == "__main__":
    main()
