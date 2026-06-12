# scripts/desktop/smoke_imports.py
# 在迁移后的内嵌运行时中运行; import 关键原生包并做最小调用,
# 任意 ImportError / OSError(BLAS / rpath 链接错误)即非零退出。
import sys

MODULES = ["numpy", "scipy", "sklearn", "duckdb", "pandas", "PIL", "matplotlib"]

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
    if failed:
        print(f"\nSMOKE FAILED: {len(failed)} issue(s)")
        return 1
    print("\nSMOKE PASSED")
    return 0

if __name__ == "__main__":
    sys.exit(main())
