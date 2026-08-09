"""Regression tests for factor-analysis artifact paths in Swarm workers."""

from __future__ import annotations

import json

import pandas as pd

from src.tools.factor_analysis_tool import FactorAnalysisTool


def test_factor_analysis_resolves_relative_paths_from_worker_run_dir(tmp_path, monkeypatch) -> None:
    """Factor inputs and outputs share the worker artifact directory."""
    run_dir = tmp_path / "worker-artifacts"
    input_dir = run_dir / "factor_output"
    input_dir.mkdir(parents=True)
    monkeypatch.setenv("VIBE_TRADING_ALLOWED_RUN_ROOTS", str(tmp_path))

    dates = pd.date_range("2026-01-01", periods=3)
    values = pd.DataFrame(
        [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [3, 4, 5, 6, 7]],
        index=dates,
        columns=["A", "B", "C", "D", "E"],
    )
    values.to_csv(input_dir / "factor.csv")
    values.pct_change().fillna(0).to_csv(input_dir / "returns.csv")

    result = json.loads(
        FactorAnalysisTool().execute(
            factor_csv="factor_output/factor.csv",
            return_csv="factor_output/returns.csv",
            output_dir="factor_output/analysis",
            run_dir=str(run_dir),
        )
    )

    assert result["status"] == "ok"
    assert (run_dir / "factor_output" / "analysis" / "ic_summary.json").exists()


def test_factor_analysis_rejects_paths_outside_allowed_roots(tmp_path, monkeypatch) -> None:
    """Direct tool calls cannot bypass file roots by omitting run_dir."""
    allowed = tmp_path / "allowed"
    outside = tmp_path / "outside"
    allowed.mkdir()
    outside.mkdir()
    monkeypatch.setenv("VIBE_TRADING_ALLOWED_FILE_ROOTS", str(allowed))
    monkeypatch.setenv("VIBE_TRADING_ALLOWED_WRITE_ROOTS", str(allowed))

    values = pd.DataFrame([[1, 2, 3, 4, 5]], columns=list("ABCDE"))
    values.to_csv(outside / "factor.csv")
    values.to_csv(outside / "returns.csv")

    result = json.loads(
        FactorAnalysisTool().execute(
            factor_csv=str(outside / "factor.csv"),
            return_csv=str(outside / "returns.csv"),
            output_dir=str(outside / "analysis"),
        )
    )

    assert result["status"] == "error"
    assert "allowed read roots" in result["error"] or "allowed write roots" in result["error"]
