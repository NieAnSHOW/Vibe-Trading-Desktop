"""Tests for the AKShare-backed stock hotness API."""

from __future__ import annotations

import time
from types import SimpleNamespace

import pandas as pd
from fastapi.testclient import TestClient

import api_server


EXPECTED_STOCK_HOT_FUNCTIONS = [
    "stock_hot_search_baidu",
    "stock_hot_keyword_em",
    "stock_hot_deal_xq",
    "stock_hot_follow_xq",
    "stock_hot_tweet_xq",
    "stock_inner_trade_xq",
]


def test_get_stock_hot_groups_all_available_sections(monkeypatch) -> None:
    calls: list[tuple[str, dict]] = []

    def make_table(name: str):
        def table(**kwargs):
            calls.append((name, kwargs))
            return pd.DataFrame(
                [
                    {"代码": "SZ000001", "名称": f"{name}-平安银行", "热度": 1200},
                    {"代码": "SH600519", "名称": f"{name}-贵州茅台", "热度": 1100},
                ]
            )

        return table

    fake_akshare = SimpleNamespace(
        **{source.function_name: make_table(source.function_name) for source in api_server.STOCK_HOT_SOURCES}
    )
    monkeypatch.setattr(api_server, "_import_akshare", lambda: fake_akshare)

    response = TestClient(api_server.app).get("/stock/hot")

    assert response.status_code == 200
    payload = response.json()
    assert [section["function"] for section in payload["sections"]] == EXPECTED_STOCK_HOT_FUNCTIONS
    assert payload["sections"][0] == {
        "id": "baidu-search",
        "title": "热搜股票",
        "source": "百度股市通",
        "category": "热搜股票",
        "function": "stock_hot_search_baidu",
        "columns": ["代码", "名称", "热度"],
        "rows": [
            {"代码": "SZ000001", "名称": "stock_hot_search_baidu-平安银行", "热度": 1200},
            {"代码": "SH600519", "名称": "stock_hot_search_baidu-贵州茅台", "热度": 1100},
        ],
        "error": None,
    }
    assert ("stock_hot_follow_xq", {"symbol": "最热门"}) in calls
    assert any(section["function"] == "stock_hot_search_baidu" for section in payload["sections"])
    assert all(section["function"] != "stock_sns_sseinfo" for section in payload["sections"])


def test_get_stock_hot_limits_rows_and_cleans_values(monkeypatch) -> None:
    def hot_rank(**kwargs):
        return pd.DataFrame(
            [{"代码": f"SZ{i:06d}", "名称": None, "热度": float("nan")} for i in range(35)]
        )

    fake_akshare = SimpleNamespace(
        **{
            source.function_name: (hot_rank if source.function_name == "stock_hot_keyword_em" else lambda **_: pd.DataFrame())
            for source in api_server.STOCK_HOT_SOURCES
        }
    )
    monkeypatch.setattr(api_server, "_import_akshare", lambda: fake_akshare)

    response = TestClient(api_server.app).get("/stock/hot")

    assert response.status_code == 200
    section = next(item for item in response.json()["sections"] if item["function"] == "stock_hot_keyword_em")
    assert len(section["rows"]) == 20
    assert section["rows"][0] == {"代码": "SZ000000", "名称": None, "热度": None}


def test_get_stock_hot_keeps_other_sections_when_one_source_fails(monkeypatch) -> None:
    def broken_source(**kwargs):
        raise RuntimeError("upstream timeout")

    fake_akshare = SimpleNamespace(
        **{
            source.function_name: (
                broken_source
                if source.function_name == "stock_hot_tweet_xq"
                else lambda **_: pd.DataFrame([{"代码": "SZ000001"}])
            )
            for source in api_server.STOCK_HOT_SOURCES
        }
    )
    monkeypatch.setattr(api_server, "_import_akshare", lambda: fake_akshare)

    response = TestClient(api_server.app).get("/stock/hot")

    assert response.status_code == 200
    sections = response.json()["sections"]
    failed = next(section for section in sections if section["function"] == "stock_hot_tweet_xq")
    assert failed["rows"] == []
    assert failed["error"] == "upstream timeout"
    assert any(section["rows"] for section in sections if section["function"] != "stock_hot_tweet_xq")


def test_get_stock_hot_fetches_sources_concurrently(monkeypatch) -> None:
    def slow_table(**kwargs):
        time.sleep(0.08)
        return pd.DataFrame([{"代码": "SZ000001"}])

    fake_akshare = SimpleNamespace(
        **{source.function_name: slow_table for source in api_server.STOCK_HOT_SOURCES}
    )
    monkeypatch.setattr(api_server, "_import_akshare", lambda: fake_akshare)

    started_at = time.perf_counter()
    response = TestClient(api_server.app).get("/stock/hot")
    elapsed = time.perf_counter() - started_at

    assert response.status_code == 200
    assert len(response.json()["sections"]) == len(EXPECTED_STOCK_HOT_FUNCTIONS)
    assert elapsed < 0.35


def test_get_stock_hot_reports_akshare_import_error(monkeypatch) -> None:
    def raise_import_error():
        raise ImportError("No module named akshare")

    monkeypatch.setattr(api_server, "_import_akshare", raise_import_error)

    response = TestClient(api_server.app).get("/stock/hot")

    assert response.status_code == 503
    assert "AKShare is not installed" in response.json()["detail"]
