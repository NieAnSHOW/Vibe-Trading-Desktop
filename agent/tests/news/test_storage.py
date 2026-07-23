import json
import os
import stat
from datetime import datetime, timezone
from pathlib import Path

import pytest

from src.news.catalog import load_catalog
from src.news.models import CANONICAL_TRACK_IDS, FeedItem, FeedSource, NewsSnapshot, SourceStats, TrackAi, TrackSnapshot
from src.news.storage import AtomicSnapshotStore, SnapshotStorageError


NOW = datetime(2026, 7, 20, 8, 30, tzinfo=timezone.utc)
A_SHARE_ASSIGNMENTS = load_catalog("a_share").assignments


def source_stats(track_id: str | None = None) -> SourceStats:
    assignments = [item for item in A_SHARE_ASSIGNMENTS if track_id is None or item.track_id == track_id]
    successful = int(bool(assignments))
    return SourceStats(
        endpoint_total=len({item.url for item in assignments}),
        endpoint_success_count=successful,
        endpoint_failure_count=0,
        assignment_total=len(assignments),
        assignment_success_count=successful,
        assignment_failure_count=0,
    )


def make_snapshot(title: str = "A valid title") -> NewsSnapshot:
    tracks = []
    for track_id in CANONICAL_TRACK_IDS:
        entry = FeedItem(
            id=f"{track_id}-1",
            track_id=track_id,
            title=title,
            summary="A short summary.",
            source=FeedSource(id="source-1", name="Source"),
            published_at=NOW,
            url="https://example.com/article",
            article_access="direct",
            first_seen_at=NOW,
        )
        tracks.append(
            TrackSnapshot(
                track_id=track_id,
                state="fresh",
                generated_at=NOW,
                stale=False,
                partial=False,
                items=[entry],
                ai=TrackAi(available=True, generated_at=NOW, highlights=["One", "Two", "Three"]),
                source_stats=source_stats(track_id),
                source_outcomes=[],
            )
        )
    return NewsSnapshot(
        schema_version=2,
        scope="a_share",
        generated_at=NOW,
        upstream_commit="d98aa603228f4839fb48859812c63a58ca10cead",
        source_stats=source_stats(),
        errors=[],
        tracks=tracks,
    )


def store(tmp_path: Path, scope: str = "a_share") -> AtomicSnapshotStore:
    return AtomicSnapshotStore(scope, data_dir=tmp_path)


def write_v1_snapshot(path: Path) -> None:
    payload = make_snapshot().model_dump(mode="json")
    payload["schema_version"] = 1
    payload.pop("scope")
    for stats in [payload["source_stats"], *(track["source_stats"] for track in payload["tracks"])]:
        stats.pop("endpoint_total")
        stats.pop("assignment_total")
    for track in payload["tracks"]:
        track.pop("source_outcomes")
        for entry in track["items"]:
            entry.pop("article_access")
            entry.pop("first_seen_at")
            entry["source"]["url"] = "https://example.com/feed"
    path.parent.mkdir(mode=0o700)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_write_then_read_uses_private_file_and_directory_permissions(tmp_path: Path) -> None:
    snapshot_store = store(tmp_path)
    expected = make_snapshot()

    snapshot_store.write(expected)

    assert snapshot_store.read() == expected
    assert snapshot_store.path == tmp_path / "news" / "a_share.json"
    assert stat.S_IMODE(snapshot_store.path.stat().st_mode) == 0o600
    assert stat.S_IMODE(snapshot_store.path.parent.stat().st_mode) == 0o700


