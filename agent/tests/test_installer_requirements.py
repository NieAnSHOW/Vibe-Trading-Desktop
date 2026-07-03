"""pip install -r 参数构造 —— venv bootstrap 的安装原语(复用 installer 流式)。"""
from src.optional_deps.installer import build_requirements_args


def test_requirements_args_include_index_url_and_reqfile():
    args = build_requirements_args(
        python="/venv/bin/python",
        requirements="/repo/agent/requirements.txt",
        index_url="https://pypi.tuna.tsinghua.edu.cn/simple",
        trusted_host="",
    )
    assert args[:4] == ["/venv/bin/python", "-m", "pip", "install"]
    assert "-r" in args and "/repo/agent/requirements.txt" in args
    assert "--index-url" in args
    i = args.index("--index-url")
    assert args[i + 1] == "https://pypi.tuna.tsinghua.edu.cn/simple"


def test_requirements_args_omit_index_url_when_empty():
    args = build_requirements_args(
        python="/venv/bin/python", requirements="/r.txt", index_url="", trusted_host="",
    )
    assert "--index-url" not in args


def test_requirements_args_add_trusted_host_for_http_mirror():
    args = build_requirements_args(
        python="/venv/bin/python", requirements="/r.txt",
        index_url="http://mirror.local/simple", trusted_host="mirror.local",
    )
    assert "--trusted-host" in args and "mirror.local" in args
