"""bootstrap 编排 —— 决策流可测:建 venv → 装 → 冒烟 → 就绪 / 失败 / 跳过。"""
from pathlib import Path
from src.desktop_bootstrap.smoke import SmokeResult


def _drain(events):
    return [(e.stage, e.ok) for e in events]


def test_happy_path_installs_then_ready(tmp_path):
    from src.desktop_bootstrap.bootstrap import run_bootstrap
    home = tmp_path / ".vibe-trading"
    req = tmp_path / "requirements.txt"; req.write_text("numpy\n", encoding="utf-8")
    events = list(run_bootstrap(
        home_vibe=home, requirements=req,
        ensure_venv=lambda h: (h / "venv" / "bin" / "python"),
        pip_stream=lambda **kw: iter(["Collecting numpy", "Successfully installed numpy"]),
        smoke=lambda py: SmokeResult(ok=True),
    ))
    stages = _drain(events)
    assert ("installing", True) in stages
    assert stages[-1] == ("done", True)


def test_smoke_failure_marks_not_ready(tmp_path):
    from src.desktop_bootstrap.bootstrap import run_bootstrap
    home = tmp_path / ".vibe-trading"
    req = tmp_path / "requirements.txt"; req.write_text("numpy\n", encoding="utf-8")
    events = list(run_bootstrap(
        home_vibe=home, requirements=req,
        ensure_venv=lambda h: (h / "venv" / "bin" / "python"),
        pip_stream=lambda **kw: iter(["Successfully installed numpy"]),
        smoke=lambda py: SmokeResult(ok=False, failures=["scipy: no wheel"]),
    ))
    stages = _drain(events)
    assert stages[-1] == ("failed", False)


def test_pip_failure_yields_failed_with_reason(tmp_path):
    import subprocess
    from src.desktop_bootstrap.bootstrap import run_bootstrap
    home = tmp_path / ".vibe-trading"
    req = tmp_path / "requirements.txt"; req.write_text("numpy\n", encoding="utf-8")
    def boom(**kw):
        yield "Collecting numpy"
        raise subprocess.CalledProcessError(1, ["pip"])
    events = list(run_bootstrap(
        home_vibe=home, requirements=req,
        ensure_venv=lambda h: (h / "venv" / "bin" / "python"),
        pip_stream=boom,
        smoke=lambda py: SmokeResult(ok=True),
    ))
    stages = _drain(events)
    assert stages[-1][0] == "failed"


def test_already_ready_skips_install(tmp_path):
    from src.desktop_bootstrap.requirements_hash import compute_hash, write_marker
    from src.desktop_bootstrap.bootstrap import hash_marker_path, run_bootstrap
    home = tmp_path / ".vibe-trading"
    req = tmp_path / "requirements.txt"; req.write_text("numpy\n", encoding="utf-8")
    (home / "venv" / "bin").mkdir(parents=True)
    (home / "venv" / "bin" / "python").write_text("#!/bin/sh\n")
    write_marker(hash_marker_path(home), compute_hash(req))
    calls = {"pip": 0}
    def counting_pip(**kw):
        calls["pip"] += 1
        return iter([])
    events = list(run_bootstrap(
        home_vibe=home, requirements=req,
        ensure_venv=lambda h: (h / "venv" / "bin" / "python"),
        pip_stream=counting_pip,
        smoke=lambda py: SmokeResult(ok=True),
    ))
    assert calls["pip"] == 0
    assert _drain(events)[-1] == ("done", True)


def test_cli_sse_flag_emits_frames(tmp_path, monkeypatch, capsys):
    import src.desktop_bootstrap.cli as cli_mod
    from src.desktop_bootstrap.bootstrap import BootstrapEvent
    monkeypatch.setattr(cli_mod, "run_bootstrap",
                        lambda **kw: iter([BootstrapEvent("installing", "x"),
                                           BootstrapEvent("done", "ready")]))
    monkeypatch.setattr("src.config.paths.get_runtime_root", lambda: tmp_path)
    rc = cli_mod.run_bootstrap_cli(["--sse"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "installing" in out.lower() or "done" in out.lower()
