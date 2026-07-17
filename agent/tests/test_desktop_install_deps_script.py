"""Regression coverage for the desktop Tier 0 dependency installer."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
INSTALL_DEPS = ROOT / "scripts" / "desktop" / "install-deps.sh"
SMOKE_TIER0 = ROOT / "scripts" / "desktop" / "smoke_tier0.py"
EMBEDDED_PYTHON = ROOT / ".desktop-build" / "python-runtime" / "bin" / "python3"


def test_install_deps_uses_repo_paths_when_called_outside_repo(tmp_path: Path) -> None:
    """The smoke import must receive the repository agent path, not the caller CWD."""
    runtime_bin = tmp_path / "runtime" / "bin"
    runtime_bin.mkdir(parents=True)
    python = runtime_bin / "python3"
    python.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "if [[ $1 == -m ]]; then exit 0; fi\n"
        '[[ "$PYTHONPATH" == "$EXPECTED_PYTHONPATH" ]]\n'
        '[[ "$1" == "$EXPECTED_SMOKE" ]]\n'
    )
    python.chmod(0o755)

    tool_bin = tmp_path / "bin"
    tool_bin.mkdir()
    uv = tool_bin / "uv"
    uv.write_text("#!/usr/bin/env bash\nexit 0\n")
    uv.chmod(0o755)

    caller_dir = tmp_path / "outside-repository"
    caller_dir.mkdir()
    env = os.environ | {
        "PATH": f"{tool_bin}{os.pathsep}{os.environ['PATH']}",
        "EXPECTED_PYTHONPATH": str(ROOT / "agent"),
        "EXPECTED_SMOKE": str(SMOKE_TIER0),
    }

    result = subprocess.run(
        ["bash", str(INSTALL_DEPS), str(runtime_bin.parent)],
        cwd=caller_dir,
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


def test_install_deps_uses_repo_default_runtime_when_called_outside_repo(tmp_path: Path) -> None:
    """Omitting the runtime argument must still resolve from the script's repository."""
    repo = tmp_path / "repository"
    desktop_dir = repo / "scripts" / "desktop"
    desktop_dir.mkdir(parents=True)
    shutil.copy2(INSTALL_DEPS, desktop_dir / "install-deps.sh")
    shutil.copy2(SMOKE_TIER0, desktop_dir / "smoke_tier0.py")
    (repo / "agent").mkdir()

    runtime_bin = repo / ".desktop-build" / "python-runtime" / "bin"
    runtime_bin.mkdir(parents=True)
    python = runtime_bin / "python3"
    python.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "if [[ $1 == -m ]]; then exit 0; fi\n"
        '[[ "$PYTHONPATH" == "$EXPECTED_PYTHONPATH" ]]\n'
        '[[ "$1" == "$EXPECTED_SMOKE" ]]\n'
    )
    python.chmod(0o755)

    tool_bin = tmp_path / "bin"
    tool_bin.mkdir()
    uv = tool_bin / "uv"
    uv.write_text("#!/usr/bin/env bash\nexit 0\n")
    uv.chmod(0o755)

    caller_dir = tmp_path / "outside-repository"
    caller_dir.mkdir()
    result = subprocess.run(
        ["bash", str(desktop_dir / "install-deps.sh")],
        cwd=caller_dir,
        env=os.environ | {
            "PATH": f"{tool_bin}{os.pathsep}{os.environ['PATH']}",
            "EXPECTED_PYTHONPATH": str(repo / "agent"),
            "EXPECTED_SMOKE": str(desktop_dir / "smoke_tier0.py"),
        },
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


def test_dashboard_route_module_does_not_require_pandas_to_import() -> None:
    """Tier 0 can construct the API before bootstrap installs market-data dependencies."""
    code = """
import builtins

original_import = builtins.__import__

def block_pandas(name, *args, **kwargs):
    if name == 'pandas' or name.startswith('pandas.'):
        raise ModuleNotFoundError("No module named 'pandas'")
    return original_import(name, *args, **kwargs)

builtins.__import__ = block_pandas
import src.api.dashboard_routes
"""
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env=os.environ | {"PYTHONPATH": str(ROOT / "agent")},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(not EMBEDDED_PYTHON.exists(), reason="embedded Tier 0 runtime is not assembled")
def test_embedded_tier0_runtime_imports_full_api_server() -> None:
    """The actual bundled runtime must construct the API without heavy packages."""
    result = subprocess.run(
        [str(EMBEDDED_PYTHON), "-c", "import api_server"],
        cwd=ROOT,
        env=os.environ | {"PYTHONPATH": str(ROOT / "agent")},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
