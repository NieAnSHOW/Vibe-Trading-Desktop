"""自选股 HTTP 路由骨架。

由 api_server.py 通过 register_watchlist_routes(app, ...) 挂载。
SQLite CRUD 逻辑由后续任务 1.2/1.3 实现；此文件仅定义模型和路由占位符。

路由（鉴权由任务 1.3 注入）：
- GET  /watchlist/stocks        — 返回自选股列表（占位符返回空列表）
- POST /watchlist/stocks        — 添加自选股（占位符返回 added=false）
- DELETE /watchlist/stocks/{code} — 删除自选股（占位符返回 deleted=false）
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Pydantic 模型
# ---------------------------------------------------------------------------


class StockItem(BaseModel):
    """DB 中存储的股票条目。"""

    code: str
    name: str = ""
    market: str = "a_stock"
    added_at: str


class AddStockRequest(BaseModel):
    """POST /watchlist/stocks 请求体。"""

    code: str
    market: str = "a_stock"


class StockListResponse(BaseModel):
    """GET /watchlist/stocks 响应体。"""

    stocks: list[StockItem]


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/watchlist", tags=["watchlist"])


@router.get("/stocks", response_model=StockListResponse)
async def list_stocks() -> StockListResponse:
    # ponytail: 占位符，任务 1.2 替换为真实 SQLite 查询
    return StockListResponse(stocks=[])


@router.post("/stocks")
async def add_stock(req: AddStockRequest) -> dict:
    # ponytail: 占位符，任务 1.3 替换为真实插入逻辑
    return {"added": False}


@router.delete("/stocks/{code}")
async def delete_stock(code: str) -> dict:
    # ponytail: 占位符，任务 1.3 替换为真实删除逻辑
    return {"deleted": False}
