"""重型包冒烟 —— bootstrap 完成后判定"就绪"的依据(desktop-runtime-bootstrap)。

单一真源:scripts/desktop/smoke_imports.py 委托到这里,避免两处清单漂移。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

# desktop-runtime-bootstrap delta 要求至少覆盖 numpy/scipy/scikit-learn/pandas/duckdb。
SMOKE_MODULES = ["numpy", "scipy", "sklearn", "duckdb", "pandas", "PIL", "matplotlib", "stockstats"]


@dataclass
class SmokeResult:
    ok: bool
    failures: List[str] = field(default_factory=list)


def run_smoke(python: str) -> SmokeResult:
    """Run import + native smoke in the target interpreter; return pass/fail.

    Runs as a subprocess of ``python`` (the venv interpreter) so it exercises
    the freshly-installed packages, not the caller's environment.
    """
    import subprocess

    probe = (
        "import importlib,sys\n"
        f"mods={SMOKE_MODULES!r}\n"
        "bad=[]\n"
        "for m in mods:\n"
        "    try: importlib.import_module(m)\n"
        "    except Exception as e: bad.append(f'{m}: {e!r}')\n"
        "try:\n"
        "    import numpy as np, scipy.linalg as la; la.inv(np.eye(3))\n"
        "except Exception as e: bad.append(f'scipy.linalg.inv: {e!r}')\n"
        "print('\\n'.join(bad))\n"
        "sys.exit(1 if bad else 0)\n"
    )
    proc = subprocess.run([python, "-c", probe], capture_output=True, text=True, timeout=120)
    failures = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    return SmokeResult(ok=proc.returncode == 0, failures=failures)
