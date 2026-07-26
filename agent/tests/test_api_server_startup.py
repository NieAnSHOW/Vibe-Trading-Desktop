"""Regression tests for API server startup compatibility."""

from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace

import api_server


def test_has_root_route_ignores_route_entries_without_path() -> None:
    routes = [object(), SimpleNamespace(path="/health"), SimpleNamespace(path="/")]

    assert api_server._has_root_route(routes) is True


def test_has_root_route_returns_false_without_root_path() -> None:
    routes = [object(), SimpleNamespace(path="/health")]

    assert api_server._has_root_route(routes) is False


def test_startup_activates_injected_vip_runtime_before_preflight_and_removes_legacy_secrets(
    tmp_path, monkeypatch, caplog
) -> None:
    """VIP sidecar credentials must win over legacy dotenv values at startup."""
    env_path = tmp_path / ".env"
    env_path.write_text(
        "DESKTOP_LLM_MODE=vip\n"
        "LANGCHAIN_PROVIDER=legacy_provider\n"
        "LANGCHAIN_MODEL_NAME=legacy-model\n"
        "VIP_API_KEY=legacy-dotenv-key\n"
        "VIP_BASE_URL=https://legacy.example/v1\n"
        "OPENAI_API_KEY=custom-provider-key\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(api_server, "_resolve_settings_env_path", lambda: env_path)
    monkeypatch.setenv("VIBE_DESKTOP_VIP_PROVISIONED", "1")
    monkeypatch.setenv("VIBE_DESKTOP_VIP_API_KEY", "injected-vip-key")
    monkeypatch.setenv("VIBE_DESKTOP_VIP_BASE_URL", "https://vip.example")
    monkeypatch.setenv("VIBE_DESKTOP_VIP_MODELS_JSON", '["member-model"]')
    monkeypatch.delenv("LANGCHAIN_PROVIDER", raising=False)
    monkeypatch.delenv("LANGCHAIN_MODEL_NAME", raising=False)
    monkeypatch.delenv("VIP_API_KEY", raising=False)
    monkeypatch.delenv("VIP_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_API_BASE", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)

    observed = {}

    def capture_preflight(_console) -> None:
        observed.update(
            provider=os.environ.get("LANGCHAIN_PROVIDER"),
            model=os.environ.get("LANGCHAIN_MODEL_NAME"),
            api_key=os.environ.get("VIP_API_KEY"),
            base_url=os.environ.get("VIP_BASE_URL"),
        )

    async def noop_watchlist_init() -> None:
        return None

    import src.preflight as preflight

    monkeypatch.setattr(preflight, "run_preflight", capture_preflight)
    monkeypatch.setattr(api_server, "_start_scheduled_research_executor", lambda: None)
    monkeypatch.setattr(api_server, "_watchlist_init_db", noop_watchlist_init)

    with caplog.at_level("INFO"):
        asyncio.run(api_server._run_startup_preflight())

    assert observed == {
        "provider": "vip_server",
        "model": "member-model",
        "api_key": "injected-vip-key",
        "base_url": "https://vip.example/v1",
    }
    persisted = env_path.read_text(encoding="utf-8")
    assert "VIP_API_KEY" not in persisted
    assert "VIP_BASE_URL" not in persisted
    assert "OPENAI_API_KEY=custom-provider-key" in persisted
    assert "injected-vip-key" not in caplog.text
    assert "https://vip.example" not in caplog.text


def test_startup_keeps_custom_dotenv_untouched_without_injected_vip_runtime(
    tmp_path, monkeypatch
) -> None:
    """Custom and unauthenticated starts keep their existing dotenv behavior."""
    env_path = tmp_path / ".env"
    original = (
        "DESKTOP_LLM_MODE=custom\n"
        "LANGCHAIN_PROVIDER=openai\n"
        "LANGCHAIN_MODEL_NAME=gpt-4.1-mini\n"
        "VIP_API_KEY=legacy-value-kept-outside-vip-mode\n"
        "VIP_BASE_URL=https://legacy.example/v1\n"
    )
    env_path.write_text(original, encoding="utf-8")
    monkeypatch.setattr(api_server, "_resolve_settings_env_path", lambda: env_path)
    monkeypatch.delenv("VIBE_DESKTOP_VIP_PROVISIONED", raising=False)
    monkeypatch.delenv("VIBE_DESKTOP_VIP_API_KEY", raising=False)
    monkeypatch.delenv("VIBE_DESKTOP_VIP_BASE_URL", raising=False)

    from src.api.settings_routes import activate_desktop_vip_runtime_at_startup

    assert activate_desktop_vip_runtime_at_startup() is False
    assert env_path.read_text(encoding="utf-8") == original
