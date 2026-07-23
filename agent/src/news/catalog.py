"""Validated, scope-aware access to the project-owned news source registry."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from dataclasses import dataclass
from importlib.resources import files
from types import MappingProxyType
from typing import Literal, Mapping, cast
from urllib.parse import urlsplit


# These identify the retained upstream provenance assets. They are not a
# runtime source-policy contract; source_registry.json is the runtime policy.
FIXED_UPSTREAM_REPOSITORY = "https://github.com/simonlin1212/investment-news"
FIXED_UPSTREAM_COMMIT = "d98aa603228f4839fb48859812c63a58ca10cead"
REGISTRY_SCHEMA_VERSION = 1

NewsScope = Literal["a_share", "global_industry"]
ArticleAccess = Literal["direct", "summary_only"]

_NEWS_SCOPES = frozenset({"a_share", "global_industry"})
_ARTICLE_ACCESS = frozenset({"direct", "summary_only"})


@dataclass(frozen=True)
class SourceAssignment:
    id: str
    track_id: str
    name: str
    url: str
    filters: tuple[str, ...]
    article_access: ArticleAccess = "direct"


@dataclass(frozen=True)
class FeedEndpoint:
    id: str
    url: str
    assignments: tuple[SourceAssignment, ...]


@dataclass(frozen=True)
class NewsCatalog:
    schema_version: int
    repository: str
    commit: str
    tracks: tuple[Mapping[str, str], ...]
    assignments: tuple[SourceAssignment, ...]
    filters: tuple[str, ...]
    scope: NewsScope = "a_share"


def load_catalog(scope: NewsScope = "a_share") -> NewsCatalog:
    """Load enabled source assignments for one approved news scope."""
    if scope not in _NEWS_SCOPES:
        raise ValueError("catalog scope is invalid")

    data = json.loads(files("src.news").joinpath("source_registry.json").read_text(encoding="utf-8"))
    _validate_registry(data)
    return _catalog_for_scope(cast(dict[str, object], data), scope)


def _catalog_for_scope(data: dict[str, object], scope: NewsScope) -> NewsCatalog:
    sources = cast(list[dict[str, object]], data["sources"])
    assignments = tuple(
        SourceAssignment(
            id=cast(str, item["id"]),
            track_id=cast(str, item["track_id"]),
            name=cast(str, item["name"]),
            url=cast(str, item["feed_url"]),
            filters=tuple(cast(list[str], item["filters"])),
            article_access=cast(ArticleAccess, item["article_access"]),
        )
        for item in sorted(
            (item for item in sources if item["scope"] == scope and item["enabled"]),
            key=lambda item: (cast(str, item["track_id"]), cast(int, item["priority"]), cast(str, item["id"])),
        )
    )
    tracks = cast(list[dict[str, str]], data["tracks"])
    return NewsCatalog(
        schema_version=cast(int, data["schema_version"]),
        repository=cast(str, data["repository"]),
        commit=cast(str, data["commit"]),
        tracks=tuple(MappingProxyType(dict(item)) for item in tracks),
        assignments=assignments,
        filters=tuple(cast(list[str], data["filters"])),
        scope=scope,
    )


def _validate_registry(data: object) -> None:
    if not isinstance(data, dict):
        raise ValueError("catalog registry must be an object")
    if data.get("schema_version") != REGISTRY_SCHEMA_VERSION:
        raise ValueError("catalog registry schema is invalid")
    if not isinstance(data.get("repository"), str) or not data["repository"]:
        raise ValueError("catalog registry repository is invalid")
    if not isinstance(data.get("commit"), str) or not data["commit"]:
        raise ValueError("catalog registry commit is invalid")

    track_ids = _validate_tracks(data.get("tracks"))
    filters = data.get("filters")
    if not isinstance(filters, list) or not all(isinstance(item, str) for item in filters):
        raise ValueError("catalog registry filters are invalid")

    sources = data.get("sources")
    if not isinstance(sources, list):
        raise ValueError("catalog registry sources are invalid")

    source_ids: set[str] = set()
    source_scopes: dict[str, str] = {}
    source_records: list[dict[str, object]] = []
    for source in sources:
        _validate_source(source, track_ids, source_ids)
        record = cast(dict[str, object], source)
        source_id = cast(str, record["id"])
        source_ids.add(source_id)
        source_scopes[source_id] = cast(str, record["scope"])
        source_records.append(record)

    for source in source_records:
        source_id = cast(str, source["id"])
        source_scope = cast(str, source["scope"])
        backups = cast(list[str], source["backup_source_ids"])
        if len(backups) != len(set(backups)) or source_id in backups:
            raise ValueError("catalog source backup ids are invalid")
        for backup_id in backups:
            if source_scopes.get(backup_id) != source_scope:
                raise ValueError("catalog source backup scope is invalid")


def _validate_tracks(tracks: object) -> set[str]:
    if not isinstance(tracks, list) or not tracks:
        raise ValueError("catalog registry tracks are invalid")
    track_ids: set[str] = set()
    for track in tracks:
        if not isinstance(track, dict):
            raise ValueError("catalog registry track is invalid")
        track_id = track.get("id")
        if not isinstance(track_id, str) or not track_id or track_id in track_ids:
            raise ValueError("catalog registry track id is invalid")
        if not isinstance(track.get("name"), str) or not track["name"]:
            raise ValueError("catalog registry track name is invalid")
        if not all(isinstance(value, str) for value in track.values()):
            raise ValueError("catalog registry track is invalid")
        track_ids.add(track_id)
    return track_ids


def _validate_source(source: object, track_ids: set[str], source_ids: set[str]) -> None:
    if not isinstance(source, dict):
        raise ValueError("catalog source is invalid")
    track_id = source.get("track_id")
    source_id = source.get("id")
    feed_url = source.get("feed_url")
    if not isinstance(track_id, str) or track_id not in track_ids:
        raise ValueError("catalog source track is invalid")
    if not isinstance(feed_url, str) or not _is_valid_feed_url(feed_url):
        raise ValueError("catalog source URL is invalid")
    expected_id = hashlib.sha256(f"{track_id}\0{feed_url}".encode("utf-8")).hexdigest()[:16]
    if source_id != expected_id or source_id in source_ids:
        raise ValueError("catalog source id is invalid")
    if not isinstance(source.get("name"), str) or not source["name"]:
        raise ValueError("catalog source name is invalid")

    scope = source.get("scope")
    if scope not in _NEWS_SCOPES:
        raise ValueError("catalog source scope is invalid")
    priority = source.get("priority")
    if not isinstance(priority, int) or isinstance(priority, bool) or priority < 1:
        raise ValueError("catalog source priority is invalid")
    article_access = source.get("article_access")
    if article_access not in _ARTICLE_ACCESS:
        raise ValueError("catalog source article access is invalid")
    reviewed = source.get("access_reviewed_for_cn")
    if not isinstance(reviewed, bool):
        raise ValueError("catalog source access review is invalid")
    if article_access == "direct" and not reviewed:
        raise ValueError("catalog source access review is required for direct sources")
    if not isinstance(source.get("enabled"), bool):
        raise ValueError("catalog source enabled flag is invalid")
    backups = source.get("backup_source_ids")
    if not isinstance(backups, list) or not all(isinstance(item, str) and item for item in backups):
        raise ValueError("catalog source backup ids are invalid")
    filters = source.get("filters")
    if not isinstance(filters, list) or not all(isinstance(item, str) for item in filters):
        raise ValueError("catalog source filters are invalid")


def _is_valid_feed_url(value: str) -> bool:
    if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value):
        return False
    if re.search(r"%(?![0-9A-Fa-f]{2})", value):
        return False
    try:
        parsed = urlsplit(value)
        parsed.port
    except (UnicodeError, ValueError):
        return False
    return (
        parsed.scheme in {"http", "https"}
        and parsed.hostname is not None
        and _is_public_hostname(parsed.hostname)
        and parsed.username is None
        and parsed.password is None
        and not parsed.fragment
    )


def _is_public_hostname(hostname: str) -> bool:
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        try:
            ascii_hostname = hostname.encode("idna").decode("ascii")
        except UnicodeError:
            return False
        normalized_hostname = ascii_hostname.lower()
        if (
            len(normalized_hostname) > 253
            or normalized_hostname.startswith(".")
            or normalized_hostname.endswith(".")
            or "." not in normalized_hostname
            or normalized_hostname.endswith((".localhost", ".local", ".localdomain", ".home.arpa", ".internal"))
        ):
            return False
        labels = normalized_hostname.split(".")
        return all(
            0 < len(label) <= 63
            and label[0] != "-"
            and label[-1] != "-"
            and all(character.isascii() and (character.isalnum() or character == "-") for character in label)
            for label in labels
        )
    return address.is_global and not address.is_multicast


def group_endpoints(catalog: NewsCatalog) -> tuple[FeedEndpoint, ...]:
    by_url: dict[str, list[SourceAssignment]] = {}
    for assignment in catalog.assignments:
        by_url.setdefault(assignment.url, []).append(assignment)
    return tuple(
        FeedEndpoint(
            id=hashlib.sha256(url.encode("utf-8")).hexdigest()[:16],
            url=url,
            assignments=tuple(sorted(assignments, key=lambda item: item.id)),
        )
        for url, assignments in sorted(by_url.items())
    )
