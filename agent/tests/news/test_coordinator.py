import asyncio
import threading
from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from typing import Any

import pytest

from src.news.catalog import NewsCatalog, NewsScope, SourceAssignment, load_catalog
from src.news.feeds import RawFeedItem
from src.news.llm import enrich_tracks
from src.news.models import CANONICAL_TRACK_IDS, NewsSnapshot, SourceStats, TrackSnapshot
from src.news.network import EndpointFetchResult
from src.news.storage import SnapshotStorageError


NOW = datetime(2026, 7, 20, 8, 30, tzinfo=timezone.utc)


def make_catalog(scope: NewsScope = "a_share") -> NewsCatalog:
    return load_catalog(scope)


class FakeFeedClient:
    def __init__(self, gate: asyncio.Event | None = None, *, failing_ids: frozenset[str] = frozenset()) -> None:
        self.gate = gate
        self.failing_ids = failing_ids
        self.fetches: list[str] = []
        self.closed = False

    async def fetch(self, endpoint) -> EndpointFetchResult:
        self.fetches.append(endpoint.id)
        if self.gate is not None:
            await self.gate.wait()
        if endpoint.id in self.failing_ids:
            return EndpointFetchResult(endpoint=endpoint, body=None, error_code="network_error")
        return EndpointFetchResult(endpoint=endpoint, body=b"local feed", error_code=None, final_url=endpoint.url)

    async def aclose(self) -> None:
        self.closed = True


class MemoryStore:
    def __init__(self, snapshot: NewsSnapshot | None = None, write_error: Exception | None = None) -> None:
        self.snapshot = snapshot
        self.write_error = write_error
        self.writes: list[NewsSnapshot] = []
        self.write_started = threading.Event()
        self.write_gate: threading.Event | None = None

    def read(self) -> NewsSnapshot | None:
        if self.snapshot is None:
            raise SnapshotStorageError("snapshot_unavailable", "news snapshot is unavailable")
        return self.snapshot

    def write(self, snapshot: NewsSnapshot) -> None:
        self.write_started.set()
        if self.write_gate is not None:
            self.write_gate.wait(timeout=2)
        if self.write_error is not None:
            raise self.write_error
        self.writes.append(snapshot)
        self.snapshot = snapshot


def parsed_item(source: SourceAssignment) -> tuple[RawFeedItem, ...]:
    return (
        RawFeedItem(
            title=f"Headline {source.id}",
            summary="A local summary",
            published_at=NOW,
            url=f"https://news.example/{source.id}",
            source=source,
        ),
    )


def old_snapshot(title: str = "old", *, scope: NewsScope = "a_share") -> NewsSnapshot:
    from src.news.pipeline import build_track_candidates

    catalog = make_catalog(scope)
    current = []
    for source in catalog.assignments:
        from src.news.pipeline import AssignmentItems

        current.append(AssignmentItems(source=source, items=parsed_item(source)))
    result = build_track_candidates(catalog, current, None, NOW)
    tracks = [
        track.model_copy(update={"items": [item.model_copy(update={"title": title}) for item in track.items]})
        for track in result.tracks
    ]
    return NewsSnapshot(
        schema_version=2,
        scope=scope,
        generated_at=NOW,
        upstream_commit=catalog.commit,
        source_stats=SourceStats(
            endpoint_total=len({source.url for source in catalog.assignments}),
            endpoint_success_count=len({source.url for source in catalog.assignments}),
            endpoint_failure_count=0,
            assignment_total=len(catalog.assignments),
            assignment_success_count=len(catalog.assignments),
            assignment_failure_count=0,
        ),
        errors=[],
        tracks=tracks,
    )


async def wait_until(predicate: Callable[[], bool], timeout: float = 2) -> None:
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0)


def make_coordinator(**overrides: Any):
    from src.news.coordinator import NewsRefreshCoordinator

    catalog = overrides.pop("catalog", make_catalog())
    client = overrides.pop("client", FakeFeedClient())
    store = overrides.pop("store", MemoryStore())
    return NewsRefreshCoordinator(
        catalog=catalog,
        client_factory=lambda: client,
        parser=overrides.pop("parser", lambda payload, source: parsed_item(source)),
        store=store,
        now=lambda: NOW,
        **overrides,
    ), client, store


