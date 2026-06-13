"""Load and validate the optional-deps registry.

The registry (``registry.yaml``) is the single source of truth for which
broker packages the install API will accept. The loader raises on
duplicates or malformed entries so a bad registry fails fast at startup.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import List

import yaml

# Default registry location: shipped alongside this module.
DEFAULT_REGISTRY_PATH = Path(__file__).resolve().parent / "registry.yaml"

_VALID_PLATFORMS = frozenset(
    {"macos_arm64", "macos_x86_64", "windows_amd64"}
)
_VALID_MIRRORS = frozenset({"tsinghua", "aliyun", "official", "custom", "off"})


@dataclass(frozen=True)
class RegistryEntry:
    """One broker/capability row in the registry."""

    id: str
    label: str
    package: str
    description: str
    platforms: List[str] = field(default_factory=list)
    recommended_mirror: str = "tsinghua"


def load_registry(path: Path = DEFAULT_REGISTRY_PATH) -> List[RegistryEntry]:
    """Load and validate the registry.

    Args:
        path: Path to ``registry.yaml``. Defaults to the bundled copy.

    Returns:
        List of validated :class:`RegistryEntry`.

    Raises:
        FileNotFoundError: When ``path`` does not exist.
        ValueError: On duplicate package names, unknown platforms/mirrors,
            or missing required fields.
    """
    if not path.exists():
        raise FileNotFoundError(f"registry not found: {path}")

    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    brokers = raw.get("brokers") or []

    entries: List[RegistryEntry] = []
    seen_packages: set[str] = set()
    for row in brokers:
        package = (row.get("package") or "").strip()
        entry_id = (row.get("id") or "").strip()
        if not package:
            raise ValueError(f"registry entry {entry_id!r} missing 'package'")
        if package in seen_packages:
            raise ValueError(f"duplicate package in registry: {package}")
        seen_packages.add(package)

        platforms = list(row.get("platforms") or [])
        bad_platforms = [p for p in platforms if p not in _VALID_PLATFORMS]
        if bad_platforms:
            raise ValueError(
                f"registry entry {entry_id!r} has unknown platforms: {bad_platforms}"
            )

        mirror = row.get("recommended_mirror") or "tsinghua"
        if mirror not in _VALID_MIRRORS:
            raise ValueError(
                f"registry entry {entry_id!r} has unknown mirror: {mirror}"
            )

        entries.append(
            RegistryEntry(
                id=entry_id,
                label=(row.get("label") or package),
                package=package,
                description=(row.get("description") or ""),
                platforms=platforms,
                recommended_mirror=mirror,
            )
        )
    return entries


def package_whitelist(entries: List[RegistryEntry]) -> set[str]:
    """Return the set of accepted package names."""
    return {e.package for e in entries}
