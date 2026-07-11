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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

try:
    from src.api.security import require_local_or_auth
except ImportError:
    require_local_or_auth = None  # 测试环境无需鉴权

try:
    from backtest.loaders.a_stock_data import tencent_quote
except ImportError:
    tencent_quote = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# QuoteProvider Protocol + TencentQuoteProvider
# ---------------------------------------------------------------------------

from typing import Protocol


class QuoteProvider(Protocol):
    """行情数据提供者协议。"""

    market: str

    def fetch(self, codes: list[str]) -> dict[str, dict]:
        """批量查询行情，返回 {code: quote_dict}；失败的 code 以 error 字段标注。"""
        ...


class TencentQuoteProvider:
    """A 股实时行情，复用 tencent_quote()，统一返回结构。"""

    market: str = "a_stock"

    def fetch(self, codes: list[str]) -> dict[str, dict]:
        """返回 {code: {name, price, change_pct, change_amt, high, low, volume}}。"""
        raw = tencent_quote(codes)  # type: ignore[misc]
        result: dict[str, dict] = {}
        for code in codes:
            if code in raw:
                r = raw[code]
                result[code] = {
                    "code": code,
                    "name": r.get("name"),
                    "price": r.get("price"),
                    "change_pct": r.get("change_pct"),
                    "change_amt": r.get("change_amt"),
                    "high": r.get("high"),
                    "low": r.get("low"),
                    "volume": r.get("amount_wan"),
                }
            else:
                result[code] = {"code": code, "error": "数据不可用"}
        return result


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


def _build_auth_dep():
    if require_local_or_auth is not None:
        return [Depends(require_local_or_auth)]
    return []


@router.get("/stocks", response_model=StockListResponse)
async def list_stocks() -> StockListResponse:
    """返回自选股列表，按 added_at 倒序。"""
    def _query():
        with _get_connection() as conn:
            rows = conn.execute(
                "SELECT code, name, market, added_at FROM watchlist ORDER BY added_at DESC"
            ).fetchall()
            return [
                StockItem(code=r["code"], name=r["name"], market=r["market"], added_at=r["added_at"])
                for r in rows
            ]

    loop = asyncio.get_event_loop()
    stocks = await loop.run_in_executor(None, _query)
    return StockListResponse(stocks=stocks)


@router.post("/stocks")
async def add_stock(req: AddStockRequest) -> dict:
    """添加自选股；重复时返回 exists=true。"""
    if not req.code or not req.code.strip():
        raise HTTPException(status_code=400, detail="股票代码不能为空")

    def _insert():
        try:
            with _get_connection() as conn:
                conn.execute(
                    "INSERT INTO watchlist(code, name, market) VALUES (?, '', ?)",
                    (req.code, req.market),
                )
                conn.commit()
            return {"added": True, "exists": False}
        except sqlite3.IntegrityError:
            return {"added": False, "exists": True}

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _insert)


@router.delete("/stocks/{code}")
async def delete_stock(code: str, market: str = "a_stock") -> dict:
    """删除自选股；不存在时返回 404。"""
    def _delete():
        with _get_connection() as conn:
            cursor = conn.execute(
                "DELETE FROM watchlist WHERE code=? AND market=?", (code, market)
            )
            conn.commit()
            return cursor.rowcount

    loop = asyncio.get_event_loop()
    rowcount = await loop.run_in_executor(None, _delete)
    if rowcount == 0:
        raise HTTPException(status_code=404, detail=f"股票 {code} 不在自选股中")
    return {"deleted": True}


_SUPPORTED_MARKETS = {"a_stock"}
_DEFAULT_PROVIDER = TencentQuoteProvider()


@router.get("/quotes")
async def get_quotes(codes: str = "", market: str = "a_stock") -> dict:
    """批量查询行情。

    Query params:
    - codes: 逗号分隔的股票代码，必填非空
    - market: 市场类型，当前仅支持 a_stock
    """
    if not codes or not codes.strip():
        raise HTTPException(status_code=400, detail="codes 参数不能为空")
    if market not in _SUPPORTED_MARKETS:
        raise HTTPException(status_code=400, detail=f"不支持的市场: {market}，当前支持: {list(_SUPPORTED_MARKETS)}")

    code_list = [c.strip() for c in codes.split(",") if c.strip()]
    if not code_list:
        raise HTTPException(status_code=400, detail="codes 参数不能为空")

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _DEFAULT_PROVIDER.fetch, code_list)
    return result


def register_watchlist_routes(app, require_local_or_auth_dep=None) -> None:
    """挂载 watchlist 路由到 FastAPI app。"""
    app.include_router(router)
