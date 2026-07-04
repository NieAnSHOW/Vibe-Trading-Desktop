"""Channel config loading helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.config.loader import load_agent_config


def load_channels_config(config_path: Path | None = None) -> dict[str, Any]:
    """Load the operator IM channel config from the structured agent config.

    Args:
        config_path: Optional explicit config path.

    Returns:
        A plain dictionary suitable for :class:`src.channels.manager.ChannelManager`.
    """
    config = load_agent_config(config_path)
    data = config.channels.model_dump(mode="json", by_alias=False)
    # ponytail: 默认安装微信渠道。operator 未显式配置 weixin 时注入开箱即用的
    # 默认 section(enabled=true + ilinkai 默认连接参数),WebUI 扫码登录按钮无需手工配置即可用。
    # 其他渠道仍需 operator 显式 enabled,不在此默认开放。
    if "weixin" not in data:
        from src.channels.weixin import WeixinConfig

        data["weixin"] = WeixinConfig(enabled=True).model_dump(mode="json", by_alias=False)
    return data
