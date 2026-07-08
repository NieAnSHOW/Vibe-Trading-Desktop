"""Regression tests for the macOS-system-proxy bypass on Chinese data hosts.

Root cause (issue "akshare 代理问题"): the agent process inherits the macOS
system proxy (e.g. 127.0.0.1:7897 from Clash/Surge) via requests' trust_env.
akshare and the direct requests-based Chinese loaders then route East Money /
Tencent / Sina / cninfo traffic through it and East Money rejects the proxy hop
with a hard ProxyError, breaking every akshare fetch.

The fix exempts Chinese financial-data hosts from the inherited proxy by
appending them to NO_PROXY at loader registration (the shared chokepoint).
Foreign hosts (OKX/yfinance/Yahoo/Stooq) stay on the proxy.
"""

from __future__ import annotations

import os

from backtest.loaders.registry import (
    _CHINA_DIRECT_NO_PROXY,
    _apply_china_direct_no_proxy,
)


def test_china_hosts_exempted_from_proxy(monkeypatch) -> None:
    """After the bootstrap, Chinese data hosts must bypass the OS proxy."""
    from requests.utils import should_bypass_proxies

    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7897")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)

    _apply_china_direct_no_proxy()

    assert should_bypass_proxies("https://push2his.eastmoney.com/x", None)
    assert should_bypass_proxies("https://82.push2.eastmoney.com/x", None)
    assert should_bypass_proxies("https://web.ifzq.gtimg.cn/x", None)
    assert should_bypass_proxies("https://qt.gtimg.cn/x", None)
    assert should_bypass_proxies("https://stock.finance.sina.com.cn/x", None)
    assert should_bypass_proxies("https://hq.sinajs.cn/x", None)
    assert should_bypass_proxies("https://www.cninfo.com.cn/x", None)


def test_foreign_hosts_still_use_proxy(monkeypatch) -> None:
    """Foreign sources must keep using the proxy — they need it to egress."""
    from requests.utils import should_bypass_proxies

    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7897")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)

    _apply_china_direct_no_proxy()

    assert not should_bypass_proxies("https://api.okx.com/x", None)
    assert not should_bypass_proxies("https://query1.finance.yahoo.com/x", None)
    assert not should_bypass_proxies("https://stooq.com/x", None)


def test_no_proxy_is_idempotent(monkeypatch) -> None:
    """Re-running the bootstrap must not duplicate entries."""
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)

    _apply_china_direct_no_proxy()
    first = os.environ["NO_PROXY"]
    _apply_china_direct_no_proxy()
    second = os.environ["NO_PROXY"]

    assert first == second
    # every host appears exactly once
    parts = [p for p in first.split(",") if p]
    assert len(parts) == len(set(parts))


def test_preserves_existing_no_proxy(monkeypatch) -> None:
    """User-defined NO_PROXY entries are kept, not overwritten."""
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
    monkeypatch.delenv("no_proxy", raising=False)

    _apply_china_direct_no_proxy()

    assert "localhost" in os.environ["NO_PROXY"]
    assert "127.0.0.1" in os.environ["NO_PROXY"]
    for host in _CHINA_DIRECT_NO_PROXY.split(","):
        if host:
            assert host in os.environ["NO_PROXY"]


def test_bootstrap_runs_on_registration(monkeypatch) -> None:
    """Importing the registry applies the NO_PROXY bootstrap once."""
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7897")

    import importlib

    import backtest.loaders.registry as reg

    importlib.reload(reg)
    reg._ensure_registered()

    assert "eastmoney.com" in os.environ["NO_PROXY"]
