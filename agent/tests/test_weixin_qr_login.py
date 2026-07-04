"""微信 QR 登录拆分 -- begin/poll 可被 REST 与终端共用(channel-management-ui 6.3)。"""
import asyncio
import time
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


def test_poll_qr_login_confirmed_new_token_resets_loop_state(monkeypatch, tmp_path):
    """扫码换新 bot 后必须:同步 config.token(否则 restart 会用旧 token 重连)、
    清空 get_updates_buf 游标(旧 bot 游标对新身份无意义)、置 _pending_reconnect
    让协调层重启 poll 循环。这是"扫码成功但连接无效"故障的根因修复。"""
    ch = WeixinChannel({"enabled": True, "state_dir": str(tmp_path), "token": "old-tok"}, MessageBus())
    ch = _make_adapter(monkeypatch, ch)
    # 模拟通道已用旧 token 跑过、带着旧游标
    ch._token = "old-tok"
    ch._get_updates_buf = "old-cursor"

    async def fake_poll(**kw):
        return {
            "status": "confirmed",
            "bot_token": "new-tok",
            "ilink_bot_id": "bot-new",
            "ilink_user_id": "user-new",
        }

    monkeypatch.setattr(ch, "_api_get_with_base", fake_poll)
    res = asyncio.run(ch.poll_qr_login("qid-1"))

    assert res["status"] == "confirmed"
    assert res.get("token_changed") is True
    assert ch._token == "new-tok"
    assert ch.config.token == "new-tok"  # start() 首选 token 来源必须同步
    assert ch._get_updates_buf == ""  # 旧游标已清空
    assert ch._pending_reconnect is True  # 请求协调层重启


def test_poll_qr_login_confirmed_same_token_no_reconnect(monkeypatch, tmp_path):
    """幂等:前端每 2s 轮询会多次拿到 confirmed。token 未变时不得重复请求重连。"""
    ch = WeixinChannel({"enabled": True, "state_dir": str(tmp_path), "token": "tok-abc"}, MessageBus())
    ch = _make_adapter(monkeypatch, ch)
    ch._token = "tok-abc"
    ch._get_updates_buf = "live-cursor"

    async def fake_poll(**kw):
        return {"status": "confirmed", "bot_token": "tok-abc", "ilink_bot_id": "b", "ilink_user_id": "u"}

    monkeypatch.setattr(ch, "_api_get_with_base", fake_poll)
    res = asyncio.run(ch.poll_qr_login("qid-1"))

    assert res.get("token_changed") is False
    assert ch._pending_reconnect is False  # 未请求重连
    assert ch._get_updates_buf == "live-cursor"  # 活跃游标保留


def test_poll_qr_login_confirmed_clears_session_pause(monkeypatch, tmp_path):
    """扫码成功拿到新 token = 会话已恢复有效。必须立即清掉上一个失效 token
    留下的 1 小时 pause 窗口,否则:health_state 仍报 "expired"(Settings 一直
    标红"登录失效"),且 _poll_once 会继续 sleep(remaining) 不拉消息 —— 即
    "扫码成功、account.json 已更新、但仍收不到消息"的故障。"""
    ch = WeixinChannel({"enabled": True, "state_dir": str(tmp_path), "token": "old-tok"}, MessageBus())
    ch = _make_adapter(monkeypatch, ch)
    ch._token = "old-tok"
    # 模拟 errcode -14 触发的暂停窗口(还有 1 小时才自然超时)
    ch._session_pause_until = time.time() + 3600
    assert ch.health_state == "expired"  # 前置:确实处于失效态

    async def fake_poll(**kw):
        return {
            "status": "confirmed",
            "bot_token": "new-tok",
            "ilink_bot_id": "bot-new",
            "ilink_user_id": "user-new",
        }

    monkeypatch.setattr(ch, "_api_get_with_base", fake_poll)
    asyncio.run(ch.poll_qr_login("qid-1"))

    assert ch._session_pause_until == 0.0
    assert ch._session_pause_remaining_s() == 0
    assert ch.health_state == "ok"


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
