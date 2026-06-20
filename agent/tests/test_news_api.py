"""Tests for the AKShare-backed finance news API."""

from __future__ import annotations

from types import SimpleNamespace

import pandas as pd
from fastapi.testclient import TestClient

import api_server


def test_list_finance_news_normalizes_stock_news_main_cx_rows(monkeypatch) -> None:
    fake_akshare = SimpleNamespace(
        stock_news_main_cx=lambda: pd.DataFrame(
            [
                {
                    "tag": "公司",
                    "summary": "半导体板块午后走强",
                    "url": "https://example.test/a",
                },
                {
                    "tag": "市场",
                    "summary": "北向资金活跃",
                    "url": "https://example.test/b",
                },
            ]
        )
    )
    monkeypatch.setattr(api_server, "_import_akshare", lambda: fake_akshare)

    response = TestClient(api_server.app).get("/news/finance")

    assert response.status_code == 200
    assert response.json() == {
        "items": [
            {
                "tag": "公司",
                "summary": "半导体板块午后走强",
                "url": "https://example.test/a",
            },
            {
                "tag": "市场",
                "summary": "北向资金活跃",
                "url": "https://example.test/b",
            },
        ]
    }


def test_list_finance_news_filters_blank_rows(monkeypatch) -> None:
    fake_akshare = SimpleNamespace(
        stock_news_main_cx=lambda: pd.DataFrame(
            [
                {"tag": "市场", "summary": "", "url": "https://example.test/blank"},
                {"tag": "宏观", "summary": "央行公开市场操作更新", "url": ""},
                {"tag": "宏观", "summary": "央行公开市场操作更新", "url": "https://example.test/c"},
            ]
        )
    )
    monkeypatch.setattr(api_server, "_import_akshare", lambda: fake_akshare)

    response = TestClient(api_server.app).get("/news/finance")

    assert response.status_code == 200
    assert response.json()["items"] == [
        {
            "tag": "宏观",
            "summary": "央行公开市场操作更新",
            "url": "https://example.test/c",
        }
    ]


def test_list_finance_news_reports_akshare_import_error(monkeypatch) -> None:
    def raise_import_error():
        raise ImportError("No module named akshare")

    monkeypatch.setattr(api_server, "_import_akshare", raise_import_error)

    response = TestClient(api_server.app).get("/news/finance")

    assert response.status_code == 503
    assert "AKShare is not installed" in response.json()["detail"]
