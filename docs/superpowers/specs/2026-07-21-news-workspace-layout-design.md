# News Workspace Layout Design

## Goal

Reorganize `frontend/src/pages/News.tsx` into the same operational workspace pattern used by the Indices page. The page should make switching among fixed news tracks fast on desktop while preserving a compact, usable mobile layout.

## Layout

Desktop uses a two-column grid matching the Indices page's spacing and card treatment:

- The left column is a bounded track navigator. It contains the page title, latest snapshot timestamp, refresh action, and all twelve tracks. The active track is visually distinct. Each track also exposes a concise availability state when that state is known.
- The right column is the selected-track detail surface. Its header presents the selected track name and freshness, stale, unavailable, or partial state. It then shows AI highlights followed by the article list.
- The detail surface owns its vertical overflow at large breakpoints so a long article feed does not move the navigator out of view.

On small screens, the page becomes a single column. The existing select control remains the track picker, and the detail content follows it. No horizontal tab scroller is retained.

## Behavior and Accessibility

- Keep the existing `useNews` data contract, refresh operation, loading, empty, error, stale, unavailable, and partial states unchanged.
- Keep valid external article links and localized date formatting unchanged.
- Retain a semantic tablist for desktop track navigation with current roving-keyboard behavior. The mobile select remains labelled and functional.
- Preserve existing test identifiers and semantic labels where possible so page-level test coverage continues to validate the contracts.

## Visual Rules

- Follow the Indices page's `p-3` / `lg:p-5`, `gap-3`, `rounded-lg border bg-card`, and large-screen two-column grid conventions.
- Use compact labels and status indicators rather than decorative panels. The selected track detail is the only primary reading surface.
- Keep article title wrapping and minimum-width guards so unbroken source headlines cannot cause horizontal overflow.

## Testing

- Update layout assertions for the desktop two-column workspace and responsive mobile selector.
- Run the News page test suites and the frontend production build after implementation.

## Non-goals

- No API, refresh-scheduling, i18n, or news-content changes.
- No new search, filtering, or track-management controls.
