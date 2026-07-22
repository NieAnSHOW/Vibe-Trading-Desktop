"""IM channel runtime that connects MessageBus traffic to SessionService."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Iterable, Mapping
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from src.channels.bus.events import InboundMessage, OutboundMessage
from src.channels.bus.queue import MessageBus
from src.channels.manager import ChannelManager
from src.channels.pairing import PAIRING_COMMAND_META_KEY, handle_pairing_command
from src.config.paths import get_data_dir
from src.session.models import Message, Session

logger = logging.getLogger(__name__)


def _normalize_operator_ids(values: object) -> set[str]:
    """Normalize a configured operator collection, rejecting malformed containers."""
    if isinstance(values, (str, bytes, Mapping)) or not isinstance(values, Iterable):
        return set()
    return {str(operator) for operator in values}


@dataclass
class ChannelRuntimeConfig:
    """Runtime controls for IM channel processing."""

    reply_timeout_s: float = 600.0
    poll_interval_s: float = 0.25


class ChannelRuntime:
    """Route inbound channel messages into Vibe-Trading sessions."""

    def __init__(
        self,
        *,
        bus: MessageBus,
        session_service: Any,
        manager: ChannelManager | None,
        session_map_path: Path | None = None,
        reply_timeout_s: float = 600.0,
        poll_interval_s: float = 0.25,
        operators: Iterable[str] | None = None,
        channel_operators: Mapping[str, Iterable[str]] | None = None,
    ) -> None:
        self.bus = bus
        self.session_service = session_service
        self.manager = manager
        self.config = ChannelRuntimeConfig(
            reply_timeout_s=reply_timeout_s,
            poll_interval_s=poll_interval_s,
        )
        self._operators = _normalize_operator_ids(operators)
        self._channel_operators: dict[str, set[str]] = {}
        for channel, channel_members in (channel_operators or {}).items():
            normalized_members = _normalize_operator_ids(channel_members)
            if normalized_members:
                self._channel_operators[str(channel)] = normalized_members
        self.session_map_path = session_map_path or (get_data_dir() / "channels" / "sessions.json")
        self._session_map: dict[str, str] = {}
        self._consumer_task: asyncio.Task[None] | None = None
        self._manager_task: asyncio.Task[Any] | None = None
        self._handler_tasks: set[asyncio.Task[None]] = set()
        self._running = False

    async def start(self, *, start_manager: bool = True) -> None:
        """Start channel processing and, optionally, platform adapters."""
        if self._running:
            return
        self._session_map = self._load_session_map()
        self._running = True
        if start_manager and self.manager is not None:
            self._manager_task = asyncio.create_task(self.manager.start_all())
            await asyncio.sleep(0)
        self._consumer_task = asyncio.create_task(self._consume_loop())

    async def stop(self) -> None:
        """Stop channel processing and platform adapters."""
        self._running = False
        if self._consumer_task is not None:
            self._consumer_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._consumer_task
            self._consumer_task = None
        for task in list(self._handler_tasks):
            task.cancel()
        for task in list(self._handler_tasks):
            with suppress(asyncio.CancelledError):
                await task
        self._handler_tasks.clear()
        if self.manager is not None:
            await self.manager.stop_all()
        if self._manager_task is not None:
            with suppress(asyncio.CancelledError):
                await self._manager_task
            self._manager_task = None

    def status(self) -> dict[str, Any]:
        """Return runtime and channel status."""
        return {
            "running": self._running,
            "inbound_queue": self.bus.inbound_size,
            "outbound_queue": self.bus.outbound_size,
            "session_count": len(self._session_map),
            "channels": self.manager.get_status() if self.manager is not None else {},
        }

    async def _consume_loop(self) -> None:
        while True:
            msg = await self.bus.consume_inbound()
            task = asyncio.create_task(self._handle_inbound(msg))
            self._handler_tasks.add(task)
            task.add_done_callback(self._handler_tasks.discard)

    async def _handle_inbound(self, msg: InboundMessage) -> None:
        try:
            if self._is_pairing_command(msg.content):
                is_operator, is_global_operator = self._resolve_operator(msg.channel, msg.sender_id)
                if not is_operator:
                    logger.warning(
                        "Rejected /pairing from non-operator %s on %s",
                        msg.sender_id,
                        msg.channel,
                    )
                    await self.bus.publish_outbound(
                        OutboundMessage(
                            channel=msg.channel,
                            chat_id=msg.chat_id,
                            content="Not authorized to manage pairing requests.",
                            metadata={PAIRING_COMMAND_META_KEY: True, "unauthorized": True},
                        )
                    )
                    return
                reply = handle_pairing_command(
                    msg.channel,
                    self._pairing_subcommand_text(msg.content),
                    requesting_channel=msg.channel,
                    is_global_operator=is_global_operator,
                )
                await self.bus.publish_outbound(
                    OutboundMessage(
                        channel=msg.channel,
                        chat_id=msg.chat_id,
                        content=reply,
                        metadata={PAIRING_COMMAND_META_KEY: True},
                    )
                )
                return

            if self._is_new_session_command(msg.content):
                old_id = self.reset_session(msg.session_key)
                if old_id:
                    reply = "✅ Session reset. Your next message will start a new conversation."
                else:
                    reply = "ℹ️ No active session to reset."
                await self.bus.publish_outbound(
                    OutboundMessage(
                        channel=msg.channel,
                        chat_id=msg.chat_id,
                        content=reply,
                        metadata={"_channel_runtime": True, "session_reset": True},
                    )
                )
                return

            session_id = self._session_for(msg)
            result = await self.session_service.send_message(
                session_id,
                msg.content,
                include_shell_tools=False,
            )
            attempt_id = result.get("attempt_id") if isinstance(result, dict) else None
            reply = await self._wait_for_reply(session_id, attempt_id)
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=reply.content,
                    metadata={
                        "_channel_runtime": True,
                        "attempt_id": attempt_id,
                        "session_id": session_id,
                    },
                )
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - channel errors must surface to users
            logger.exception("Channel runtime failed for %s:%s", msg.channel, msg.chat_id)
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=f"Channel runtime error: {type(exc).__name__}: {exc}",
                    metadata={"_channel_runtime": True, "error": True},
                )
            )

    def _session_for(self, msg: InboundMessage) -> str:
        key = msg.session_key
        existing = self._session_map.get(key)
        if existing and self._session_exists(existing):
            return existing
        if existing:
            # The mapped session id no longer resolves in the store (e.g. the
            # store's base_dir changed between runs, or the session was pruned).
            # Drop the stale mapping and fall through to create a fresh session
            # so the user keeps chatting instead of hitting "Session ... not found".
            logger.warning(
                "Channel session map entry %s -> %s is stale; recreating session",
                key,
                existing,
            )
        session = self.session_service.create_session(
            title=f"{msg.channel}:{msg.chat_id}",
            config={"channel": msg.channel, "channel_chat_id": msg.chat_id},
        )
        session_id = _session_id(session)
        self._session_map[key] = session_id
        self._save_session_map()
        return session_id

    def _session_exists(self, session_id: str) -> bool:
        """Return True when the session id still resolves in the backing store."""
        try:
            return self.session_service.get_session(session_id) is not None
        except Exception:  # noqa: BLE001 - a broken store lookup must not wedge routing
            logger.exception("Failed to verify channel session %s", session_id)
            return False

    async def _wait_for_reply(self, session_id: str, attempt_id: str | None) -> Message:
        deadline = time.monotonic() + self.config.reply_timeout_s
        last_assistant: Message | None = None
        while time.monotonic() < deadline:
            messages = self.session_service.get_messages(session_id, limit=200)
            for message in reversed(messages):
                if message.role != "assistant":
                    continue
                if attempt_id and message.linked_attempt_id != attempt_id:
                    if last_assistant is None:
                        last_assistant = message
                    continue
                return message
            await asyncio.sleep(self.config.poll_interval_s)
        if last_assistant is not None:
            return last_assistant
        raise TimeoutError("timed out waiting for assistant reply")

    def _load_session_map(self) -> dict[str, str]:
        try:
            data = json.loads(self.session_map_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, json.JSONDecodeError):
            logger.warning("Ignoring invalid channel session map at %s", self.session_map_path)
            return {}
        if not isinstance(data, dict):
            return {}
        return {str(key): str(value) for key, value in data.items() if value}

    def _save_session_map(self) -> None:
        self.session_map_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.session_map_path.with_suffix(self.session_map_path.suffix + ".tmp")
        tmp.write_text(json.dumps(self._session_map, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.session_map_path)

    def reset_session(self, session_key: str) -> str | None:
        """Remove a session mapping so the next message creates a fresh session.

        Args:
            session_key: The channel:chat_id key to reset.

        Returns:
            The removed session_id, or None if no mapping existed.
        """
        removed = self._session_map.pop(session_key, None)
        if removed is not None:
            self._save_session_map()
        return removed

    def _resolve_operator(self, channel: str, sender_id: str) -> tuple[bool, bool]:
        """Return whether a sender is an operator and whether its scope is global."""
        if str(channel) == "websocket":
            return False, False
        normalized_sender = str(sender_id)
        sender_ids = {normalized_sender}
        if str(channel) == "signal":
            sender_ids.update(part for part in normalized_sender.split("|") if part)
        is_global = not sender_ids.isdisjoint(self._operators)
        is_channel_operator = not sender_ids.isdisjoint(
            self._channel_operators.get(str(channel), set())
        )
        return is_global or is_channel_operator, is_global

    @staticmethod
    def operators_from_config(config: Any) -> tuple[set[str], dict[str, set[str]]]:
        """Extract normalized global and per-channel operator IDs from config."""
        if config is None:
            return set(), {}
        if not isinstance(config, Mapping):
            config = config.model_dump(mode="json", by_alias=False)

        global_operators = _normalize_operator_ids(config.get("operators"))
        channel_operators: dict[str, set[str]] = {}
        for channel, section in config.items():
            if not isinstance(section, Mapping):
                continue
            normalized_members = _normalize_operator_ids(section.get("operators"))
            if normalized_members:
                channel_operators[str(channel)] = normalized_members
        return global_operators, channel_operators

    @staticmethod
    def _is_pairing_command(content: str) -> bool:
        stripped = content.strip().lower()
        return stripped == "/pairing" or stripped.startswith("/pairing ")

    @staticmethod
    def _pairing_subcommand_text(content: str) -> str:
        parts = content.strip().split(None, 1)
        return parts[1] if len(parts) > 1 else "list"

    @staticmethod
    def _is_new_session_command(content: str) -> bool:
        """Check if the message is a session reset command (/new, /reset, /newsession)."""
        return content.strip().lower() in ("/new", "/reset", "/newsession")


def _session_id(session: Session | dict[str, Any] | Any) -> str:
    if isinstance(session, Session):
        return session.session_id
    if isinstance(session, dict):
        return str(session["session_id"])
    return str(getattr(session, "session_id"))
