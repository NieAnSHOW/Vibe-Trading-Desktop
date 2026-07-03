"""`vibe-trading bootstrap` 渲染:默认人类可读,--sse 输出 SSE 帧给 Rust 控制台。"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from src.desktop_bootstrap.bootstrap import run_bootstrap


def run_bootstrap_cli(argv: Optional[list[str]] = None) -> int:
    """Entry for the ``bootstrap`` subcommand. Returns process exit code."""
    import argparse
    from src.config.paths import get_runtime_root
    from src.optional_deps.mirror import (
        MirrorConfig, load_mirror_config, resolve_index_url, resolve_trusted_host,
    )
    from src.optional_deps.sse_lines import sse_event, stage_line

    parser = argparse.ArgumentParser(prog="vibe-trading bootstrap")
    parser.add_argument("--sse", action="store_true", help="Emit SSE frames (desktop console)")
    parser.add_argument("--mirror", default=None, help="tsinghua|aliyun|official|custom|off")
    parser.add_argument("--index-url", default=None, help="Custom index url (with --mirror custom)")
    args = parser.parse_args(argv)

    home = get_runtime_root()
    requirements = Path(__file__).resolve().parents[2] / "requirements.txt"
    # Mirror: CLI arg > persisted config > default tsinghua
    cfg = load_mirror_config()
    if args.mirror:
        cfg = MirrorConfig(name=args.mirror, custom_index_url=args.index_url or "")
    index_url = resolve_index_url(cfg)
    trusted = resolve_trusted_host(cfg)
    log_path = home / "logs" / "bootstrap.log"

    exit_code = 0
    for ev in run_bootstrap(
        home_vibe=home, requirements=requirements,
        index_url=index_url, trusted_host=trusted, log_path=log_path,
    ):
        if args.sse:
            if ev.stage in ("done", "failed"):
                print(sse_event(ev.stage, {"ok": ev.ok, "message": ev.message}), end="", flush=True)
            else:
                print(stage_line(ev.stage, ev.message), end="", flush=True)
        else:
            print(f"[{ev.stage}] {ev.message}", flush=True)
        if ev.stage == "failed":
            exit_code = 1
    return exit_code
