"""venv 环境解析 —— 路径按平台正确,创建走 stdlib venv(设计 D2)。"""
import sys
from pathlib import Path
from src.desktop_bootstrap.venv_env import venv_dir, venv_python, ensure_venv

def test_venv_dir_is_home_vibe_trading_venv():
    assert venv_dir(Path("/home/u/.vibe-trading")) == Path("/home/u/.vibe-trading/venv")

def test_venv_python_path_is_platform_correct():
    base = Path("/home/u/.vibe-trading")
    p = venv_python(base)
    if sys.platform.startswith("win"):
        assert p == base / "venv" / "Scripts" / "python.exe"
    else:
        assert p == base / "venv" / "bin" / "python"

def test_ensure_venv_creates_real_venv(tmp_path):
    base = tmp_path / ".vibe-trading"
    py = ensure_venv(base)
    assert py.exists()
    import subprocess
    out = subprocess.run([str(py), "-c", "import sys; print(sys.prefix)"],
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0
    assert str(base / "venv") in out.stdout

def test_ensure_venv_is_idempotent(tmp_path):
    base = tmp_path / ".vibe-trading"
    p1 = ensure_venv(base)
    p2 = ensure_venv(base)
    assert p1 == p2 and p2.exists()
