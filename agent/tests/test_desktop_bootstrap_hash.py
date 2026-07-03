"""requirements hash marker —— 增量同步判定(设计 D5,照搬 .installed_version)。"""
from pathlib import Path
from src.desktop_bootstrap.requirements_hash import (
    compute_hash, read_marker, write_marker, needs_sync,
)

def test_compute_hash_is_stable_and_content_sensitive(tmp_path):
    req = tmp_path / "requirements.txt"
    req.write_text("numpy>=1.24.0\npandas>=2.0.0\n", encoding="utf-8")
    h1 = compute_hash(req)
    h2 = compute_hash(req)
    assert h1 == h2 and len(h1) == 64  # sha256 hex
    req.write_text("numpy>=1.24.0\npandas>=2.0.0\nscipy>=1.10\n", encoding="utf-8")
    assert compute_hash(req) != h1

def test_needs_sync_true_when_marker_absent(tmp_path):
    req = tmp_path / "requirements.txt"
    req.write_text("numpy\n", encoding="utf-8")
    marker = tmp_path / ".requirements_hash"
    assert needs_sync(req, marker) is True

def test_needs_sync_false_when_hash_matches(tmp_path):
    req = tmp_path / "requirements.txt"
    req.write_text("numpy\n", encoding="utf-8")
    marker = tmp_path / ".requirements_hash"
    write_marker(marker, compute_hash(req))
    assert needs_sync(req, marker) is False

def test_needs_sync_true_when_requirements_changed(tmp_path):
    req = tmp_path / "requirements.txt"
    req.write_text("numpy\n", encoding="utf-8")
    marker = tmp_path / ".requirements_hash"
    write_marker(marker, compute_hash(req))
    req.write_text("numpy\nscipy\n", encoding="utf-8")
    assert needs_sync(req, marker) is True
    assert read_marker(marker) is not None