def make_registry(*, a_share_store: MemoryStore, global_store: MemoryStore):
    from src.news.coordinator import NewsCoordinatorRegistry, NewsRefreshCoordinator

    stores = {"a_share": a_share_store, "global_industry": global_store}

    async def identity_enricher(
        tracks: Sequence[TrackSnapshot], updated_track_ids: frozenset[str], llm_factory: Callable[[], Any]
    ) -> tuple[TrackSnapshot, ...]:
        return tuple(tracks)

    def factory(scope: NewsScope) -> NewsRefreshCoordinator:
        return NewsRefreshCoordinator(
            catalog=make_catalog(scope),
            client_factory=FakeFeedClient,
            parser=lambda payload, source: parsed_item(source),
            enricher=identity_enricher,
            store=stores[scope],
            now=lambda: NOW,
        )

    return NewsCoordinatorRegistry(factory)


def test_duplicate_start_reuses_running_task_and_returns_immediately() -> None:
    async def run_case() -> None:
        gate = asyncio.Event()
        coordinator, client, _ = make_coordinator(client=FakeFeedClient(gate))

        first = await asyncio.wait_for(coordinator.start(), timeout=0.1)
        second = await asyncio.wait_for(coordinator.start(), timeout=0.1)

        assert first.task_id == second.task_id
        assert first.reused is False
        assert second.reused is True
        assert len(set(client.fetches)) == len(coordinator._endpoints)
        gate.set()
        await coordinator.wait_current()
        assert (await coordinator.status()).state == "succeeded"
        await coordinator.close()

    asyncio.run(run_case())


def test_full_refresh_fetches_unique_endpoints_distributes_assignments_and_exposes_stages() -> None:
    async def run_case() -> None:
        fetch_gate = asyncio.Event()
        parser_started = threading.Event()
        parser_gate = threading.Event()
        enrich_started = asyncio.Event()
        enrich_gate = asyncio.Event()
        client = FakeFeedClient(fetch_gate)
        store = MemoryStore()
        store.write_gate = threading.Event()
        parsed_sources: list[str] = []

        def blocking_parser(payload: bytes, source: SourceAssignment) -> tuple[RawFeedItem, ...]:
            assert payload == b"local feed"
            parsed_sources.append(source.id)
            if len(parsed_sources) == 1:
                parser_started.set()
                parser_gate.wait(timeout=2)
            return parsed_item(source)

        async def gated_enricher(
            tracks: Sequence[TrackSnapshot], updated_track_ids: frozenset[str], llm_factory
        ) -> tuple[TrackSnapshot, ...]:
            assert updated_track_ids == frozenset(source.track_id for source in make_catalog().assignments)
            enrich_started.set()
            await enrich_gate.wait()
            return tuple(tracks)

        coordinator, _, _ = make_coordinator(
            client=client,
            store=store,
            parser=blocking_parser,
            enricher=gated_enricher,
        )

        await coordinator.start()
        await wait_until(lambda: len(client.fetches) == len(coordinator._endpoints))
        assert (await coordinator.status()).state == "fetching"

        fetch_gate.set()
        await asyncio.to_thread(parser_started.wait, 2)
        assert (await asyncio.wait_for(coordinator.status(), timeout=0.1)).state == "normalizing"
        parser_gate.set()

        await asyncio.wait_for(enrich_started.wait(), timeout=2)
        enriching = await coordinator.status()
        assert enriching.state == "enriching"
        assert enriching.processed_endpoints == len(coordinator._endpoints)
        assert enriching.successful_endpoints == len(coordinator._endpoints)
        assert enriching.failed_endpoints == 0
        enrich_gate.set()

        await asyncio.to_thread(store.write_started.wait, 2)
        assert (await asyncio.wait_for(coordinator.status(), timeout=0.1)).state == "committing"
        store.write_gate.set()
        await coordinator.wait_current()

        final = await coordinator.status()
        assert final.state == "succeeded"
        assert final.processed_tracks == 12
        assert len(client.fetches) == len(set(client.fetches)) == len(coordinator._endpoints)
        assert len(parsed_sources) == len(set(parsed_sources)) == len(coordinator._catalog.assignments)
        assert len(store.writes) == 1
        snapshot = store.writes[0]
        assert tuple(track.track_id for track in snapshot.tracks) == CANONICAL_TRACK_IDS
        assert snapshot.source_stats == SourceStats(
            endpoint_total=len(coordinator._endpoints),
            endpoint_success_count=len(coordinator._endpoints),
            endpoint_failure_count=0,
            assignment_total=len(coordinator._catalog.assignments),
            assignment_success_count=len(coordinator._catalog.assignments),
            assignment_failure_count=0,
        )
        outcomes = [outcome for track in snapshot.tracks for outcome in track.source_outcomes]
        assert {outcome.source_id for outcome in outcomes} == {source.id for source in coordinator._catalog.assignments}
        for track in snapshot.tracks:
            assert {outcome.source_id for outcome in track.source_outcomes} == {
                source.id for source in coordinator._catalog.assignments if source.track_id == track.track_id
            }
        assert all(outcome.state == "success" and outcome.reason is None for outcome in outcomes)
        assert all(outcome.last_success_at == NOW for outcome in outcomes)
        await coordinator.close()

    asyncio.run(run_case())


