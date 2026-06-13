"""Tests for optional_deps.platform pre-check."""

from __future__ import annotations

from src.optional_deps.platform import current_platform_tag, is_supported_on_current_platform


def test_current_platform_tag_returns_known_value():
    tag = current_platform_tag()
    assert tag in {"macos_arm64", "macos_x86_64", "windows_amd64"}


def test_supported_when_tag_in_list(monkeypatch):
    monkeypatch.setattr(
        "src.optional_deps.platform.current_platform_tag",
        lambda: "macos_arm64",
    )
    assert is_supported_on_current_platform(["macos_arm64", "windows_amd64"]) is True


def test_unsupported_when_tag_absent(monkeypatch):
    """vnpy_ctp on macOS arm64 must be rejected."""
    monkeypatch.setattr(
        "src.optional_deps.platform.current_platform_tag",
        lambda: "macos_arm64",
    )
    assert is_supported_on_current_platform(["windows_amd64"]) is False


def test_supported_when_no_platform_listed(monkeypatch):
    """An empty platform list is treated as 'available everywhere' (lenient)."""
    monkeypatch.setattr(
        "src.optional_deps.platform.current_platform_tag",
        lambda: "macos_arm64",
    )
    assert is_supported_on_current_platform([]) is True
