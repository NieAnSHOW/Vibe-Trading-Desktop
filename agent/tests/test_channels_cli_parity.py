"""渠道 CLI 与 WebUI 等价 —— 同一 runtime 单例, 状态两处可见 (channel-management-ui §6.4)."""
from __future__ import annotations


def test_cli_local_status_and_rest_status_both_expose_channels():
    """CLI _channels_local_status and REST runtime.status() both return a dict with 'channels'."""
    from cli._legacy import _channels_local_status

    local = _channels_local_status()
    assert isinstance(local, dict)
    assert "channels" in local
    assert isinstance(local["channels"], dict)


def test_rest_runtime_status_exposes_channels():
    """REST _get_channel_runtime().status() returns a dict with 'channels'."""
    from api_server import _get_channel_runtime

    runtime = _get_channel_runtime()
    rest = runtime.status()
    assert isinstance(rest, dict)
    assert "channels" in rest
    assert isinstance(rest["channels"], dict)


def test_both_status_shapes_are_compatible():
    """CLI local status and REST runtime status both produce mappings keyed by channel name."""
    from cli._legacy import _channels_local_status
    from api_server import _get_channel_runtime

    local = _channels_local_status()
    runtime = _get_channel_runtime()
    rest = runtime.status()

    # Both have "channels" dict keyed by channel name.
    local_channels = local["channels"]
    rest_channels = rest["channels"]
    assert isinstance(local_channels, dict)
    assert isinstance(rest_channels, dict)

    # Any channel present in both should have compatible shapes (enabled, loaded, running, etc.).
    common = set(local_channels) & set(rest_channels)
    for name in common:
        local_item = local_channels[name]
        rest_item = rest_channels[name]
        assert isinstance(local_item, dict)
        assert isinstance(rest_item, dict)
        # Both should expose at minimum: name, enabled, loaded, running.
        for key in ("enabled", "loaded", "running"):
            assert key in local_item, f"local[{name}] missing key '{key}'"
            assert key in rest_item, f"rest[{name}] missing key '{key}'"
