"""Tests for optional_deps.registry_loader."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.optional_deps.registry_loader import (
    RegistryEntry,
    load_registry,
)


def _write_registry(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "registry.yaml"
    p.write_text(body, encoding="utf-8")
    return p


def test_load_registry_returns_entries(tmp_path):
    reg = _write_registry(
        tmp_path,
        """
version: 1
brokers:
  - id: futu
    label: "富途 Futu"
    package: futu-api
    description: "Futu OpenAPI SDK"
    platforms: [macos_arm64, macos_x86_64, windows_amd64]
    recommended_mirror: tsinghua
""",
    )
    entries = load_registry(reg)
    assert len(entries) == 1
    e = entries[0]
    assert isinstance(e, RegistryEntry)
    assert e.id == "futu"
    assert e.package == "futu-api"
    assert e.platforms == ["macos_arm64", "macos_x86_64", "windows_amd64"]


def test_load_registry_white_lists_package_names(tmp_path):
    reg = _write_registry(
        tmp_path,
        """
version: 1
brokers:
  - id: a
    label: A
    package: pkg-a
    platforms: [macos_arm64]
  - id: b
    label: B
    package: pkg-b
    platforms: [windows_amd64]
""",
    )
    entries = load_registry(reg)
    names = {e.package for e in entries}
    assert names == {"pkg-a", "pkg-b"}


def test_load_registry_rejects_duplicate_packages(tmp_path):
    reg = _write_registry(
        tmp_path,
        """
version: 1
brokers:
  - id: a
    label: A
    package: dup-pkg
    platforms: [macos_arm64]
  - id: b
    label: B
    package: dup-pkg
    platforms: [windows_amd64]
""",
    )
    with pytest.raises(ValueError, match="duplicate package"):
        load_registry(reg)


def test_load_registry_rejects_missing_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_registry(tmp_path / "nope.yaml")
