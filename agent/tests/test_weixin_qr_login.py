"""微信 QR 登录拆分 -- begin/poll 可被 REST 与终端共用(channel-management-ui 6.3)。"""
import asyncio
import pytest
from src.channels.bus.queue import MessageBus
from src.channels.weixin import WeixinChannel


def _make_adapter(monkeypatch, ch):
    async def fake_fetch():
        return ("qid-1", "data:image/png;base64,AAAA")

    monkeypatch.setattr(ch, "_fetch_qr_code", fake_fetch)
    return ch


def test_begin_qr_login_returns_login_id_and_image(monkeypatch):
    ch = WeixinChannel({"enabled": True}, MessageBus())
    ch = _make_adapter(monkeypatch, ch)
    out = asyncio.run(ch.begin_qr_login())
    assert out["login_id"] == "qid-1"
    assert out["qr_image"].startswith("data:image")


def test_poll_qr_login_reports_status(monkeypatch):
    ch = WeixinChannel({"enabled": True}, MessageBus())
    ch = _make_adapter(monkeypatch, ch)

    async def fake_poll(**kw):
        return {"status": "wait"}

    monkeypatch.setattr(ch, "_api_get_with_base", fake_poll)
    res = asyncio.run(ch.poll_qr_login("qid-1"))
    assert res["status"] in {"wait", "confirmed", "expired", "scaned_but_redirect"}


def test_poll_qr_login_confirmed_persists_token(monkeypatch, tmp_path):
    ch = WeixinChannel({"enabled": True, "state_dir": str(tmp_path)}, MessageBus())
    ch = _make_adapter(monkeypatch, ch)

    async def fake_poll(**kw):
        return {
            "status": "confirmed",
            "bot_token": "tok-abc",
            "ilink_bot_id": "bot-1",
            "ilink_user_id": "user-1",
            "baseurl": "https://wx.example.com",
        }

    monkeypatch.setattr(ch, "_api_get_with_base", fake_poll)
    res = asyncio.run(ch.poll_qr_login("qid-1"))
    assert res["status"] == "confirmed"
    assert res.get("token") == "tok-abc"
    assert ch._token == "tok-abc"
    assert ch.config.base_url == "https://wx.example.com"


def test_poll_qr_login_scaned_but_redirect_updates_base(monkeypatch):
    ch = WeixinChannel({"enabled": True}, MessageBus())
    ch = _make_adapter(monkeypatch, ch)
    ch._active_qr_base = "https://default.example.com"

    call_count = 0

    async def fake_poll(**kw):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return {"status": "scaned_but_redirect", "redirect_host": "redirect.example.com"}
        return {"status": "wait"}

    monkeypatch.setattr(ch, "_api_get_with_base", fake_poll)

    # First poll: redirect
    res1 = asyncio.run(ch.poll_qr_login("qid-1"))
    assert res1["status"] == "scaned_but_redirect"
    assert ch._active_qr_base == "https://redirect.example.com"

    # Second poll: uses updated base
    res2 = asyncio.run(ch.poll_qr_login("qid-1"))
    assert res2["status"] == "wait"
    assert call_count == 2


def test_weixin_client_ignores_system_proxy(monkeypatch):
    """桌面端 sidecar 继承代理软件的 HTTP(S)_PROXY 时,经代理访问腾讯 ilinkai 会
    ConnectError;weixin client 必须 trust_env=False 直连国内腾讯服务。"""
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9999")
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9999")
    ch = WeixinChannel({"enabled": True}, MessageBus())
    ch._ensure_client()
    assert ch._client is not None
    assert ch._client.trust_env is False


def test_weixin_config_falls_back_placeholder_base_url():
    """配置文件带占位 base_url(example.com / 空)时,fallback 到真实 ilinkai,
    避免 DNS 失败导致 QR login ConnectError。"""
    from src.channels.weixin import WeixinConfig

    assert WeixinConfig(base_url="https://custom.example.com").base_url == "https://ilinkai.weixin.qq.com"
    assert WeixinConfig(base_url="").base_url == "https://ilinkai.weixin.qq.com"
    assert WeixinConfig(base_url="https://example.org/x").base_url == "https://ilinkai.weixin.qq.com"
    # 合法自定义 base_url 保留(私有部署等)
    assert WeixinConfig(base_url="https://my.private-ilink.com").base_url == "https://my.private-ilink.com"
