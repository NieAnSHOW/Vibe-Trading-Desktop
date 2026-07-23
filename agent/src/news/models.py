"""Validated public and persisted models for the investment-news snapshot."""

from __future__ import annotations

from datetime import datetime, timezone
import re
from typing import Annotated, Literal
from urllib.parse import unquote_plus, urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


CANONICAL_TRACK_IDS = (
    "ai",
    "semi",
    "robot",
    "auto",
    "energy",
    "bio",
    "space",
    "security",
    "tech",
    "consumer",
    "macro",
    "science",
)
_SENSITIVE_PARAMETER_NAMES = frozenset(
    {
        "access_token",
        "api_key",
        "apikey",
        "authorization",
        "credential",
        "credentials",
        "key",
        "password",
        "secret",
        "sig",
        "signature",
        "token",
    }
)
_PUBLIC_ERROR_MESSAGES = {
    "ai_unavailable": "AI highlights are unavailable",
    "cancelled": "news refresh was cancelled",
    "no_track_updated": "no news tracks were updated",
    "snapshot_corrupt": "news snapshot is corrupt",
    "snapshot_unavailable": "news snapshot is unavailable",
    "snapshot_write_failed": "news snapshot could not be saved",
    "upstream_failed": "news refresh failed",
}
_SENSITIVE_URL_VALUE_PATTERN = re.compile(
    r"(?:\bbearer\s+\S+|\bsk-[a-z0-9_-]{4,}\b"
    r"|\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b"
    r"|\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b"
    r"|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[a-z0-9-]{10,}\b"
    r"|\b(?=[A-Za-z0-9/+=]{40}\b)(?=[A-Za-z0-9/+=]{0,39}[A-Z])(?=[A-Za-z0-9/+=]{0,39}[a-z])"
    r"(?=[A-Za-z0-9/+=]{0,39}\d)[A-Za-z0-9/+=]{40}\b"
    r"|\bsecret_[a-z0-9_-]{16,}\b|\b(?:secret|private)[-_ ]?(?:token|key|value)\b)",
    re.IGNORECASE,
)


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _validate_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() != timezone.utc.utcoffset(value):
        raise ValueError("datetime must be UTC aware")
    return value


def _is_sensitive_parameter(name: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "_", name.lower()).strip("_")
    return normalized in _SENSITIVE_PARAMETER_NAMES or normalized.endswith("_signature") or bool(
        {"authorization", "credential", "key", "password", "secret", "token"}.intersection(normalized.split("_"))
    )


def _validate_public_http_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise ValueError("URL must be a public HTTP(S) URL") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError("URL must be a public HTTP(S) URL")
    for component in (parsed.query, parsed.fragment):
        for segment in re.split(r"[&;]", unquote_plus(component)):
            name, separator, parameter_value = segment.partition("=")
            if name and _is_sensitive_parameter(name):
                raise ValueError("URL must not contain credential parameters")
            if separator and _SENSITIVE_URL_VALUE_PATTERN.search(parameter_value):
                raise ValueError("URL must not contain credential values")
    return value


class FeedSource(_StrictModel):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=200)


class FeedItem(_StrictModel):
    id: str = Field(min_length=1, max_length=128)
    track_id: Literal[
        "ai", "semi", "robot", "auto", "energy", "bio", "space", "security", "tech", "consumer", "macro", "science"
    ]
    title: str = Field(min_length=1, max_length=300)
    title_zh: str | None = Field(default=None, min_length=1, max_length=300)
    summary: str | None = Field(default=None, max_length=1000)
    source: FeedSource
    published_at: datetime | None = None
    url: str = Field(min_length=1, max_length=2048)
    article_access: Literal["direct", "summary_only"]
    first_seen_at: datetime

    @field_validator("published_at", "first_seen_at")
    @classmethod
    def timestamps_are_utc(cls, value: datetime | None) -> datetime | None:
        return _validate_utc(value) if value is not None else value

    @field_validator("url")
    @classmethod
    def url_is_public(cls, value: str) -> str:
        return _validate_public_http_url(value)


class PublicError(_StrictModel):
    code: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    message: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def message_is_canonical(self) -> "PublicError":
        if _PUBLIC_ERROR_MESSAGES.get(self.code) != self.message:
            raise ValueError("public error message must match its stable public code")
        return self


class TrackAi(_StrictModel):
    available: bool = False
    generated_at: datetime | None = None
    highlights: list[Annotated[str, Field(min_length=1, max_length=300)]] = Field(default_factory=list, max_length=5)
    error: PublicError | None = None

    @field_validator("generated_at")
    @classmethod
    def generated_at_is_utc(cls, value: datetime | None) -> datetime | None:
        return _validate_utc(value) if value is not None else value

    @model_validator(mode="after")
    def validate_availability(self) -> "TrackAi":
        if self.available:
            if self.generated_at is None or not 3 <= len(self.highlights) <= 5 or self.error is not None:
                raise ValueError("available AI requires generation time and three to five highlights")
        elif self.generated_at is not None or self.highlights:
            raise ValueError("unavailable AI requires no generation or highlights")
        return self


class SourceStats(_StrictModel):
    endpoint_total: int = Field(ge=0)
    endpoint_success_count: int = Field(ge=0)
    endpoint_failure_count: int = Field(ge=0)
    assignment_total: int = Field(ge=0)
    assignment_success_count: int = Field(ge=0)
    assignment_failure_count: int = Field(ge=0)

    @classmethod
    def empty(cls) -> "SourceStats":
        return cls(
            endpoint_total=0,
            endpoint_success_count=0,
            endpoint_failure_count=0,
            assignment_total=0,
            assignment_success_count=0,
            assignment_failure_count=0,
        )

    @model_validator(mode="after")
    def validate_totals(self) -> "SourceStats":
        if self.endpoint_success_count + self.endpoint_failure_count > self.endpoint_total:
            raise ValueError("endpoint counts exceed the endpoint catalog")
        if self.assignment_success_count + self.assignment_failure_count > self.assignment_total:
            raise ValueError("assignment counts exceed the assignment catalog")
        return self


