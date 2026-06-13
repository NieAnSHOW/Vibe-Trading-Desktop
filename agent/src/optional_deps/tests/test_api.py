"""Tests for the optional_deps FastAPI router."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.optional_deps import api as optional_api


@pytest.fixture()
def isolated_env(tmp_path, monkeypatch):
    """Point all paths at tmp_path so tests never touch the real home."""
    libs = tmp_path / "libs"
    libs.mkdir()
    mirror_path = tmp_path / "mirror.json"
    monkeypatch.setattr(
        "src.optional_deps.api._libs_dir",
        lambda: libs,
    )
    monkeypatch.setattr(
        "src.optional_deps.mirror.default_config_path",
        lambda: mirror_path,
    )
    monkeypatch.setattr(
        "src.optional_deps.api._registry_entries",
        lambda: optional_api._load_entries(),
    )
    return libs


@pytest.fixture()
def client(isolated_env):
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(optional_api.router)
    return TestClient(app)


def test_list_returns_registry_with_not_installed(client):
    resp = client.get("/optional-deps/list")
    assert resp.status_code == 200
    body = resp.json()
    pkgs = {b["package"]: b for b in body["brokers"]}
    assert "futu-api" in pkgs
    assert pkgs["futu-api"]["installed"] is False


def test_list_marks_installed_when_dist_info_present(client, isolated_env):
    d = isolated_env / "futu_api.dist-info"
    d.mkdir()
    (d / "METADATA").write_text("Name: futu_api\n", encoding="utf-8")

    resp = client.get("/optional-deps/list")
    pkgs = {b["package"]: b for b in resp.json()["brokers"]}
    assert pkgs["futu-api"]["installed"] is True


def test_install_rejects_unknown_package(client):
    resp = client.post(
        "/optional-deps/install", json={"package": "evil-pkg"}
    )
    assert resp.status_code == 400
    assert "not in registry" in resp.json()["detail"].lower()


def test_mirror_get_returns_default(client):
    resp = client.get("/optional-deps/mirror")
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "tsinghua"


def test_mirror_put_persists_selection(client):
    resp = client.put(
        "/optional-deps/mirror",
        json={"name": "aliyun", "custom_index_url": ""},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "aliyun"

    # Second GET reflects the persisted value.
    assert client.get("/optional-deps/mirror").json()["name"] == "aliyun"