def test_no_track_updated_fails_before_llm_or_storage() -> None:
    async def run_case() -> None:
        calls = {"llm": 0, "enricher": 0}

        def llm_factory():
            calls["llm"] += 1
            raise AssertionError("LLM must not be built")

        async def enricher(*args):
            calls["enricher"] += 1
            raise AssertionError("enricher must not be called")

        coordinator, _, store = make_coordinator(
            parser=lambda payload, source: (),
            llm_factory=llm_factory,
            enricher=enricher,
        )
        await coordinator.start()
        await coordinator.wait_current()

        status = await coordinator.status()
        assert status.state == "failed"
        assert status.error is not None
        assert status.error.code == "no_track_updated"
        assert calls == {"llm": 0, "enricher": 0}
        assert store.writes == []
        await coordinator.close()

    asyncio.run(run_case())


def test_endpoint_failure_log_redacts_untrusted_error_code(caplog) -> None:
    async def run_case() -> None:
        coordinator, client, _ = make_coordinator()
        secret = "Bearer sk-live-do-not-log"
        client.failing_ids = frozenset({coordinator._endpoints[0].id})

        original_fetch = client.fetch

        async def fetch_with_untrusted_error(endpoint) -> EndpointFetchResult:
            result = await original_fetch(endpoint)
            if endpoint.id in client.failing_ids:
                return EndpointFetchResult(endpoint=endpoint, body=None, error_code=secret)
            return result

        client.fetch = fetch_with_untrusted_error
        with caplog.at_level("WARNING", logger="src.news.coordinator"):
            await coordinator.start()
            await coordinator.wait_current()

        assert secret not in caplog.text
        snapshot = (await coordinator.snapshot_response()).snapshot
        assert snapshot is not None
        affected_source_ids = {source.id for source in coordinator._endpoints[0].assignments}
        outcomes = [outcome for track in snapshot.tracks for outcome in track.source_outcomes]
        assert {
            (outcome.source_id, outcome.state, outcome.reason, outcome.last_success_at)
            for outcome in outcomes
            if outcome.source_id in affected_source_ids
        } == {(source_id, "failed", "network_error", None) for source_id in affected_source_ids}
        await coordinator.close()

    asyncio.run(run_case())


def test_parser_failure_is_a_failed_source_outcome() -> None:
    async def run_case() -> None:
        failed_source_id = make_catalog().assignments[0].id

        def parser(payload: bytes, source: SourceAssignment) -> tuple[RawFeedItem, ...]:
            if source.id == failed_source_id:
                raise ValueError("invalid source payload")
            return parsed_item(source)

        coordinator, _, _ = make_coordinator(parser=parser)
        await coordinator.start()
        await coordinator.wait_current()

        snapshot = (await coordinator.snapshot_response()).snapshot
        assert snapshot is not None
        outcome = next(
            outcome
            for track in snapshot.tracks
            for outcome in track.source_outcomes
            if outcome.source_id == failed_source_id
        )
        assert (outcome.state, outcome.reason, outcome.last_success_at) == ("failed", "network_error", None)
        await coordinator.close()

    asyncio.run(run_case())


def test_all_llm_tracks_can_fail_while_feed_snapshot_is_committed() -> None:
    async def run_case() -> None:
        builds = 0

        def unavailable_llm():
            nonlocal builds
            builds += 1
            raise RuntimeError("provider secret must not escape")

        coordinator, _, store = make_coordinator(enricher=enrich_tracks, llm_factory=unavailable_llm)
        await coordinator.start()
        await coordinator.wait_current()

        assert (await coordinator.status()).state == "succeeded"
        assert builds == 1
        assert len(store.writes) == 1
        refreshed_tracks = [track for track in store.writes[0].tracks if track.items]
        assert refreshed_tracks
        assert all(track.ai.error is not None and track.ai.error.code == "ai_unavailable" for track in refreshed_tracks)
        await coordinator.close()

    asyncio.run(run_case())


