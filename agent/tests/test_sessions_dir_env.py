"""VIBE_SESSIONS_DIR 解析回归 —— 锁定本地/Docker 行为不变(设计 D4)。"""
from pathlib import Path
from src.config.sessions_dir import resolve_sessions_dir


def test_unset_falls_back_to_code_relative_default(monkeypatch):
    monkeypatch.delenv("VIBE_SESSIONS_DIR", raising=False)
    code_default = Path("/repo/agent/sessions")
    assert resolve_sessions_dir(code_default) == code_default


def test_env_set_overrides_to_home(monkeypatch, tmp_path):
    target = tmp_path / "home-sessions"
    monkeypatch.setenv("VIBE_SESSIONS_DIR", str(target))
    code_default = Path("/repo/agent/sessions")
    assert resolve_sessions_dir(code_default) == target


def test_env_empty_string_is_treated_as_unset(monkeypatch):
    monkeypatch.setenv("VIBE_SESSIONS_DIR", "")
    code_default = Path("/repo/agent/sessions")
    assert resolve_sessions_dir(code_default) == code_default
