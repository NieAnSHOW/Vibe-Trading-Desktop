"""Regression tests for ``SPAStaticFiles`` API-vs-browser 404 fallback.

When the bundled agent is stale and missing an API route that the frontend
calls (e.g. ``/optional-deps/list``), the request falls through to the
``SPAStaticFiles`` catch-all mount in ``serve_main``. Before this fix it
returned ``index.html`` (HTML) for *every* 404, so the frontend's
``JSON.parse`` saw a leading ``<`` and surfaced an opaque
``Unrecognized token '<'`` error instead of a clear 404.

After the fix, API callers (``Accept: application/json`` / ``*/*``) get a
JSON 404; only browser navigation (``Accept: text/html``) falls back to the
SPA shell.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api_server import SPAStaticFiles, _accept_header


@pytest.fixture()
def spa_app(tmp_path):
    """Mount SPAStaticFiles over a throwaway dist so tests never touch the
    real frontend build or the global ``api_server.app``."""
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(
        "<!DOCTYPE html><html><body>SPA SHELL</body></html>"
    )
    (dist / "favicon.png").write_bytes(b"\x89PNG fake bytes")
    app = FastAPI()
    app.mount("/", SPAStaticFiles(directory=str(dist), html=True), name="frontend")
    return app


class TestSpaStaticFilesApiFallback:
    def test_unknown_api_path_returns_json_404_not_html(self, spa_app):
        """An API caller (Accept: application/json) hitting a missing route
        must get a JSON 404 — not the HTML SPA shell."""
        client = TestClient(spa_app)
        r = client.get("/optional-deps/list", headers={"Accept": "application/json"})
        assert r.status_code == 404
        assert r.headers["content-type"].startswith("application/json")
        assert r.json() == {"detail": "Not Found"}
        # Regression guard: the response must NOT start with '<' (HTML),
        # which is exactly what made JSON.parse throw "Unrecognized token '<'".
        assert not r.text.lstrip().startswith("<")

    def test_wildcard_accept_returns_json_404(self, spa_app):
        """Programmatic clients (e.g. fetch() default) send ``Accept: */*``;
        those are not browser navigation and must also get a JSON 404."""
        client = TestClient(spa_app)
        r = client.get("/some/missing/api", headers={"Accept": "*/*"})
        assert r.status_code == 404
        assert r.headers["content-type"].startswith("application/json")
        assert r.json() == {"detail": "Not Found"}

    def test_browser_navigation_falls_back_to_index_html(self, spa_app):
        """A browser deep-link refresh (Accept: text/html) to an unknown SPA
        route still gets the SPA shell — deep-link behavior unchanged."""
        client = TestClient(spa_app)
        r = client.get(
            "/some/deep/spa/route",
            headers={"Accept": "text/html,application/xhtml+xml"},
        )
        assert r.status_code == 200
        assert "text/html" in r.headers["content-type"]
        assert r.text.lstrip().startswith("<")

    def test_static_asset_still_served(self, spa_app):
        """Real static assets are unaffected — they match StaticFiles directly."""
        client = TestClient(spa_app)
        r = client.get("/favicon.png")
        assert r.status_code == 200

    def test_accept_header_helper(self):
        # ASGI header keys are always lowercased bytes.
        assert (
            _accept_header({"headers": [(b"accept", b"application/json")]})
            == "application/json"
        )
        assert _accept_header({"headers": [(b"host", b"x")]}) == ""
        assert _accept_header({"headers": []}) == ""
        assert _accept_header({}) == ""
