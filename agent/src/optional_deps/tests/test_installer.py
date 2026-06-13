"""Tests for optional_deps.installer (pure logic; no real pip run)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from src.optional_deps.installer import (
    InstalledPackage,
    build_pip_args,
    scan_installed,
)


def _make_dist_info(libs: Path, name: str) -> None:
    d = libs / f"{name}.dist-info"
    d.mkdir(parents=True)
    (d / "METADATA").write_text(f"Name: {name}\Version: 1.0\n", encoding="utf-8")


def test_scan_installed_returns_dist_info_names(tmp_path):
    libs = tmp_path / "libs"
    libs.mkdir()
    _make_dist_info(libs, "futu_api")
    _make_dist_info(libs, "ib_async")

    installed = scan_installed(libs)
    names = {p.name for p in installed}
    assert names == {"futu_api", "ib_async"}


def test_scan_installed_normalizes_dashes(tmp_path):
    """PyPI ``futu-api`` installs as ``futu_api`` (normalized import name)."""
    libs = tmp_path / "libs"
    libs.mkdir()
    _make_dist_info(libs, "futu_api")

    installed = scan_installed(libs)
    # registry package name is ``futu-api``; scan should report the dist-info name
    assert any(p.name == "futu_api" for p in installed)


def test_scan_installed_empty_when_dir_missing(tmp_path):
    installed = scan_installed(tmp_path / "nope")
    assert installed == []


def test_build_pip_args_uses_target_and_index(tmp_path):
    libs = tmp_path / "libs"
    args = build_pip_args(
        python=sys.executable,
        libs_dir=libs,
        package="futu-api",
        index_url="https://pypi.tuna.tsinghua.edu.cn/simple",
        trusted_host="",
    )
    joined = " ".join(args)
    assert "--target" in joined
    assert str(libs) in joined
    assert "futu-api" in joined
    assert "--index-url" in joined
    assert "pypi.tuna.tsinghua.edu.cn" in joined


def test_build_pip_args_omits_index_url_when_empty(tmp_path):
    libs = tmp_path / "libs"
    args = build_pip_args(
        python=sys.executable,
        libs_dir=libs,
        package="futu-api",
        index_url="",
        trusted_host="",
    )
    assert "--index-url" not in args
    assert "futu-api" in args


def test_build_pip_args_includes_trusted_host_when_set(tmp_path):
    libs = tmp_path / "libs"
    args = build_pip_args(
        python=sys.executable,
        libs_dir=libs,
        package="futu-api",
        index_url="http://insecure.mirror/simple",
        trusted_host="insecure.mirror",
    )
    assert "--trusted-host" in args
    assert "insecure.mirror" in args
