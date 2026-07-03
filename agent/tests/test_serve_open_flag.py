"""serve --open —— 解析标志 + 健康后开浏览器的决策(tasks §7.1)。"""
from api_server import _should_open_browser, _build_serve_parser


def test_serve_parser_accepts_open_flag():
    args = _build_serve_parser().parse_args(["--port", "8899", "--open"])
    assert args.open is True


def test_serve_parser_open_defaults_false():
    args = _build_serve_parser().parse_args(["--port", "8899"])
    assert args.open is False


def test_should_open_browser_only_when_flag_set():
    assert _should_open_browser(open_flag=True) is True
    assert _should_open_browser(open_flag=False) is False
