"""pip-based installer for optional deps into the writable libs dir.

The installer runs the embedded runtime's own pip as a subprocess:

    python3 -m pip install --target <libs_dir> [--index-url ...] <package>

``--target`` writes into ``~/.vibe-trading/runtime/libs/`` without touching
the read-only bundle site-packages. stdout is streamed line-by-line for
SSE progress. No ``--require-hashes`` (YAGNI; the registry whitelist +
HTTPS mirror are the safety boundary).
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, List


@dataclass(frozen=True)
class InstalledPackage:
    """One package detected under the libs dir via its ``.dist-info``."""

    name: str
    version: str


def scan_installed(libs_dir: Path) -> List[InstalledPackage]:
    """Scan ``libs_dir`` for ``*.dist-info`` and return installed packages.

    Returns an empty list when the directory does not exist yet.
    """
    if not libs_dir.exists():
        return []
    results: List[InstalledPackage] = []
    for entry in sorted(libs_dir.iterdir()):
        if not entry.is_dir() or not entry.name.endswith(".dist-info"):
            continue
        name = entry.name[: -len(".dist-info")]
        # dist-info dirs are ``<name>-<version>``; split off the version.
        version = ""
        if "-" in name:
            name, version = name.rsplit("-", 1)
        results.append(InstalledPackage(name=name, version=version))
    return results


def build_pip_args(
    python: str,
    libs_dir: str,
    package: str,
    index_url: str,
    trusted_host: str,
) -> List[str]:
    """Build the argv for ``python -m pip install --target``.

    Args:
        python: Path to the embedded interpreter executable.
        libs_dir: Writable target directory.
        package: PyPI package name (already whitelist-validated).
        index_url: ``--index-url`` value, or ``""`` to omit (official PyPI).
        trusted_host: ``--trusted-host`` value, or ``""`` to omit.

    Returns:
        Argv list suitable for :func:`subprocess.Popen`.
    """
    args = [
        python,
        "-m",
        "pip",
        "install",
        "--target",
        str(libs_dir),
        "--no-input",
        "--disable-pip-version-check",
    ]
    if index_url:
        args += ["--index-url", index_url]
    if trusted_host:
        args += ["--trusted-host", trusted_host]
    args.append(package)
    return args


def run_install(
    python: str,
    libs_dir: str,
    package: str,
    index_url: str,
    trusted_host: str,
) -> Iterator[str]:
    """Run pip and yield each stdout/stderr line for SSE streaming.

    Yields lines (stripped of trailing newline) as they arrive. Raises
    :class:`subprocess.CalledProcessError` on non-zero exit, after
    flushing all remaining output.
    """
    args = build_pip_args(
        python=python,
        libs_dir=libs_dir,
        package=package,
        index_url=index_url,
        trusted_host=trusted_host,
    )
    proc = subprocess.Popen(  # noqa: S603 — argv is built internally, not from user shell input
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            yield line.rstrip("\n")
    finally:
        proc.stdout.close()
        rc = proc.wait()
        if rc != 0:
            raise subprocess.CalledProcessError(rc, args)


def build_uninstall_args(
    python: str,
    libs_dir: str,
    package: str,
) -> List[str]:
    """Build argv for ``pip uninstall`` scoped to the target dir.

    pip's uninstall targets the ``--target`` dir's records, removing only
    the files it installed there (not bundle site-packages).
    """
    return [
        python,
        "-m",
        "pip",
        "uninstall",
        "-y",
        "--target",
        str(libs_dir),
        package,
    ]


def run_uninstall(
    python: str,
    libs_dir: str,
    package: str,
) -> Iterator[str]:
    """Run pip uninstall and yield stdout lines."""
    args = build_uninstall_args(python, libs_dir, package)
    proc = subprocess.Popen(  # noqa: S603
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            yield line.rstrip("\n")
    finally:
        proc.stdout.close()
        rc = proc.wait()
        if rc != 0:
            raise subprocess.CalledProcessError(rc, args)


def default_python_executable() -> str:
    """Return the interpreter to use for pip. Defaults to ``sys.executable``."""
    return sys.executable


def build_requirements_args(
    python: str,
    requirements: str,
    index_url: str,
    trusted_host: str,
) -> list:
    """Build argv for ``python -m pip install -r <requirements>`` into the venv.

    Unlike ``build_pip_args``, this installs into the interpreter's own
    site-packages (no ``--target``) — ``python`` is the venv interpreter, so
    packages land in the venv. Mirror/trusted-host reuse the same resolution.
    """
    args = [
        python, "-m", "pip", "install", "-r", str(requirements),
        "--no-input", "--disable-pip-version-check",
    ]
    if index_url:
        args += ["--index-url", index_url]
    if trusted_host:
        args += ["--trusted-host", trusted_host]
    return args


def run_requirements_install(
    python: str,
    requirements: str,
    index_url: str,
    trusted_host: str,
):
    """Run ``pip install -r`` and yield stdout lines (mirrors run_install).

    Re-invoking after a failure resumes: pip skips already-satisfied
    requirements and reuses its download cache.
    Raises CalledProcessError on non-zero exit.
    """
    import subprocess
    args = build_requirements_args(python, requirements, index_url, trusted_host)
    proc = subprocess.Popen(  # noqa: S603
        args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            yield line.rstrip("\n")
    finally:
        proc.stdout.close()
        rc = proc.wait()
        if rc != 0:
            raise subprocess.CalledProcessError(rc, args)