class SourceOutcome(_StrictModel):
    source_id: str = Field(min_length=1, max_length=128)
    source_name: str = Field(min_length=1, max_length=200)
    state: Literal["success", "failed", "skipped_circuit_open", "disabled"]
    reason: Literal["http_status", "network_error", "timeout", "rate_limited", "circuit_open", "disabled"] | None
    last_success_at: datetime | None

    @field_validator("last_success_at")
    @classmethod
    def last_success_at_is_utc(cls, value: datetime | None) -> datetime | None:
        return _validate_utc(value) if value is not None else value

    @model_validator(mode="after")
    def validate_state_reason(self) -> "SourceOutcome":
        if self.state == "success" and self.reason is None:
            return self
        if self.state == "failed" and self.reason in {"http_status", "network_error", "timeout", "rate_limited"}:
            return self
        if self.state == "skipped_circuit_open" and self.reason == "circuit_open":
            return self
        if self.state == "disabled" and self.reason == "disabled":
            return self
        raise ValueError("source outcome state does not match its reason")


class TrackSnapshot(_StrictModel):
    track_id: Literal[
        "ai", "semi", "robot", "auto", "energy", "bio", "space", "security", "tech", "consumer", "macro", "science"
    ]
    state: Literal["fresh", "stale", "unavailable"]
    generated_at: datetime | None = None
    stale: bool = False
    partial: bool = False
    items: list[FeedItem] = Field(default_factory=list, max_length=100)
    ai: TrackAi
    source_stats: SourceStats
    source_outcomes: list[SourceOutcome] = Field(default_factory=list, max_length=200)

    @field_validator("generated_at")
    @classmethod
    def generated_at_is_utc(cls, value: datetime | None) -> datetime | None:
        return _validate_utc(value) if value is not None else value

    @model_validator(mode="after")
    def validate_state(self) -> "TrackSnapshot":
        if any(item.track_id != self.track_id for item in self.items):
            raise ValueError("track items must match the track id")
        has_source_failure = self.source_stats.endpoint_failure_count > 0 or self.source_stats.assignment_failure_count > 0
        if self.state == "fresh" and self.generated_at is not None and not self.stale and self.partial == has_source_failure:
            return self
        if self.state == "stale" and self.generated_at is not None and self.stale and not self.partial:
            return self
        if (
            self.state == "unavailable"
            and self.generated_at is None
            and not self.stale
            and not self.partial
            and not self.items
            and not self.ai.available
        ):
            return self
        raise ValueError("track state does not match generated_at, stale, partial, items, and AI availability")


class NewsSnapshot(_StrictModel):
    schema_version: Literal[2]
    scope: Literal["a_share", "global_industry"]
    generated_at: datetime
    upstream_commit: str = Field(min_length=1, max_length=128)
    source_stats: SourceStats
    errors: list[PublicError] = Field(default_factory=list, max_length=200)
    tracks: list[TrackSnapshot] = Field(min_length=len(CANONICAL_TRACK_IDS), max_length=len(CANONICAL_TRACK_IDS))

    @field_validator("generated_at")
    @classmethod
    def generated_at_is_utc(cls, value: datetime) -> datetime:
        return _validate_utc(value)

    @model_validator(mode="after")
    def validate_tracks(self) -> "NewsSnapshot":
        if tuple(track.track_id for track in self.tracks) != CANONICAL_TRACK_IDS:
            raise ValueError("tracks must be the canonical IDs in canonical order")
        if not any(track.source_outcomes for track in self.tracks):
            return self
        from .catalog import load_catalog

        assignments = {(source.track_id, source.id): source for source in load_catalog(self.scope).assignments}
        for track in self.tracks:
            outcome_ids: set[str] = set()
            for outcome in track.source_outcomes:
                source = assignments.get((track.track_id, outcome.source_id))
                if source is None or source.name != outcome.source_name or outcome.source_id in outcome_ids:
                    raise ValueError("source outcomes must match configured track assignments")
                outcome_ids.add(outcome.source_id)
        return self


class RefreshStatus(_StrictModel):
    state: Literal["idle", "fetching", "normalizing", "enriching", "committing", "succeeded", "failed", "cancelled"]
    scope: Literal["a_share", "global_industry"]
    task_id: UUID | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    processed_endpoints: int = Field(default=0, ge=0)
    successful_endpoints: int = Field(default=0, ge=0)
    failed_endpoints: int = Field(default=0, ge=0)
    processed_tracks: int = Field(default=0, ge=0)
    total_endpoints: int = Field(default=0, ge=0)
    total_tracks: int = Field(default=len(CANONICAL_TRACK_IDS), ge=0)
    error: PublicError | None = None

    @field_validator("started_at", "completed_at")
    @classmethod
    def timestamps_are_utc(cls, value: datetime | None) -> datetime | None:
        return _validate_utc(value) if value is not None else value


class SnapshotResponse(_StrictModel):
    available: bool
    stale: bool
    snapshot: NewsSnapshot | None
    refresh: RefreshStatus
    error: PublicError | None = None

    @model_validator(mode="after")
    def validate_availability(self) -> "SnapshotResponse":
        if self.available != (self.snapshot is not None):
            raise ValueError("available must agree with snapshot")
        if not self.available and self.stale:
            raise ValueError("unavailable snapshot cannot be stale")
        return self


class RefreshAcceptedResponse(_StrictModel):
    task_id: UUID
    reused: bool
    status: RefreshStatus
