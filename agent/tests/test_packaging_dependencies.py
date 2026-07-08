"""Packaging dependency regression tests."""

from __future__ import annotations

import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _normalized_requirement_name(requirement: str) -> str:
    name = requirement.split(";", 1)[0]
    for marker in ("[", "<", ">", "="):
        name = name.split(marker, 1)[0]
    return name.strip().lower()


# Packages intentionally kept out of the desktop-bundled requirements.txt.
# The desktop venv excludes weasyprint because its native cairo/pango deps do
# not bundle reliably across platforms (see agent/src/desktop_bootstrap/cli.py
# and scripts/desktop/install-deps.sh, which both strip it).
_REQUIREMENTS_TXT_EXEMPT = {"weasyprint"}


def _core_dependencies() -> set[str]:
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text())
    return {
        _normalized_requirement_name(requirement)
        for requirement in pyproject["project"]["dependencies"]
    }


def _requirements_txt_names() -> set[str]:
    return {
        _normalized_requirement_name(line)
        for line in (ROOT / "agent" / "requirements.txt").read_text().splitlines()
        if line and not line.startswith("#")
    }


def test_requirements_txt_covers_every_core_dependency() -> None:
    """Guard against pyproject.toml ↔ requirements.txt drift.

    The desktop bootstrap (`vibe-trading bootstrap`) installs from
    ``agent/requirements.txt``, not from ``pyproject.toml``. Any runtime
    dependency declared in ``pyproject.toml`` but missing from
    ``requirements.txt`` is absent from the desktop venv and surfaces as an
    ``ImportError`` only when the agent hits that code path at runtime
    (e.g. ``defusedxml`` in the RSSHub events loader). Keep the two in sync.
    """
    missing = _core_dependencies() - _requirements_txt_names() - _REQUIREMENTS_TXT_EXEMPT

    assert not missing, (
        "pyproject.toml declares runtime dependencies missing from "
        f"agent/requirements.txt: {sorted(missing)}. Add them to "
        "requirements.txt (the desktop bootstrap installs from it), or add "
        "them to _REQUIREMENTS_TXT_EXEMPT if intentionally bundle-excluded."
    )


def test_harmonic_backend_is_not_a_core_install_dependency() -> None:
    """Keep optional harmonic plotting deps from breaking baseline installs."""
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text())

    core_dependencies = {
        _normalized_requirement_name(requirement)
        for requirement in pyproject["project"]["dependencies"]
    }
    requirements_txt = {
        _normalized_requirement_name(line)
        for line in (ROOT / "agent" / "requirements.txt").read_text().splitlines()
        if line and not line.startswith("#")
    }

    assert "pyharmonics" not in core_dependencies
    assert "pyharmonics" not in requirements_txt


def test_harmonic_backend_is_available_as_an_optional_extra() -> None:
    """Users who need harmonic pattern detection can still opt in explicitly."""
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text())

    harmonic_extra = {
        _normalized_requirement_name(requirement)
        for requirement in pyproject["project"]["optional-dependencies"]["harmonic"]
    }

    assert "pyharmonics" in harmonic_extra


def test_channel_core_websocket_dependency_is_declared_for_baseline_installs() -> None:
    """The built-in WebSocket gateway imports websockets at module import time."""
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text())

    core_dependencies = {
        _normalized_requirement_name(requirement)
        for requirement in pyproject["project"]["dependencies"]
    }
    requirements_txt = {
        _normalized_requirement_name(line)
        for line in (ROOT / "agent" / "requirements.txt").read_text().splitlines()
        if line and not line.startswith("#")
    }

    assert "websockets" in core_dependencies
    assert "websockets" in requirements_txt


def test_channel_optional_extras_cover_all_sdk_backed_adapters() -> None:
    """Keep install hints and packaging extras in sync for IM adapters."""
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text())
    extras = pyproject["project"]["optional-dependencies"]

    expected_extras = {
        "channels",
        "dingtalk",
        "discord",
        "feishu",
        "matrix",
        "mochat",
        "msteams",
        "napcat",
        "qq",
        "slack",
        "telegram",
        "wecom",
        "weixin",
        "whatsapp",
    }
    assert expected_extras.issubset(set(extras))

    channel_extra = {
        _normalized_requirement_name(requirement)
        for requirement in extras["channels"]
    }
    expected_packages = {
        "aiohttp",
        "cryptography",
        "dingtalk-stream",
        "discord.py",
        "lark-oapi",
        "matrix-nio",
        "mistune",
        "msgpack",
        "neonize",
        "nh3",
        "pyjwt",
        "python-socketio",
        "python-telegram-bot",
        "qrcode",
        "qq-botpy",
        "slack-sdk",
        "slackify-markdown",
        "websockets",
        "wecom-aibot-sdk",
    }
    assert expected_packages.issubset(channel_extra)
