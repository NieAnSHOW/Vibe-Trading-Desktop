"""TDD RED 阶段：验证 watchlist_routes.py 骨架结构。"""
from __future__ import annotations

import pytest
from fastapi.routing import APIRouter


def test_router_prefix_and_type():
    """router 是 APIRouter 且 prefix 为 /watchlist。"""
    from agent.src.api.watchlist_routes import router

    assert isinstance(router, APIRouter)
    assert router.prefix == "/watchlist"


def test_all_three_routes_registered():
    """三个骨架路由端点均已注册。"""
    from agent.src.api.watchlist_routes import router

    paths = {r.path for r in router.routes}
    assert "/watchlist/stocks" in paths, f"缺少 GET /watchlist/stocks，已有: {paths}"
    assert "/watchlist/stocks/{code}" in paths, f"缺少 DELETE /watchlist/stocks/{{code}}，已有: {paths}"


def test_pydantic_models_importable():
    """Pydantic 模型可正常导入和实例化。"""
    from agent.src.api.watchlist_routes import AddStockRequest, StockItem, StockListResponse

    item = StockItem(code="000001", added_at="2026-07-11T00:00:00")
    assert item.market == "a_stock"

    req = AddStockRequest(code="600519")
    assert req.market == "a_stock"

    resp = StockListResponse(stocks=[])
    assert resp.stocks == []
