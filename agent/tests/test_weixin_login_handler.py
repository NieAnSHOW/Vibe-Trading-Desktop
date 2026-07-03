"""微信扫码登录 REST handler 错误处理。

桌面端 sidecar 调用 ilinkai.weixin.qq.com 时,外部 HTTP 可能因 SSL/网络失败
(嵌入式 runtime + bootstrap venv 的证书/网络环境与开发机不同)。handler 必须把
这类外部失败转成有意义的 502 + detail,而不是裸 500 —— 否则前端只看到
"Internal Server Error",sidecar 日志也缺少可读 detail,无法定位底层原因。

与同文件 /correlation handler 的 try/except 模式对齐。
"""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient
from types import SimpleNamespace

import api_server

_AUTH = {"Authorization": "Bearer testkey"}


class _RaisingAdapter:
    """Adapter whose begin/poll raise a caller-supplied exception."""

    def __init__(self, exc):
        self._exc = exc
        self.config = SimpleNamespace(base_url="https://ilinkai.weixin.qq.com")

    async def begin_qr_login(self):
        raise self._exc

    async def poll_qr_login(self, login_id):
        raise self._exc


@pytest.fixture()
def _client_with_adapter(monkeypatch):
    """Install a fake _channel_runtime whose weixin adapter is the caller's."""
    monkeypatch.setenv("API_AUTH_KEY", "testkey")

    def install(adapter):
        class _M:
            def get_channel(self, name):
                return adapter if name == "weixin" else None

        class _R:
            manager = _M()

        async def _noop_probe(base_url):
            return {"base_url": base_url}

        monkeypatch.setattr(api_server, "_channel_runtime", _R())
        monkeypatch.setattr(api_server, "_weixin_connectivity_probe", _noop_probe)
        return TestClient(api_server.app)

    return install


class TestWeixinLoginHandlerErrors:
    def test_start_returns_502_on_httpx_network_error(self, _client_with_adapter):
        client = _client_with_adapter(_RaisingAdapter(httpx.ConnectError("conn reset")))
        r = client.post("/channels/weixin/login/start", headers=_AUTH)
        assert r.status_code == 502
        assert r.json()["detail"]

    def test_start_returns_502_on_runtime_error(self, _client_with_adapter):
        client = _client_with_adapter(_RaisingAdapter(RuntimeError("no qrcode in response")))
        r = client.post("/channels/weixin/login/start", headers=_AUTH)
        assert r.status_code == 502

    def test_status_returns_502_on_httpx_error(self, _client_with_adapter):
        client = _client_with_adapter(_RaisingAdapter(httpx.ConnectError("conn reset")))
        r = client.get("/channels/weixin/login/status?login_id=q1", headers=_AUTH)
        assert r.status_code == 502
