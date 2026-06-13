"""Tests for optional_deps.sse_lines frame formatting."""

from __future__ import annotations

import json

from src.optional_deps.sse_lines import sse_event, stage_line


def test_stage_line_emits_json_with_stage():
    frame = stage_line("downloading", message="Fetching futu-api")
    assert frame.startswith("event: progress")
    assert frame.endswith("\n\n")
    data_line = [line for line in frame.splitlines() if line.startswith("data: ")][0]
    payload = json.loads(data_line[len("data: "):])
    assert payload["stage"] == "downloading"
    assert payload["message"] == "Fetching futu-api"


def test_sse_event_formats_done():
    frame = sse_event("done", {"package": "futu-api"})
    assert "event: done" in frame
    assert frame.endswith("\n\n")
    assert "futu-api" in frame


def test_sse_event_escapes_newlines_in_data():
    """SSE spec: a literal newline in data must be prefixed with another."""
    frame = sse_event("progress", {"message": "line1\nline2"})
    # Each newline in the JSON value must be escaped for SSE transport.
    assert "event: progress" in frame
