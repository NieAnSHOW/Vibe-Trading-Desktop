"""Contract tests for the authenticated investment-news HTTP boundary."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import importlib
from pathlib import Path
import subprocess
import sys
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.news.catalog import NewsScope
from src.news.coordinator import NewsRefreshCoordinator
from src.news.models import RefreshAcceptedResponse, RefreshStatus, SnapshotResponse
from src.news.storage import SnapshotStorageError


class FakeNewsCoordinator:
    """In-memory coordinator that cannot construct feeds or an LLM."""

    def __init__(self, scope: NewsScope = "a_share") -> None:
        self.scope = scope
        self.gate = asyncio.Event()
        self.running = asyncio.Event()
        self.task_id = UUID("00000000-0000-0000-0000-000000000001")
        self.start_calls = 0
        self.background_starts = 0
        self.close_calls = 0
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> RefreshAcceptedResponse:
        self.start_calls += 1
        reused = self._task is not None and not self._task.done()
        if not reused:
            self._task = asyncio.create_task(self._refresh())
            await self.running.wait()
        status = RefreshStatus(
            state="fetching",
            scope=self.scope,
            task_id=self.task_id,
            started_at=datetime.now(timezone.utc),
        )
        return RefreshAcceptedResponse(task_id=self.task_id, reused=reused, status=status)

    async def status(self) -> RefreshStatus:
        return RefreshStatus(state="idle", scope=self.scope)

    async def snapshot_response(self) -> SnapshotResponse:
        return SnapshotResponse(
            available=False,
            stale=False,
            snapshot=None,
            refresh=RefreshStatus(state="idle", scope=self.scope),
        )

    async def close(self) -> None:
        self.close_calls += 1
        self.gate.set()
        if self._task is not None:
            await self._task

    async def _refresh(self) -> None:
        self.background_starts += 1
        self.running.set()
        await self.gate.wait()


class FakeNewsCoordinatorRegistry:
    def __init__(self) -> None:
        self.coordinators = {scope: FakeNewsCoordinator(scope) for scope in ("a_share", "global_industry")}
        self.get_calls: list[NewsScope] = []
        self.close_calls = 0

    def get(self, scope: NewsScope) -> FakeNewsCoordinator:
        self.get_calls.append(scope)
        return self.coordinators[scope]

    async def close(self) -> None:
        self.close_calls += 1
        await asyncio.gather(*(coordinator.close() for coordinator in self.coordinators.values()))


@pytest.fixture()
def registry() -> FakeNewsCoordinatorRegistry:
    return FakeNewsCoordinatorRegistry()


@pytest.fixture()
def client(registry: FakeNewsCoordinatorRegistry) -> TestClient:
    from src.api.news_routes import register_news_routes

    app = FastAPI()

    async def allow_request() -> None:
        return None

    register_news_routes(app, require_auth=allow_request, registry=registry)

    @app.on_event("shutdown")
    async def close_registry() -> None:
        await registry.close()

    with TestClient(app) as test_client:
        yield test_client


def test_snapshot_returns_unavailable_envelope_without_starting_refresh(
    client: TestClient, registry: FakeNewsCoordinatorRegistry
) -> None:
    response = client.get("/news-api/snapshot")

    assert response.status_code == 200
    assert response.json()["available"] is False
    assert response.json()["snapshot"] is None
    assert registry.coordinators["a_share"].start_calls == 0


def test_refresh_returns_202_and_reuses_the_task_awaiting_its_gate(
    client: TestClient, registry: FakeNewsCoordinatorRegistry
) -> None:
    first = client.post("/news-api/refresh")
    second = client.post("/news-api/refresh")

    assert first.status_code == 202
    assert second.status_code == 202
    assert second.json()["reused"] is True
    assert second.json()["task_id"] == first.json()["task_id"]
    coordinator = registry.coordinators["a_share"]
    assert coordinator.running.is_set()
    assert coordinator.gate.is_set() is False
    assert coordinator.start_calls == 2
    assert coordinator.background_starts == 1


def test_refresh_status_does_not_start_work(client: TestClient, registry: FakeNewsCoordinatorRegistry) -> None:
    response = client.get("/news-api/refresh/status")

    assert response.status_code == 200
    assert response.json()["state"] == "idle"
    assert registry.coordinators["a_share"].start_calls == 0


def test_routes_accept_only_known_scope(client: TestClient, registry: FakeNewsCoordinatorRegistry) -> None:
    global_snapshot = client.get("/news-api/snapshot?scope=global_industry")
    invalid_scope = client.post("/news-api/refresh?scope=arbitrary&feed_url=https://bad.example")
    repeated_scope = client.get("/news-api/snapshot?scope=a_share&scope=global_industry")
    body = client.post("/news-api/refresh?scope=a_share", json={"feed_url": "https://example.test/feed"})

    assert global_snapshot.status_code == 200
    assert global_snapshot.json()["refresh"]["scope"] == "global_industry"
    assert invalid_scope.status_code == 422
    assert repeated_scope.status_code == 422
    assert body.status_code == 422
    assert registry.get_calls == ["global_industry"]
    assert "https://bad.example" not in invalid_scope.text


def test_news_routes_reject_body_and_unknown_query_parameters(client: TestClient) -> None:
    body = client.post("/news-api/refresh", json={"feed_url": "https://example.test/feed"})
    query = client.get("/news-api/snapshot?track_id=ai&llm=secret")
    get_body = client.request("GET", "/news-api/refresh/status", content=b"track_id=ai")

    assert body.status_code == 422
    assert query.status_code == 422
    assert get_body.status_code == 422
    assert body.headers["content-type"].startswith("application/json")
    assert "https://example.test/feed" not in body.text
    assert "secret" not in query.text


def test_snapshot_corruption_returns_a_redacted_envelope_without_logging_canary(caplog: pytest.LogCaptureFixture) -> None:
    class CorruptStore:
        def read(self) -> None:
            raise SnapshotStorageError("snapshot_corrupt", "snapshot-canary-do-not-disclose")

        def write(self, snapshot: object) -> None:
            raise AssertionError("snapshot reads must not write")

    coordinator = NewsRefreshCoordinator(store=CorruptStore())
    app = FastAPI()

    async def allow_request() -> None:
        return None

    from src.api.news_routes import register_news_routes

    registry = FakeNewsCoordinatorRegistry()
    registry.coordinators["a_share"] = coordinator
    register_news_routes(app, require_auth=allow_request, registry=registry)
    with TestClient(app) as test_client:
        response = test_client.get("/news-api/snapshot")

    assert response.status_code == 200
    assert response.json() == {
        "available": False,
        "stale": False,
        "snapshot": None,
        "refresh": {
            "state": "idle",
            "scope": "a_share",
            "task_id": None,
            "started_at": None,
            "completed_at": None,
            "processed_endpoints": 0,
            "successful_endpoints": 0,
            "failed_endpoints": 0,
            "processed_tracks": 0,
            "total_endpoints": 13,
            "total_tracks": 12,
            "error": None,
        },
        "error": {"code": "snapshot_corrupt", "message": "news snapshot is corrupt"},
    }
    assert "snapshot-canary-do-not-disclose" not in response.text
    assert "snapshot-canary-do-not-disclose" not in caplog.text


def test_api_server_registers_and_closes_the_same_news_registry(monkeypatch: pytest.MonkeyPatch) -> None:
    import api_server
    import src.api.news_routes as news_routes
    import src.news.coordinator as coordinator_module

    registry = FakeNewsCoordinatorRegistry()
    registrations: list[object] = []

    def get_registry() -> FakeNewsCoordinatorRegistry:
        return registry

    real_register = news_routes.register_news_routes

    def register_spy(app: FastAPI, require_auth: object, registry: object) -> None:
        registrations.append(registry)
        real_register(app, require_auth=require_auth, registry=registry)  # type: ignore[arg-type]

    monkeypatch.setattr(coordinator_module, "get_news_coordinator_registry", get_registry)
    monkeypatch.setattr(news_routes, "register_news_routes", register_spy)
    monkeypatch.delitem(sys.modules, "api_server")

    reloaded_api_server = importlib.import_module("api_server")
    with TestClient(reloaded_api_server.app):
        pass

    assert registrations == [registry]
    assert registry.close_calls == 1
    assert reloaded_api_server.news_coordinator_registry is registry
    monkeypatch.setitem(sys.modules, "api_server", api_server)


def test_api_server_imports_with_scheduled_204_route() -> None:
    result = subprocess.run(
        [sys.executable, "-c", "import api_server"],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
