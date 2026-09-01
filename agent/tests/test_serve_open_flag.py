"""serve --open —— serve 子命令解析器接受 --open 标志（默认关闭）。"""

from cli._legacy import _build_parser


def test_serve_parser_accepts_open_flag():
    args = _build_parser().parse_args(["serve", "--port", "8899", "--open"])
    assert args.open is True


def test_serve_parser_open_defaults_false():
    args = _build_parser().parse_args(["serve", "--port", "8899"])
    assert args.open is False
