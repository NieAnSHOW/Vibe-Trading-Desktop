from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from src.news import catalog
from src.news.catalog import FIXED_UPSTREAM_COMMIT, FIXED_UPSTREAM_REPOSITORY, group_endpoints, load_catalog


ROOT = Path(__file__).resolve().parents[3]
NEWS_DIR = ROOT / "agent" / "src" / "news"
IMPORTER = ROOT / "scripts" / "news" / "import_upstream.py"
GOLDEN_MANIFEST_SHA256 = "5471c28bd8ad6fe13af7a6d335073fb8dad90ddb316269e092071412c9d8d3f6"
STATIC_ARTIFACTS = (
    "upstream_manifest.json",
    "upstream_manifest.sha256",
    "THIRD_PARTY_NOTICES.md",
)


def _canonical_manifest_bytes(value: bytes) -> bytes:
    return value.replace(b"\r\n", b"\n")


def valid_registry(
    *,
    scope: str = "a_share",
    article_access: str = "direct",
    access_reviewed_for_cn: bool = True,
) -> dict[str, object]:
    return {
        "schema_version": 1,
        "repository": FIXED_UPSTREAM_REPOSITORY,
        "commit": FIXED_UPSTREAM_COMMIT,
        "tracks": [{"id": "macro", "name": "Macro", "accent": "#000000"}],
        "filters": [],
        "sources": [
            {
                "id": hashlib.sha256(b"macro\0https://feeds.example/market.xml").hexdigest()[:16],
                "track_id": "macro",
                "name": "Reviewed source",
                "feed_url": "https://feeds.example/market.xml",
                "scope": scope,
                "priority": 1,
                "article_access": article_access,
                "access_reviewed_for_cn": access_reviewed_for_cn,
                "backup_source_ids": [],
                "enabled": True,
                "filters": [],
            }
        ],
    }


def write_registry(tmp_path: Path, registry: dict[str, object]) -> None:
    (tmp_path / "source_registry.json").write_text(
        json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def test_a_share_catalog_exposes_only_reviewed_domestic_sources() -> None:
    loaded = load_catalog("a_share")

    assert loaded.scope == "a_share"
    assert {item.name for item in loaded.assignments} == {
        "东方财富股票",
        "东方财富资讯",
        "华尔街见闻",
        "经济观察网",
        "36氪",
        "钛媒体",
        "IT之家",
        "虎嗅",
        "动点科技",
        "量子位",
        "智东西",
        "国际能源网",
        "CnEVPost",
    }
    assert all(item.article_access == "direct" for item in loaded.assignments)


def test_catalog_scope_isolated_and_endpoint_grouping_is_deterministic() -> None:
    a_share = load_catalog("a_share")
    global_industry = load_catalog("global_industry")
    endpoints = group_endpoints(a_share)

    assert {item.id for item in a_share.assignments}.isdisjoint(item.id for item in global_industry.assignments)
    assert tuple(item.url for item in endpoints) == tuple(sorted(item.url for item in endpoints))
    assert all(item.article_access == "summary_only" for item in global_industry.assignments)
    assert all(assignment in a_share.assignments for endpoint in endpoints for assignment in endpoint.assignments)


def test_registry_rejects_direct_source_without_cn_access_review(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    registry = valid_registry(scope="a_share", article_access="direct", access_reviewed_for_cn=False)
    write_registry(tmp_path, registry)
    monkeypatch.setattr(catalog, "files", lambda _: tmp_path)

    with pytest.raises(ValueError, match="access review"):
        load_catalog("a_share")


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda source: source.update(id="not-a-stable-id"), "id"),
        (lambda source: source.update(scope="unknown"), "scope"),
        (lambda source: source.update(article_access="external"), "article access"),
        (lambda source: source.update(enabled="yes"), "enabled"),
        (lambda source: source.update(feed_url="file:///etc/passwd"), "URL"),
        (lambda source: source.update(backup_source_ids=["outside-scope"]), "backup"),
    ],
)
def test_registry_fails_closed_for_unsafe_source_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutate: object, message: str
) -> None:
    registry = valid_registry()
    sources = registry["sources"]
    assert isinstance(sources, list)
    source = sources[0]
    assert isinstance(source, dict)
    assert callable(mutate)
    mutate(source)
    write_registry(tmp_path, registry)
    monkeypatch.setattr(catalog, "files", lambda _: tmp_path)

    with pytest.raises(ValueError, match=message):
        load_catalog("a_share")


def test_provenance_manifest_hash_and_mit_notice_are_pinned() -> None:
    manifest = NEWS_DIR / "upstream_manifest.json"
    digest = NEWS_DIR / "upstream_manifest.sha256"
    notice = NEWS_DIR / "THIRD_PARTY_NOTICES.md"

    assert hashlib.sha256(_canonical_manifest_bytes(manifest.read_bytes())).hexdigest() == GOLDEN_MANIFEST_SHA256
    assert digest.read_text(encoding="utf-8").strip() == GOLDEN_MANIFEST_SHA256
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    assert payload["repository"] == FIXED_UPSTREAM_REPOSITORY
    assert payload["commit"] == FIXED_UPSTREAM_COMMIT
    assert "MIT License" in notice.read_text(encoding="utf-8")
    assert "Copyright (c) 2026 simonlin1212" in notice.read_text(encoding="utf-8")


def _assert_generated_artifacts_match_tracked(output_dir: Path) -> None:
    assert tuple(sorted(path.name for path in output_dir.iterdir() if path.is_file())) == tuple(sorted(STATIC_ARTIFACTS))
    for artifact in STATIC_ARTIFACTS:
        assert (output_dir / artifact).read_bytes() == (NEWS_DIR / artifact).read_bytes()


def test_importer_reads_git_objects_not_dirty_worktree(tmp_path: Path) -> None:
    repository = tmp_path / "upstream"
    subprocess.run(["git", "clone", "-q", FIXED_UPSTREAM_REPOSITORY, str(repository)], check=True)
    subprocess.run(["git", "-C", str(repository), "checkout", "-q", FIXED_UPSTREAM_COMMIT], check=True)
    subprocess.run(["git", "-C", str(repository), "config", "user.email", "tests@example.invalid"], check=True)
    subprocess.run(["git", "-C", str(repository), "config", "user.name", "Tests"], check=True)
    source_path = repository / "sources.json"
    source_path.write_text(source_path.read_text(encoding="utf-8").replace("OpenAI", "Replaced source", 1), encoding="utf-8")
    subprocess.run(["git", "-C", str(repository), "add", "sources.json"], check=True)
    subprocess.run(["git", "-C", str(repository), "commit", "-qm", "replacement"], check=True)
    subprocess.run(["git", "-C", str(repository), "replace", FIXED_UPSTREAM_COMMIT, "HEAD"], check=True)
    (repository / "sources.json").write_text("{}", encoding="utf-8")
    output = tmp_path / "output"

    result = subprocess.run(
        [
            sys.executable,
            str(IMPORTER),
            "--repository",
            str(repository),
            "--commit",
            FIXED_UPSTREAM_COMMIT,
            "--output-dir",
            str(output),
        ],
        text=True,
        capture_output=True,
    )

    assert result.returncode == 0, result.stderr
    _assert_generated_artifacts_match_tracked(output)


def test_importer_rejects_any_commit_other_than_the_fixed_pin(tmp_path: Path) -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(IMPORTER),
            "--repository",
            str(tmp_path),
            "--commit",
            "0" * 40,
            "--output-dir",
            str(tmp_path / "output"),
        ],
        text=True,
        capture_output=True,
    )

    assert result.returncode != 0
    assert "fixed" in result.stderr.lower()
