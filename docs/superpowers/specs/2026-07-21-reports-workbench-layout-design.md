# Reports Workbench Layout Design

## Goal

Make the Reports page visually consistent with the Indices workspace while preserving all report data, filtering, sorting, refresh, telemetry, and navigation behavior.

## Layout

The page will use the same compact, full-width workspace structure as Indices:

1. A compact heading with the existing title, description, and refresh action.
2. Four read-only overview cards for total reports, successful reports, average return, and average Sharpe ratio. Values are derived only from the already-loaded report runs.
3. A responsive main work area. On large screens, a left filter panel and a right results panel sit side by side. On smaller screens, the panels stack vertically.

The filter panel contains the existing search, status, start date, end date, and sort controls. It also provides a local clear-filters control when a filter produces no matches.

The results panel retains every report row's status, run ID, date, prompt, codes, period, metrics, Full Report link, and Compare link. Loading, error, empty-library, and no-match states render inside this panel.

## Visual Language

Panels and overview cards use the Indices page's compact spacing and shared treatment: `rounded-lg border bg-card`, `gap-3`, a `text-xl` page title, tabular numeric values, and visible keyboard focus rings. The outer page uses the layout-controlled scroll area with `h-full min-h-0` rather than a separate viewport-height page.

## Behavior Invariants

- Continue calling `api.listRuns(100)` and emitting the existing telemetry event.
- Continue showing only runs with a finite total return or Sharpe ratio.
- Preserve default newest-first sorting and every existing filtering and sorting semantic.
- Preserve the existing run detail and comparison routes.
- Do not add API requests, persisted UI state, translations, or report fields.

## Verification

Update focused Reports tests for the new layout's derived overview and clear-filter behavior while retaining coverage for filtering, report-only selection, ordering, and links. Run the focused test and the frontend production build.
