"""bootstrap 编排:venv → pip install -r → smoke → 就绪(设计 D1/D5)。

pip 流与 smoke 通过参数注入(默认真实实现),使决策流可脱网单测。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional

from src.desktop_bootstrap.requirements_hash import compute_hash, needs_sync, write_marker
from src.desktop_bootstrap.smoke import SmokeResult, run_smoke as _real_smoke
from src.desktop_bootstrap.venv_env import ensure_venv as _real_ensure_venv


@dataclass
class BootstrapEvent:
    stage: str  # venv | installing | smoke | done | failed
    message: str = ""
    ok: bool = True


def hash_marker_path(home_vibe: Path) -> Path:
    """Marker recording the installed requirements hash (survives venv reuse)."""
    return home_vibe / "venv" / ".requirements_hash"


def run_bootstrap(
    home_vibe: Path,
    requirements: Path,
    *,
    index_url: str = "https://pypi.tuna.tsinghua.edu.cn/simple",
    trusted_host: str = "",
    log_path: Optional[Path] = None,
    ensure_venv: Callable[[Path], Path] = _real_ensure_venv,
    pip_stream: Optional[Callable[..., Iterator[str]]] = None,
    smoke: Callable[[str], SmokeResult] = _real_smoke,
) -> Iterator[BootstrapEvent]:
    """Run the full bootstrap, yielding progress events.

    Idempotent & resumable: when venv exists, hash matches and smoke passes,
    installation is skipped. Re-invoking after a pip failure resumes via pip's
    own skip-satisfied behaviour.
    """
    import subprocess
    from src.optional_deps.installer import run_requirements_install

    if pip_stream is None:
        pip_stream = run_requirements_install

    marker = hash_marker_path(home_vibe)
    log = _open_log(log_path)
    try:
        yield BootstrapEvent("venv", "preparing virtual environment")
        py = ensure_venv(home_vibe)

        if not needs_sync(requirements, marker):
            if smoke(str(py)).ok:
                yield BootstrapEvent("done", "already up to date")
                return

        yield BootstrapEvent("installing", "installing dependencies")
        try:
            for line in pip_stream(
                python=str(py), requirements=str(requirements),
                index_url=index_url, trusted_host=trusted_host,
            ):
                _tee(log, line)
                yield BootstrapEvent("installing", line)
        except subprocess.CalledProcessError as exc:
            msg = f"pip install failed (exit {exc.returncode}); retry will reuse completed packages"
            _tee(log, msg)
            yield BootstrapEvent("failed", msg, ok=False)
            return
        except Exception as exc:  # noqa: BLE001
            _tee(log, repr(exc))
            yield BootstrapEvent("failed", str(exc), ok=False)
            return

        yield BootstrapEvent("smoke", "verifying key packages")
        result = smoke(str(py))
        if not result.ok:
            detail = "; ".join(result.failures) or "smoke import failed"
            _tee(log, f"SMOKE FAILED: {detail}")
            yield BootstrapEvent("failed", f"deps incomplete: {detail}", ok=False)
            return

        write_marker(marker, compute_hash(requirements))
        yield BootstrapEvent("done", "environment ready")
    finally:
        if log is not None:
            log.close()


def _open_log(log_path: Optional[Path]):
    if log_path is None:
        return None
    log_path.parent.mkdir(parents=True, exist_ok=True)
    return log_path.open("a", encoding="utf-8")


def _tee(log, line: str) -> None:
    if log is not None:
        log.write(line + "\n")
        log.flush()
