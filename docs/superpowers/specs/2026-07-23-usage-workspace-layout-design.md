# Usage Workspace Layout Design

## Goal

Align the LLM usage page with the compact, desktop-first workspace pattern used by the indices page while preserving all usage data behavior.

## Layout

- Use a full-height page with the existing compact page padding and gap scale.
- Keep the title, last-updated timestamp, and refresh control in the page header.
- Present the usage totals as small summary cards below the header.
- On large screens, render a bounded two-column workspace: a navigator on the left and details on the right. Stack the surfaces on smaller screens.
- The navigator contains the time-range controls, optional custom dates, search, pagination, and session rows.
- Selecting a session updates the detail surface. The detail surface shows the selected session's summary and runs, plus the trend and provider/model charts. When nothing is selected, show a compact prompt.

## Behavior

- Keep the existing API request shape, date range semantics, search submission, pagination, retry handling, loading states, and translated strings.
- Preserve the partial-data warning and make it visible above the workspace.
- Continue to avoid exposing stored prompts or model responses.
- Preserve accessible labels and selected/expanded state semantics; the existing expanded-session state becomes the selected-session state.

## Validation

- Update the Usage page tests for the workspace structure only where needed, while retaining interaction coverage.
- Run the Usage test suite and the frontend production build.
