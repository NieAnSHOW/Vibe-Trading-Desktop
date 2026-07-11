"""自选股 HTTP 路由。

由 api_server.py 通过 register_watchlist_routes(app, ...) 挂载。
SQLite CRUD 逻辑由后续任务 1.3 实现；此文件定义模型、DB 初始化和路由占位符。

路由（鉴权由任务 1.3 注入）：
- GET  /watchlist/stocks        — 返回自选股列表（占位符返回空列表）
- POST /watchlist/stocks        — 添加自选股（占位符返回 added=false）
- DELETE /watchlist/stocks/{code} — 删除自选股（占位符返回 deleted=false）
"""

from __future__ import annotations

import asyncio
import sqlite3
import threading
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# DB 路径与连接管理
# ---------------------------------------------------------------------------


def _default_db_path() -> Path:
    return Path.home() / ".vibe-trading" / "watchlist.db"


DB_PATH: Path = _default_db_path()
_db_lock = threading.Lock()


def _get_connection() -> sqlite3.Connection:
    """返回已配置的 SQLite 连接（同步，供 run_in_executor 调用）。"""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _init_db() -> None:
    """幂等建表（同步）。在 startup 中通过 executor 调用。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _get_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS watchlist (
                code        TEXT NOT NULL,
                name        TEXT NOT NULL DEFAULT '',
                market      TEXT NOT NULL DEFAULT 'a_stock',
                added_at    TEXT NOT NULL DEFAULT (datetime('now')),
                sort_order  INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (code, market)
            )
        """)
        conn.commit()


async def init_db() -> None:
    """供 api_server.py 在 startup 调用的异步入口。"""
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _init_db)

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
