"""Build the Windows ICO from the Trading Worker master mark."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from struct import pack

from PIL import Image


WINDOWS_ICON_SIZES = (16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256)
REPO_ROOT = Path(__file__).resolve().parents[1]
MASTER_ICON_PATH = REPO_ROOT / "src-tauri" / "icons" / "icon.png"
OUTPUT_PATH = REPO_ROOT / "src-tauri" / "icons" / "icon.ico"
SMALL_ICON_CROP = (24, 24, 488, 488)


def png_frame(master: Image.Image, size: int) -> bytes:
    """Render one Windows icon frame, enlarging the mark slightly when small."""
    source = master.crop(SMALL_ICON_CROP) if size <= 48 else master
    frame = source.resize((size, size), Image.Resampling.LANCZOS)
    data = BytesIO()
    frame.save(data, format="PNG", optimize=True)
    return data.getvalue()


def build_ico(frames: list[tuple[int, bytes]]) -> bytes:
    """Package PNG icon frames into a Windows ICO container."""
    directory_size = 6 + 16 * len(frames)
    offset = directory_size
    entries: list[bytes] = []
    payloads: list[bytes] = []

    for size, data in frames:
        dimension = 0 if size == 256 else size
        entries.append(pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(data), offset))
        payloads.append(data)
        offset += len(data)

    return pack("<HHH", 0, 1, len(frames)) + b"".join(entries + payloads)


def main() -> None:
    """Regenerate the Tauri Windows icon using the approved DPI target sizes."""
    with Image.open(MASTER_ICON_PATH) as image:
        master = image.convert("RGBA")
    frames = [(size, png_frame(master, size)) for size in WINDOWS_ICON_SIZES]
    OUTPUT_PATH.write_bytes(build_ico(frames))
    print(f"Wrote {OUTPUT_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
