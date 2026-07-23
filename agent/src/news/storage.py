"""Atomic persistence for validated, scope-isolated investment-news snapshots."""

from __future__ import annotations

import json
import logging
import os
import stat
import tempfile
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from src.config.paths import get_data_dir
from src.news.catalog import NewsScope, load_catalog
from src.news.models import NewsSnapshot, _validate_public_http_url


logger = logging.getLogger(__name__)
MAX_SNAPSHOT_BYTES = 2_000_000
_DISALLOWED_KEYS = frozenset({"api_key", "apikey", "authorization", "credential", "credentials", "password", "secret", "token", "content", "full_content", "raw_content"})


class SnapshotStorageError(RuntimeError):
    """A stable, non-sensitive error surfaced for snapshot I/O failures."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class AtomicSnapshotStore:
    """Read and atomically replace one scope's validated news snapshot."""

    def __init__(
        self, scope: NewsScope = "a_share", data_dir: Path | None = None, *, max_bytes: int = MAX_SNAPSHOT_BYTES
    ) -> None:
        if scope not in {"a_share", "global_industry"}:
            raise ValueError("snapshot scope is invalid")
        self.scope = scope
        self.data_dir = data_dir if data_dir is not None else get_data_dir()
        self.path = self.data_dir / "news" / f"{scope}.json"
        self._legacy_path = self.data_dir / "news" / "latest.json"
        self.max_bytes = max_bytes

    def read(self) -> NewsSnapshot | None:
        """Return the current validated snapshot or a stable classification error."""
        try:
            data = self._read_data(self.path)
        except FileNotFoundError as exc:
            if self.scope != "a_share":
                raise SnapshotStorageError("snapshot_unavailable", "news snapshot is unavailable") from exc
            try:
                data = self._read_data(self._legacy_path)
            except FileNotFoundError as legacy_exc:
                raise SnapshotStorageError("snapshot_unavailable", "news snapshot is unavailable") from legacy_exc
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError) as legacy_exc:
                logger.warning("news snapshot read rejected: %s", type(legacy_exc).__name__)
                raise SnapshotStorageError("snapshot_corrupt", "news snapshot is corrupt") from legacy_exc
            try:
                return _upgrade_v1_snapshot(data)
            except (OSError, ValidationError, ValueError, TypeError) as legacy_exc:
                logger.warning("news legacy snapshot read rejected: %s", type(legacy_exc).__name__)
                raise SnapshotStorageError("snapshot_corrupt", "news snapshot is corrupt") from legacy_exc
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError) as exc:
            logger.warning("news snapshot read rejected: %s", type(exc).__name__)
            raise SnapshotStorageError("snapshot_corrupt", "news snapshot is corrupt") from exc

        try:
            if not isinstance(data, dict) or data.get("schema_version") != 2:
                raise ValueError("snapshot schema is invalid")
            snapshot = NewsSnapshot.model_validate(data)
            if snapshot.scope != self.scope:
                raise ValueError("snapshot scope does not match store")
            return snapshot
        except (OSError, ValidationError, ValueError, TypeError) as exc:
            logger.warning("news snapshot read rejected: %s", type(exc).__name__)
            raise SnapshotStorageError("snapshot_corrupt", "news snapshot is corrupt") from exc

    def _read_data(self, path: Path) -> Any:
        path_stat = path.lstat()
        if not stat.S_ISREG(path_stat.st_mode):
            raise ValueError("snapshot is not a regular file")
        fd: int | None = None
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(path, flags)
            opened_stat = os.fstat(fd)
            if not stat.S_ISREG(opened_stat.st_mode) or opened_stat.st_size > self.max_bytes:
                raise ValueError("snapshot exceeds maximum size")
            with os.fdopen(fd, "rb") as stream:
                fd = None
                raw = stream.read(self.max_bytes + 1)
            if len(raw) > self.max_bytes:
                raise ValueError("snapshot exceeds maximum size")
            data = json.loads(raw)
            if _contains_disallowed_keys(data):
                raise ValueError("snapshot has disallowed key")
            return data
        finally:
            if fd is not None:
                os.close(fd)

    def write(self, snapshot: NewsSnapshot) -> None:
        """Durably replace the snapshot without risking an existing good file."""
        tmp_name: str | None = None
        try:
            if snapshot.schema_version != 2 or snapshot.scope != self.scope:
                raise ValueError("snapshot scope does not match store")
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.path.parent, 0o700)
            payload = _serialize(snapshot, self.max_bytes)
            fd, tmp_name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent)
            try:
                os.fchmod(fd, 0o600)
                if stat.S_IMODE(os.fstat(fd).st_mode) != 0o600:
                    raise PermissionError("temporary snapshot file is not private")
                with os.fdopen(fd, "wb") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
            except BaseException:
                os.close(fd) if _fd_is_open(fd) else None
                raise
            _validate_payload(payload, self.max_bytes)
            os.replace(tmp_name, self.path)
            tmp_name = None
            try:
                self._fsync_directory()
            except OSError:
                logger.debug("news snapshot directory sync failed after commit", exc_info=True)
        except (OSError, ValidationError, ValueError, TypeError, json.JSONDecodeError) as exc:
            logger.warning("news snapshot write rejected: %s", type(exc).__name__)
            raise SnapshotStorageError("snapshot_write_failed", "news snapshot could not be saved") from exc
        finally:
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name)
                except FileNotFoundError:
                    pass
                except OSError:
                    logger.warning("news snapshot temporary cleanup failed")

    def _fsync_directory(self) -> None:
        try:
            fd = os.open(self.path.parent, os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(fd)
        except OSError:
            logger.debug("news snapshot directory fsync unsupported", exc_info=True)
        finally:
            try:
                os.close(fd)
            except OSError:
                logger.debug("news snapshot directory close failed", exc_info=True)


def _serialize(snapshot: NewsSnapshot, max_bytes: int) -> bytes:
    payload = json.dumps(snapshot.model_dump(mode="json"), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    _validate_payload(payload, max_bytes)
    return payload


def _validate_payload(payload: bytes, max_bytes: int) -> None:
    if len(payload) > max_bytes:
        raise ValueError("snapshot exceeds maximum size")
    data = json.loads(payload)
    if _contains_disallowed_keys(data):
        raise ValueError("snapshot has disallowed key")
    NewsSnapshot.model_validate(data)


def _contains_disallowed_keys(value: Any) -> bool:
    if isinstance(value, dict):
        return any(str(key).lower() in _DISALLOWED_KEYS or _contains_disallowed_keys(item) for key, item in value.items())
    if isinstance(value, list):
        return any(_contains_disallowed_keys(item) for item in value)
    return False


def _fd_is_open(fd: int) -> bool:
    try:
        os.fstat(fd)
    except OSError:
        return False
    return True


def _upgrade_v1_snapshot(data: Any) -> NewsSnapshot:
    """Convert the read-only legacy A-share fallback into the v2 public shape."""
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise ValueError("legacy snapshot schema is invalid")

    upgraded = dict(data)
    upgraded["schema_version"] = 2
    upgraded["scope"] = "a_share"
    catalog = load_catalog("a_share")
    assignments_by_track: dict[str, list[Any]] = {}
    for assignment in catalog.assignments:
        assignments_by_track.setdefault(assignment.track_id, []).append(assignment)

    upgraded["source_stats"] = _migrated_stats(catalog.assignments)
    tracks = upgraded.get("tracks")
    if not isinstance(tracks, list):
        raise ValueError("legacy snapshot tracks are invalid")
    generated_at = upgraded.get("generated_at")
    for track in tracks:
        if not isinstance(track, dict) or not isinstance(track.get("track_id"), str):
            raise ValueError("legacy snapshot track is invalid")
        track_id = track["track_id"]
        track["source_stats"] = _migrated_stats(assignments_by_track.get(track_id, []))
        track["source_outcomes"] = []
        # The legacy feed URL was never an article URL. Validate it before it is
        # removed so a credential-bearing v1 file cannot become silently valid.
        items = track.get("items")
        if not isinstance(items, list):
            raise ValueError("legacy snapshot items are invalid")
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("source"), dict):
                raise ValueError("legacy snapshot item is invalid")
            source = dict(item["source"])
            feed_url = source.pop("url", None)
            if not isinstance(feed_url, str):
                raise ValueError("legacy snapshot feed URL is invalid")
            _validate_public_http_url(feed_url)
            item["source"] = source
            item["article_access"] = "summary_only"
            item["first_seen_at"] = item.get("published_at") or track.get("generated_at") or generated_at
        if track.get("state") == "fresh":
            track["partial"] = False
    return NewsSnapshot.model_validate(upgraded)


def _migrated_stats(assignments: Any) -> dict[str, int]:
    sources = tuple(assignments)
    return {
        "endpoint_total": len({source.url for source in sources}),
        "endpoint_success_count": 0,
        "endpoint_failure_count": 0,
        "assignment_total": len(sources),
        "assignment_success_count": 0,
        "assignment_failure_count": 0,
    }
