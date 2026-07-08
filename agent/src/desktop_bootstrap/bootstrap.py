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
from src.optional_deps.mirror import (
    FALLBACK_MIRRORS, DEFAULT_MIRROR, MIRROR_URLS,
    MirrorConfig, load_mirror_config, resolve_index_url, resolve_trusted_host,
    save_mirror_config,
)


@dataclass
class BootstrapEvent:
    stage: str  # venv | installing | smoke | done | failed
    message: str = ""
    ok: bool = True


def hash_marker_path(home_vibe: Path) -> Path:
    """Marker recording the installed requirements hash (survives venv reuse)."""
    return home_vibe / "venv" / ".requirements_hash"


def _mirror_sequence(cfg: MirrorConfig) -> list[str]:
    """Ordered index-urls to try: selected mirror first, then domestic fallback.

    CLI ``--mirror custom`` / ``off`` are honored verbatim with no fallback
    (the operator opted out of the default chain). Only the baked-in domestic
    mirrors get the auto-switch treatment.
    """
    chosen = cfg.name
    if chosen in ("custom", "off"):
        url = resolve_index_url(cfg)
        return [url] if url else [""]
    urls: list[str] = [resolve_index_url(cfg)]
    for name in FALLBACK_MIRRORS:
        u = MIRROR_URLS.get(name, "")
        if u and u not in urls:
            urls.append(u)
    return urls


def run_bootstrap(
    home_vibe: Path,
    requirements: Path,
    *,
    index_url: str = "",
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

    When the active PyPI mirror is unreachable (e.g. hijacked DNS), the
    install is retried against the next domestic mirror in the fallback chain
    (see ``_mirror_sequence``). The mirror that succeeds is persisted as the
    new default so subsequent runs don't re-hit the broken one.

    ``index_url`` is honored verbatim with no fallback (caller/test override).
    """
    import subprocess
    from src.optional_deps.installer import run_requirements_install

    if pip_stream is None:
        pip_stream = run_requirements_install

    mirror_names = {v: k for k, v in MIRROR_URLS.items()}
    # Explicit index_url overrides the persisted/CLI mirror + fallback chain.
    if index_url:
        chain = [index_url]
        cfg = load_mirror_config()  # still loaded so custom/off persist correctly
    else:
        cfg = load_mirror_config()
        chain = _mirror_sequence(cfg)

    marker = hash_marker_path(home_vibe)
    log = _open_log(log_path)
    try:
        yield BootstrapEvent("venv", "preparing virtual environment")
        py = ensure_venv(home_vibe)

        if not needs_sync(requirements, marker):
            if smoke(str(py)).ok:
                yield BootstrapEvent("done", "already up to date")
                return

        last_exc: Optional[Exception] = None
        success_url: Optional[str] = None
        for attempt, cur in enumerate(chain):
            cur_trusted = trusted_host
            if not cur_trusted and cur in MIRROR_URLS.values():
                cur_trusted = resolve_trusted_host(
                    MirrorConfig(name=mirror_names[cur]))
            elif not cur_trusted:
                cur_trusted = resolve_trusted_host(cfg)
            tag = mirror_names.get(cur, cur or "official")
            if len(chain) > 1:
                yield BootstrapEvent(
                    "installing",
                    f"installing dependencies via {tag} ({attempt + 1}/{len(chain)})",
                )
            else:
                yield BootstrapEvent("installing", "installing dependencies")
            try:
                for line in pip_stream(
                    python=str(py), requirements=str(requirements),
                    index_url=cur, trusted_host=cur_trusted,
                ):
                    _tee(log, line)
                    yield BootstrapEvent("installing", line)
                success_url = cur
                break
            except subprocess.CalledProcessError as exc:
                last_exc = exc
                msg = (f"install via {tag} failed (exit {exc.returncode}); "
                       f"switching to next mirror" if len(chain) > 1
                       else f"pip install failed (exit {exc.returncode}); "
                            f"retry will reuse completed packages")
                _tee(log, msg)
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                _tee(log, repr(exc))

        if success_url is None:
            detail = str(last_exc) if last_exc is not None else "all mirrors failed"
            yield BootstrapEvent("failed", f"deps install failed: {detail}", ok=False)
            return

        # Persist the working mirror so future runs skip the broken one.
        if success_url and mirror_names.get(success_url):
            save_mirror_config(MirrorConfig(name=mirror_names[success_url]))

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
