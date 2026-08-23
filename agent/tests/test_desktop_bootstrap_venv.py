"""venv 环境解析 —— 路径按平台正确,创建走 stdlib venv(设计 D2)。"""
import subprocess
import sys
from pathlib import Path

import pytest

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


def _interpreter_runs(py: Path) -> bool:
    """解释器能否真正完成初始化(`-V` 在初始化前返回,不能作判据)。

    损坏的 exe 在 Windows 上无法 spawn(OSError),同样视为不可用。
    """
    try:
        return subprocess.run(
            [str(py), "-c", "pass"], capture_output=True, timeout=60
        ).returncode == 0
    except OSError:
        return False


def test_ensure_venv_reuses_healthy_venv_without_rebuilding(tmp_path):
    base = tmp_path / ".vibe-trading"
    ensure_venv(base)
    sentinel = base / "venv" / ".keep"
    sentinel.write_text("sentinel")
    py = ensure_venv(base)
    assert py.exists()
    assert sentinel.exists(), "健康的 venv 不应被删除重建"


def test_ensure_venv_rebuilds_when_interpreter_unusable(tmp_path):
    base = tmp_path / ".vibe-trading"
    py = ensure_venv(base)
    assert _interpreter_runs(py)
    with open(py, "wb") as f:
        f.write(b"not an interpreter")
    assert not _interpreter_runs(py)
    py2 = ensure_venv(base)
    assert py2 == py
    assert _interpreter_runs(py2)


def test_ensure_venv_rebuilds_when_base_runtime_gone(tmp_path):
    """回归(Windows 实测):旧安装的 python-runtime 丢失标准库后,
    venv 解释器启动即 fatal(No module named 'encodings'),pip 永久失败。
    ensure_venv 须探测失效 venv 并从当前运行时重建。

    Linux venv 默认符号链接到基础解释器,home 失效不影响启动,故仅 Windows 覆盖。
    """
    if not sys.platform.startswith("win"):
        pytest.skip("windows venv 复制解释器,才依赖 pyvenv.cfg home")
    base = tmp_path / ".vibe-trading"
    py = ensure_venv(base)
    assert _interpreter_runs(py)

    gone = tmp_path / "gone-runtime"
    gone.mkdir()
    cfg = base / "venv" / "pyvenv.cfg"
    lines = [
        line if not line.startswith("home =") else f"home = {gone}"
        for line in cfg.read_text().splitlines()
    ]
    cfg.write_text("\n".join(lines) + "\n")
    assert not _interpreter_runs(py), "前置:home 指向无标准库目录时解释器应无法启动"

    py2 = ensure_venv(base)
    assert _interpreter_runs(py2)