def test_commit_failure_preserves_old_snapshot_and_redacts_exception() -> None:
    async def run_case() -> None:
        previous = old_snapshot()
        store = MemoryStore(
            snapshot=previous,
            write_error=SnapshotStorageError("snapshot_write_failed", "secret_token=do-not-expose"),
        )
        coordinator, _, _ = make_coordinator(store=store)
        await coordinator.start()
        await coordinator.wait_current()

        status = await coordinator.status()
        response = await coordinator.snapshot_response()
        assert status.state == "failed"
        assert status.error is not None
        assert status.error.code == "snapshot_write_failed"
        assert "secret" not in status.error.message.lower()
        assert response.snapshot == previous
        assert response.available is True
        assert response.stale is True
        assert store.snapshot == previous
        await coordinator.close()

    asyncio.run(run_case())


def test_close_cancels_refresh_closes_client_and_never_commits_partial_snapshot() -> None:
    async def run_case() -> None:
        gate = asyncio.Event()
        client = FakeFeedClient(gate)
        coordinator, _, store = make_coordinator(client=client)
        await coordinator.start()
        await wait_until(lambda: len(client.fetches) == len(coordinator._endpoints))

        await coordinator.close()

        assert client.closed is True
        assert store.writes == []
        status = await coordinator.status()
        assert status.state == "cancelled"
        assert status.completed_at == NOW
        assert status.error is not None
        assert status.error.code == "cancelled"

    asyncio.run(run_case())


def test_close_waits_for_committing_write_and_reports_its_success() -> None:
    async def run_case() -> None:
        previous = old_snapshot()
        store = MemoryStore(snapshot=previous)
        store.write_gate = threading.Event()

        async def identity_enricher(
            tracks: Sequence[TrackSnapshot], updated_track_ids: frozenset[str], llm_factory
        ) -> tuple[TrackSnapshot, ...]:
            return tuple(tracks)

        coordinator, client, _ = make_coordinator(store=store, enricher=identity_enricher)
        await coordinator.start()
        await asyncio.to_thread(store.write_started.wait, 2)
        assert (await coordinator.status()).state == "committing"

        closing = asyncio.create_task(coordinator.close())
        await asyncio.sleep(0.05)
        assert not closing.done()

        store.write_gate.set()
        await closing

        status = await coordinator.status()
        assert status.state == "succeeded"
        assert store.snapshot == store.writes[0]
        assert store.snapshot != previous
        assert client.closed is True

    asyncio.run(run_case())


def test_start_is_rejected_once_close_has_begun() -> None:
    async def run_case() -> None:
        store = MemoryStore()
        store.write_gate = threading.Event()

        async def identity_enricher(
            tracks: Sequence[TrackSnapshot], updated_track_ids: frozenset[str], llm_factory
        ) -> tuple[TrackSnapshot, ...]:
            return tuple(tracks)

        coordinator, client, _ = make_coordinator(store=store, enricher=identity_enricher)
        await coordinator.start()
        await asyncio.to_thread(store.write_started.wait, 2)
        assert (await coordinator.status()).state == "committing"

        closing = asyncio.create_task(coordinator.close())
        await asyncio.sleep(0)

        with pytest.raises(RuntimeError, match="news refresh coordinator is closed"):
            await coordinator.start()

        store.write_gate.set()
        await closing
        with pytest.raises(RuntimeError, match="news refresh coordinator is closed"):
            await coordinator.start()
        assert client.closed is True

    asyncio.run(run_case())


def test_global_refresh_never_mutates_a_share_store() -> None:
    async def run_case() -> None:
        registry = make_registry(a_share_store=MemoryStore(), global_store=MemoryStore())

        a_share = registry.get("a_share")
        await a_share.start()
        await a_share.wait_current()
        a_share_before = await a_share.snapshot_response()

        global_industry = registry.get("global_industry")
        await global_industry.start()
        await global_industry.wait_current()

        assert await a_share.snapshot_response() == a_share_before
        assert (await global_industry.snapshot_response()).snapshot is not None
        await registry.close()

    asyncio.run(run_case())


def test_registry_is_lazy_and_does_not_build_client_or_llm(monkeypatch) -> None:
    import src.news.coordinator as module

    module._news_coordinator_registry = None
    client_builds = 0
    llm_builds = 0

    def client_factory():
        nonlocal client_builds
        client_builds += 1
        return FakeFeedClient()

    def llm_factory():
        nonlocal llm_builds
        llm_builds += 1
        raise AssertionError("must stay lazy")

    monkeypatch.setattr(module, "_default_client_factory", client_factory)
    monkeypatch.setattr(module, "_build_project_llm", llm_factory)

    first = module.get_news_coordinator_registry()
    second = module.get_news_coordinator_registry()

    assert first is second
    assert client_builds == 0
    assert llm_builds == 0
