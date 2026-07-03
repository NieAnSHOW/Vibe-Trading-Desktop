# scripts/desktop/smoke_imports.py
# 在迁移后的内嵌运行时中运行; import 关键原生包并做最小调用,
# 任意 ImportError / OSError(BLAS / rpath 链接错误)即非零退出。
import sys
from types import SimpleNamespace

# 单一真源: src.desktop_bootstrap.smoke.SMOKE_MODULES, 避免两处清单漂移
from src.desktop_bootstrap.smoke import SMOKE_MODULES as MODULES


def _smoke_a_stock_data() -> None:
    """Offline smoke for the bundled a-stock-data adapter.

    This catches the desktop-specific failure mode where the agent code is
    copied into the Tauri bundle but the embedded Python runtime is missing a
    new dependency or the loader/tool auto-registration path breaks.
    """
    import pandas as pd

    from backtest.loaders.a_stock_data import AStockDataClient, DataLoader
    from backtest.loaders.registry import FALLBACK_CHAINS, LOADER_REGISTRY, _ensure_registered
    from src.tools.a_stock_data_tool import AStockDataTool

    _ensure_registered()
    if "a_stock_data" not in LOADER_REGISTRY:
        raise AssertionError("a_stock_data loader not registered")
    if "a_stock_data" not in FALLBACK_CHAINS.get("a_share", []):
        raise AssertionError("a_stock_data missing from A-share fallback chain")

    def fake_kline(symbol, start_date, end_date):
        if (symbol, start_date, end_date) != ("600519", "2026-06-01", "2026-06-02"):
            raise AssertionError("unexpected a_stock_data smoke kline args")
        return pd.DataFrame(
            {
                "open": [10.0],
                "high": [12.0],
                "low": [9.0],
                "close": [11.0],
                "volume": [12345.0],
            },
            index=pd.to_datetime(["2026-06-01"]),
        )

    bars = DataLoader(kline_fetcher=fake_kline).fetch(
        ["600519.SH"],
        "2026-06-01",
        "2026-06-02",
    )
    if bars["600519.SH"].iloc[0]["close"] != 11.0:
        raise AssertionError("a_stock_data OHLCV smoke returned wrong close")

    def fake_quote(codes):
        return {"600519": {"name": "贵州茅台", "price": 1500.0}}

    def fake_em_get(*_args, **_kwargs):
        return SimpleNamespace(json=lambda: {"data": {"f57": "600519", "f58": "贵州茅台"}})

    basic = AStockDataClient(em_get=fake_em_get, quote_fetcher=fake_quote).basic_data("600519.SH")
    if basic["name"] != "贵州茅台":
        raise AssertionError("a_stock_data basic-data smoke returned wrong name")

    if AStockDataTool.name != "get_a_stock_data":
        raise AssertionError("a_stock_data tool name changed unexpectedly")

def main() -> int:
    failed = []
    for name in MODULES:
        try:
            mod = __import__(name)
            print(f"OK   import {name} ({getattr(mod, '__version__', 'n/a')})")
        except Exception as exc:
            failed.append((name, repr(exc)))
            print(f"FAIL import {name}: {exc!r}")
    # 最小原生调用, 触发 BLAS / native 路径
    try:
        import numpy as np
        import scipy.linalg as la
        la.inv(np.eye(3))
        print("OK   numpy/scipy native call (scipy.linalg.inv)")
    except Exception as exc:
        failed.append(("scipy.linalg.inv", repr(exc)))
        print(f"FAIL native call: {exc!r}")
    try:
        _smoke_a_stock_data()
        print("OK   a_stock_data loader/tool smoke")
    except Exception as exc:
        failed.append(("a_stock_data", repr(exc)))
        print(f"FAIL a_stock_data smoke: {exc!r}")
    if failed:
        print(f"\nSMOKE FAILED: {len(failed)} issue(s)")
        return 1
    print("\nSMOKE PASSED")
    return 0

if __name__ == "__main__":
    sys.exit(main())
