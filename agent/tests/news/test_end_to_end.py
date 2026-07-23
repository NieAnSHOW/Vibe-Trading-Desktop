from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from src.news.catalog import NewsCatalog, group_endpoints, load_catalog
from src.news.coordinator import NewsRefreshCoordinator
from src.news.models import CANONICAL_TRACK_IDS
from src.news.network import PublicFeedClient
from src.news.storage import AtomicSnapshotStore


FIRST_RUN = datetime(2026, 7, 20, 8, 0, tzinfo=timezone.utc)
SECOND_RUN = datetime(2026, 7, 20, 9, 0, tzinfo=timezone.utc)
THIRD_RUN = datetime(2026, 7, 20, 10, 0, tzinfo=timezone.utc)


class FakeResolver:
    async def resolve(self, host: str) -> tuple[str, ...]:
        return ("93.184.216.34",)


class FakeLLM:
    async def ainvoke(self, messages: list[dict[str, object]]) -> object:
        raise RuntimeError("fixture LLM unavailable")


def _catalog() -> NewsCatalog:
    return load_catalog("global_industry")


def _endpoint_key(url: str) -> tuple[str, str, str]:
    parsed = urlsplit(url)
    return parsed.netloc, parsed.path or "/", parsed.query


def _rss(track_id: str, run: int) -> bytes:
    title = f"{track_id} fixture headline {run}"
    link = f"https://news.example/{track_id}/{run}"
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<rss version=\"2.0\"><channel><title>Fixture feed</title>"
        f"<item><title>{title}</title><link>{link}</link>"
        "<description>Fixture summary only.</description>"
        "<pubDate>Mon, 20 Jul 2026 08:00:00 GMT</pubDate>"
        "</item></channel></rss>"
    ).encode("utf-8")


def test_refresh_degrades_without_network_or_llm_and_preserves_last_good_snapshot(tmp_path: Path) -> None:
    async def run_case() -> None:
        phase = {"run": 1, "now": FIRST_RUN}
        catalog = _catalog()
        endpoint_tracks = {
            _endpoint_key(endpoint.url): frozenset(assignment.track_id for assignment in endpoint.assignments)
            for endpoint in group_endpoints(catalog)
        }

        def handler(request: httpx.Request) -> httpx.Response:
            key = (request.headers["host"], request.url.path, request.url.query.decode("ascii"))
            track_ids = endpoint_tracks[key]
            unavailable = {
                1: {"semi", "science"},
                2: {"ai"},
                3: set(CANONICAL_TRACK_IDS),
            }[phase["run"]]
            if track_ids.intersection(unavailable):
                return httpx.Response(503, request=request)
            return httpx.Response(200, content=_rss(sorted(track_ids)[0], phase["run"]), request=request)

        async def no_sleep(delay: float) -> None:
            return None

        transport = httpx.MockTransport(handler)
        store = AtomicSnapshotStore("global_industry", data_dir=tmp_path)
        coordinator = NewsRefreshCoordinator(
            catalog=catalog,
            client_factory=lambda: PublicFeedClient(FakeResolver(), transport=transport, sleep=no_sleep),
            llm_factory=FakeLLM,
            store=store,
            now=lambda: phase["now"],
        )

        await coordinator.start()
        await coordinator.wait_current()
        first = await coordinator.snapshot_response()
        assert first.refresh.state == "succeeded"
        assert first.snapshot is not None
        first_tracks = {track.track_id: track for track in first.snapshot.tracks}
        assert first_tracks["semi"].state == "unavailable"
        assert first_tracks["science"].state == "unavailable"
        assert first_tracks["ai"].state == "fresh"
        assert all(
            track.ai.error is not None and track.ai.error.code == "ai_unavailable"
            for track in first.snapshot.tracks
            if track.state == "fresh"
        )

        phase.update(run=2, now=SECOND_RUN)
        await coordinator.start()
        await coordinator.wait_current()
        second = await coordinator.snapshot_response()
        assert second.refresh.state == "succeeded"
        assert second.snapshot is not None
        second_tracks = {track.track_id: track for track in second.snapshot.tracks}
        assert second_tracks["ai"].state == "stale"
        assert second_tracks["ai"].items == first_tracks["ai"].items
        assert second_tracks["semi"].state == "fresh"
        assert second_tracks["semi"].ai.error is not None
        assert second_tracks["semi"].ai.error.code == "ai_unavailable"

        snapshot_path = store.path
        before = snapshot_path.read_bytes()
        before_stat = snapshot_path.stat()
        phase.update(run=3, now=THIRD_RUN)
        await coordinator.start()
        await coordinator.wait_current()
        failed = await coordinator.snapshot_response()
        assert failed.refresh.state == "failed"
        assert failed.refresh.error is not None
        assert failed.refresh.error.code == "no_track_updated"
        assert failed.stale is True
        assert snapshot_path.read_bytes() == before
        assert snapshot_path.stat().st_mtime_ns == before_stat.st_mtime_ns
        await coordinator.close()

        rebuilt = NewsRefreshCoordinator(
            catalog=catalog,
            store=AtomicSnapshotStore("global_industry", data_dir=tmp_path),
        )
        rebuilt_response = await rebuilt.snapshot_response()
        assert rebuilt_response.refresh.state == "idle"
        assert rebuilt_response.snapshot == second.snapshot
        await rebuilt.close()

        persisted = json.loads(snapshot_path.read_text(encoding="utf-8"))
        assert len(persisted["tracks"]) == len(CANONICAL_TRACK_IDS)

    asyncio.run(run_case())
