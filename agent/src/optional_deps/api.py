"""FastAPI router for on-demand optional dependency management.

Mounted by ``agent/api_server.py`` at ``/optional-deps``. All routes are
gated by the same loopback-or-auth dependency as the other settings
endpoints (the caller wires that in at mount time).

Routes:
    GET  /optional-deps/list              — registry + installed status
    POST /optional-deps/install           — whitelist + platform check, returns job id
    POST /optional-deps/uninstall
    GET  /optional-deps/status/{job_id}   — SSE stream of pip stdout
    GET  /optional-deps/mirror
    PUT  /optional-deps/mirror
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from src.optional_deps.installer import (
    InstalledPackage,
    default_python_executable,
    run_install,
    run_uninstall,
    scan_installed,
)
from src.optional_deps.mirror import (
    MirrorConfig,
    load_mirror_config,
    resolve_index_url,
    resolve_trusted_host,
    save_mirror_config,
)
from src.optional_deps.platform import is_supported_on_current_platform
from src.optional_deps.registry_loader import (
    DEFAULT_REGISTRY_PATH,
    RegistryEntry,
    load_registry,
)
from src.optional_deps.sse_lines import sse_event, stage_line

router = APIRouter(prefix="/optional-deps", tags=["optional-deps"])

# ---------------------------------------------------------------------------
# Path accessors — overridable in tests via monkeypatch.
# ---------------------------------------------------------------------------


def _libs_dir() -> Path:
    """Return the writable libs directory."""
    return Path.home() / ".vibe-trading" / "runtime" / "libs"


def _load_entries(path: Path = DEFAULT_REGISTRY_PATH) -> List[RegistryEntry]:
    """Load the registry entries (cached per-process)."""
    return load_registry(path)


def _registry_entries() -> List[RegistryEntry]:
    return _load_entries()


# ---------------------------------------------------------------------------
# In-memory job store for SSE status streams.
# ---------------------------------------------------------------------------


class _Job:
    """A pip install/uninstall job with a line buffer for SSE replay."""

    def __init__(self, package: str, kind: str) -> None:
        self.job_id = uuid.uuid4().hex
        self.package = package
        self.kind = kind  # "install" | "uninstall"
        self.lines: List[str] = []
        self.done = False
        self.failed = False
        self.error: str = ""
        self.queue: asyncio.Queue = asyncio.Queue()


_jobs: Dict[str, _Job] = {}

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class BrokerStatus(BaseModel):
    id: str
    label: str
    package: str
    description: str
    platforms: List[str]
    recommended_mirror: str
    installed: bool
    installed_version: str = ""


class ListResponse(BaseModel):
    brokers: List[BrokerStatus]


class InstallRequest(BaseModel):
    package: str = Field(..., min_length=1, max_length=128)


class InstallResponse(BaseModel):
    job_id: str
    status: str


class UninstallResponse(BaseModel):
    status: str


class MirrorResponse(BaseModel):
    name: str
    custom_index_url: str
    available: Dict[str, str] = Field(
        default_factory=lambda: {
            "tsinghua": "https://pypi.tuna.tsinghua.edu.cn/simple",
            "aliyun": "https://mirrors.aliyun.com/pypi/simple",
            "official": "https://pypi.org/simple",
        }
    )


class UpdateMirrorRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=32)
    custom_index_url: str = Field("", max_length=512)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _entry_by_package(package: str) -> Optional[RegistryEntry]:
    for entry in _registry_entries():
        if entry.package == package:
            return entry
    return None


def _installed_map(libs: Path) -> Dict[str, InstalledPackage]:
    return {pkg.name.lower(): pkg for pkg in scan_installed(libs)}


def _normalize_name(name: str) -> str:
    """PyPI normalizes ``-``/``_``/``.`` to the same token."""
    return name.lower().replace("-", "_").replace(".", "_")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/list", response_model=ListResponse)
async def list_optional_deps() -> ListResponse:
    """Return registry entries annotated with installed status."""
    libs = _libs_dir()
    installed = _installed_map(libs)
    rows: List[BrokerStatus] = []
    for entry in _registry_entries():
        key = _normalize_name(entry.package)
        pkg = installed.get(key)
        rows.append(
            BrokerStatus(
                id=entry.id,
                label=entry.label,
                package=entry.package,
                description=entry.description,
                platforms=list(entry.platforms),
                recommended_mirror=entry.recommended_mirror,
                installed=bool(pkg),
                installed_version=pkg.version if pkg else "",
            )
        )
    return ListResponse(brokers=rows)


@router.post("/install", response_model=InstallResponse)
async def install_optional_dep(req: InstallRequest) -> InstallResponse:
    """Start a background pip install for a whitelisted package.

    Returns a ``job_id`` immediately; poll/subscribe via ``/status/{job_id}``.
    """
    entry = _entry_by_package(req.package)
    if entry is None:
        raise HTTPException(
            status_code=400,
            detail=f"package '{req.package}' is not in registry whitelist",
        )
    if not is_supported_on_current_platform(entry.platforms):
        raise HTTPException(
            status_code=400,
            detail=(
                f"package '{req.package}' has no prebuilt wheel for the "
                f"current platform; supported: {entry.platforms}"
            ),
        )

    job = _Job(package=req.package, kind="install")
    _jobs[job.job_id] = job
    asyncio.create_task(_run_install_job(job))
    return InstallResponse(job_id=job.job_id, status="started")


@router.post("/uninstall", response_model=UninstallResponse)
async def uninstall_optional_dep(req: InstallRequest) -> UninstallResponse:
    """Uninstall a whitelisted package from the libs dir."""
    entry = _entry_by_package(req.package)
    if entry is None:
        raise HTTPException(
            status_code=400,
            detail=f"package '{req.package}' is not in registry whitelist",
        )
    job = _Job(package=req.package, kind="uninstall")
    _jobs[job.job_id] = job
    asyncio.create_task(_run_uninstall_job(job))
    return UninstallResponse(status="started")


@router.get("/status/{job_id}")
async def install_status(job_id: str):
    """SSE stream of pip progress for a job."""
    from fastapi.responses import StreamingResponse

    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job_id: {job_id}")

    async def event_stream():
        # Replay buffered lines first (covers late subscribers).
        for line in job.lines:
            yield stage_line("downloading", line)
        # Then stream live until done/failed.
        while not job.done:
            try:
                line = await asyncio.wait_for(job.queue.get(), timeout=1.0)
                job.lines.append(line)
                yield stage_line("downloading", line)
            except asyncio.TimeoutError:
                if job.done:
                    break
                continue
        if job.failed:
            yield sse_event(
                "failed",
                {"package": job.package, "error": job.error},
            )
        else:
            yield sse_event("done", {"package": job.package})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/mirror", response_model=MirrorResponse)
async def get_mirror() -> MirrorResponse:
    cfg = load_mirror_config()
    return MirrorResponse(name=cfg.name, custom_index_url=cfg.custom_index_url)


@router.put("/mirror", response_model=MirrorResponse)
async def put_mirror(req: UpdateMirrorRequest) -> MirrorResponse:
    cfg = MirrorConfig(name=req.name, custom_index_url=req.custom_index_url)
    if cfg.name == "custom" and not cfg.custom_index_url.strip():
        raise HTTPException(
            status_code=400,
            detail="custom_index_url is required when name=custom",
        )
    save_mirror_config(cfg)
    return MirrorResponse(name=cfg.name, custom_index_url=cfg.custom_index_url)


# ---------------------------------------------------------------------------
# Background workers
# ---------------------------------------------------------------------------


async def _run_install_job(job: _Job) -> None:
    """Run pip in a thread, forwarding lines to the job's asyncio queue."""
    cfg = load_mirror_config()
    index_url = resolve_index_url(cfg)
    trusted_host = resolve_trusted_host(cfg)
    python = default_python_executable()
    libs = str(_libs_dir())

    loop = asyncio.get_event_loop()

    def _blocking() -> None:
        import subprocess  # local to keep module import side-effect free

        try:
            for line in run_install(
                python=python,
                libs_dir=libs,
                package=job.package,
                index_url=index_url,
                trusted_host=trusted_host,
            ):
                asyncio.run_coroutine_threadsafe(job.queue.put(line), loop)
        except subprocess.CalledProcessError as exc:
            job.failed = True
            job.error = f"pip exited with code {exc.returncode}"
        except Exception as exc:  # noqa: BLE001
            job.failed = True
            job.error = str(exc)

    await loop.run_in_executor(None, _blocking)
    job.done = True


async def _run_uninstall_job(job: _Job) -> None:
    loop = asyncio.get_event_loop()
    python = default_python_executable()
    libs = str(_libs_dir())

    def _blocking() -> None:
        import subprocess

        try:
            for line in run_uninstall(
                python=python,
                libs_dir=libs,
                package=job.package,
            ):
                asyncio.run_coroutine_threadsafe(job.queue.put(line), loop)
        except subprocess.CalledProcessError as exc:
            job.failed = True
            job.error = f"pip exited with code {exc.returncode}"
        except Exception as exc:  # noqa: BLE001
            job.failed = True
            job.error = str(exc)

    await loop.run_in_executor(None, _blocking)
    job.done = True
