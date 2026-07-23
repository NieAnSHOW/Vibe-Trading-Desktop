# Chart Panel Fill Design

## Goal

Make the daily K-line and intraday chart areas fill the available detail panel
height on Indices and Watchlist while retaining usable narrow-screen layouts.

## Layout

On large screens, each selected detail view becomes a vertical flex container.
After its header, the daily and intraday sections share the remaining height
equally. Each section has a minimum height and its chart stretches to the
section's available height. Loading, empty, error, and stale states use the
same bounded section height as a populated chart.

On narrow screens, the sections retain normal document flow and fixed chart
heights, so the page can scroll without compressing chart axes or controls.

## Scope

- Update only the selected detail layouts in `Indices.tsx` and `Watchlist.tsx`.
- Preserve existing data fetching, chart options, and error semantics.
- Add focused assertions for the large-screen flex layout and chart sizing.

## Non-Goals

- Changing chart data, provider behavior, or chart indicators.
- Altering the list/sidebar layout or mobile navigation.