def test_default_path_is_under_user_data_directory(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("src.news.storage.get_data_dir", lambda: tmp_path / "runtime")

    assert AtomicSnapshotStore("a_share").path == tmp_path / "runtime" / "news" / "a_share.json"


def test_corrupt_or_secret_bearing_snapshot_is_classified_as_corrupt_without_details(tmp_path) -> None:
    snapshot_store = store(tmp_path)
    snapshot_store.path.parent.mkdir(mode=0o700)
    snapshot_store.path.write_text('{"api_key":"secret"}', encoding="utf-8")

    with pytest.raises(SnapshotStorageError, match="corrupt") as exc:
        snapshot_store.read()

    assert exc.value.code == "snapshot_corrupt"
    assert "api_key" not in str(exc.value)


def test_oversized_snapshot_is_rejected_safely(tmp_path) -> None:
    snapshot_store = store(tmp_path)
    snapshot_store.path.parent.mkdir(mode=0o700)
    snapshot_store.path.write_bytes(b"{" + b" " * (snapshot_store.max_bytes + 1) + b"}")

    with pytest.raises(SnapshotStorageError) as exc:
        snapshot_store.read()

    assert exc.value.code == "snapshot_corrupt"


def test_missing_snapshot_is_classified_as_unavailable(tmp_path) -> None:
    snapshot_store = store(tmp_path)

    with pytest.raises(SnapshotStorageError) as exc:
        snapshot_store.read()

    assert exc.value.code == "snapshot_unavailable"


def test_read_rejects_symlink_and_non_regular_snapshot_files(tmp_path) -> None:
    snapshot_store = store(tmp_path)
    snapshot_store.path.parent.mkdir(mode=0o700)
    target = tmp_path / "target.json"
    target.write_text("{}", encoding="utf-8")
    snapshot_store.path.symlink_to(target)

    with pytest.raises(SnapshotStorageError) as exc:
        snapshot_store.read()
    assert exc.value.code == "snapshot_corrupt"

    snapshot_store.path.unlink()
    snapshot_store.path.mkdir()
    with pytest.raises(SnapshotStorageError) as exc:
        snapshot_store.read()
    assert exc.value.code == "snapshot_corrupt"


def test_read_classifies_permission_errors_as_corrupt(monkeypatch, tmp_path) -> None:
    snapshot_store = store(tmp_path)
    snapshot_store.write(make_snapshot(title="old"))

    def deny_open(*args, **kwargs):
        raise PermissionError("simulated permission denial")

    monkeypatch.setattr("src.news.storage.os.open", deny_open)
    with pytest.raises(SnapshotStorageError) as exc:
        snapshot_store.read()

    assert exc.value.code == "snapshot_corrupt"


def test_replace_failure_preserves_old_snapshot_and_cleans_temp(monkeypatch, tmp_path) -> None:
    snapshot_store = store(tmp_path)
    old = make_snapshot()
    snapshot_store.write(old)
    old_contents = snapshot_store.path.read_bytes()

    def fail_replace(source, destination):
        raise OSError("simulated replace failure")

    monkeypatch.setattr("src.news.storage.os.replace", fail_replace)
    with pytest.raises(SnapshotStorageError, match="could not be saved") as exc:
        snapshot_store.write(make_snapshot())

    assert exc.value.code == "snapshot_write_failed"
    assert snapshot_store.path.read_bytes() == old_contents
    assert list(snapshot_store.path.parent.glob(".a_share.json.*")) == []


def test_pre_replace_permission_failure_preserves_old_snapshot(monkeypatch, tmp_path) -> None:
    snapshot_store = store(tmp_path)
    snapshot_store.write(make_snapshot())
    old_contents = snapshot_store.path.read_bytes()

    def fail_mode(*args, **kwargs):
        raise PermissionError("simulated temp mode failure")

    monkeypatch.setattr("src.news.storage.os.fchmod", fail_mode)
    with pytest.raises(SnapshotStorageError) as exc:
        snapshot_store.write(make_snapshot())

    assert exc.value.code == "snapshot_write_failed"
    assert snapshot_store.path.read_bytes() == old_contents


def test_unverified_temp_file_mode_preserves_old_snapshot(monkeypatch, tmp_path) -> None:
    snapshot_store = store(tmp_path)
    snapshot_store.write(make_snapshot(title="old"))
    old_contents = snapshot_store.path.read_bytes()
    real_fchmod = os.fchmod

    def set_incorrect_mode(fd, mode):
        real_fchmod(fd, 0o644)

    monkeypatch.setattr("src.news.storage.os.fchmod", set_incorrect_mode)
    with pytest.raises(SnapshotStorageError) as exc:
        snapshot_store.write(make_snapshot(title="new"))

    assert exc.value.code == "snapshot_write_failed"
    assert snapshot_store.path.read_bytes() == old_contents


def test_post_replace_permission_or_sync_failure_does_not_report_write_failure(monkeypatch, tmp_path) -> None:
    snapshot_store = store(tmp_path)
    snapshot_store.write(make_snapshot())
    old_contents = snapshot_store.path.read_bytes()
    real_chmod = os.chmod

    def reject_final_file_mode(path, mode):
        if path == snapshot_store.path:
            raise PermissionError("simulated final file chmod failure")
        return real_chmod(path, mode)

    monkeypatch.setattr("src.news.storage.os.chmod", reject_final_file_mode)
    monkeypatch.setattr(snapshot_store, "_fsync_directory", lambda: (_ for _ in ()).throw(OSError("simulated sync failure")))

    snapshot_store.write(make_snapshot(title="new"))

    assert snapshot_store.path.read_bytes() != old_contents


def test_write_revalidates_serialized_snapshot_before_replace(monkeypatch, tmp_path) -> None:
    snapshot_store = store(tmp_path)
    snapshot_store.write(make_snapshot())
    old_contents = snapshot_store.path.read_bytes()

    real_loads = json.loads
    monkeypatch.setattr("src.news.storage.json.loads", lambda value: {"api_key": "secret"})
    with pytest.raises(SnapshotStorageError, match="could not be saved"):
        snapshot_store.write(make_snapshot())
    monkeypatch.setattr("src.news.storage.json.loads", real_loads)

    assert snapshot_store.path.read_bytes() == old_contents


def test_a_share_store_reads_v1_legacy_file_without_source_outcomes(tmp_path: Path) -> None:
    legacy_path = tmp_path / "news" / "latest.json"
    write_v1_snapshot(legacy_path)

    restored = store(tmp_path).read()

    assert restored.schema_version == 2
    assert restored.scope == "a_share"
    assert all(track.source_outcomes == [] for track in restored.tracks)
    assert all(entry.article_access == "summary_only" for track in restored.tracks for entry in track.items)
    assert all(entry.first_seen_at == NOW for track in restored.tracks for entry in track.items)
    assert restored.source_stats.endpoint_total == 13
    assert restored.source_stats.assignment_total == 13
    assert legacy_path.exists()


def test_global_store_never_reads_a_share_v1_legacy_file(tmp_path: Path) -> None:
    write_v1_snapshot(tmp_path / "news" / "latest.json")

    with pytest.raises(SnapshotStorageError) as exc:
        store(tmp_path, "global_industry").read()

    assert exc.value.code == "snapshot_unavailable"


def test_legacy_registry_lookup_errors_are_classified_as_corrupt(monkeypatch, tmp_path: Path) -> None:
    write_v1_snapshot(tmp_path / "news" / "latest.json")

    def unavailable_registry(scope: str):
        raise OSError(f"registry unavailable for {scope}")

    monkeypatch.setattr("src.news.storage.load_catalog", unavailable_registry)
    with pytest.raises(SnapshotStorageError) as exc:
        store(tmp_path).read()

    assert exc.value.code == "snapshot_corrupt"


def test_write_rejects_snapshot_for_another_scope(tmp_path: Path) -> None:
    with pytest.raises(SnapshotStorageError) as exc:
        store(tmp_path, "global_industry").write(make_snapshot())

    assert exc.value.code == "snapshot_write_failed"
