# Alpha, Correlation, and Settings Workspace Layout Design

## Goal

Bring the Alpha Zoo, Correlation, and Settings pages into the compact, operational workspace language used by Indices and News. The change is presentation-only: no API calls, state transitions, routes, form payloads, translations, or interaction semantics change.

## Shared Layout Rules

- Use the existing `rounded-lg border bg-card` surfaces, compact `p-3`/`p-5` spacing, and restrained headings from the Indices workspace.
- Desktop workspaces use a fixed header followed by a `min-h-0` content grid so dense content can own the remaining viewport height without pushing below the fold.
- At widths below `lg`, every grid collapses to one column. Controls remain readable and retain their existing labels, IDs, event handlers, and disabled states.
- Do not add client-side filtering, persistence, API fields, navigation, or new translations.

## Alpha Zoo

### Browse

- Convert the broad hero to a compact workspace header that keeps title, count/loading text, and browse description.
- Keep the zoo cards as a concise, responsive overview strip. They remain the existing filter buttons with the same selection behavior.
- On desktop, place the search and three existing selects in a persistent left filter surface and the alpha catalogue in the larger right content surface. The Compare and Run Benchmark links remain available in the filter surface.
- On mobile, show the overview, filters, and table in one vertical flow. The table continues to scroll horizontally when needed.

### Detail, Bench, and Compare

- Align outer spacing, heading scale, panels, and action placement with the browse workspace without changing links, forms, result rendering, or EventSource behavior.
- Keep all existing route-specific content and error/loading states intact.

## Correlation

- Use a compact header and a two-column desktop analysis workspace: the existing asset-code input, window choices, method choices, and compute action occupy the parameter surface; the correlation matrix occupies the larger result surface.
- Preserve the current field values, request construction, request timing, loading state, and error behavior.
- Before a result exists, the result surface provides a quiet empty state rather than changing request behavior. Mobile returns to a vertical control-then-result layout.

## Settings

- Retain the current component order and behavior while grouping page-level sections into a responsive desktop grid.
- The LLM and data-source configuration form remains the primary wide surface. Runtime status, QVeris, telemetry consent, and channel status use the secondary column or full-width space according to their natural content width.
- The channels table stays full-width to preserve readable operational status. No form fields, button handlers, authentication redirects, QR flow, or save calls move or change semantics.

## Accessibility and Verification

- Preserve semantic headings, forms, labels, ARIA attributes, table markup, button names, and keyboard behavior.
- Add focused layout tests only where stable structural assertions are practical; retain existing behavior tests.
- Verify TypeScript/Vite production build and focused page test suites. Inspect desktop and mobile browser renders against the workspace rules.
