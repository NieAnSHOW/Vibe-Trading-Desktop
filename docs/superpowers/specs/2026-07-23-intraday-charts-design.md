# Intraday Charts Design

## Goal

Add an accurate, same-day one-minute intraday view below the existing daily
candlestick chart on the Indices and Watchlist pages. The feature is
read-only and must not affect trading, order, or mandate flows.

## Scope

- Add a read-only dashboard API for current-day one-minute price bars.
- Normalize intraday data to the existing `PriceBar` contract.
- Add a shared ECharts intraday chart with price and volume views.
- Load daily and intraday data independently for both pages.
- Provide isolated loading, empty, stale, and failure states for intraday
  data.
- Add focused backend, SDK, store, and page tests.

## Data Flow

`GET /dashboard/intraday-bars?symbol={symbol}` obtains the current trading
day's one-minute bars from the existing market-data capability and returns the
same response envelope as `GET /dashboard/daily-bars`:

```json
{
  "data": [{ "time": "2026-07-23T09:31:00+08:00", "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1 }],
  "as_of": "2026-07-23T10:00:00+08:00",
  "stale": false
}
```

The frontend API client and `stockSdk` expose this endpoint through a typed
`fetchDashboardIntradayBars` function. Both pages request daily and intraday
bars for the active symbol independently. Watchlist makes both requests when
the shared dashboard store changes its selected code; Indices owns equivalent
page-local state.

## Components And Layout

`IntradayChart` accepts `PriceBar[]` and displays:

- a price line with an `HH:mm` category axis;
- a synchronized volume bar panel below it;
- the existing responsive ECharts resize and disposal behavior.

The chart is rendered below the existing K-line block in both pages. It has a
bounded height around 300px and occupies the same detail-column width as the
daily chart. The pages retain their current daily-chart behavior and show
intraday loading, empty, stale, and failure states only within the new block.

## Failure Handling

- An intraday request failure does not clear, hide, or change daily bars.
- An empty intraday result renders an explicit no-data state.
- A stale response remains renderable and receives the same stale indicator
  convention used by the daily view.
- Changing the selected symbol invalidates prior request results so late
  responses cannot replace the active symbol's chart.

## Tests

- Backend route tests cover normalized successful output, invalid or missing
  intraday data, and provider failure behavior.
- SDK tests assert the intraday endpoint request and response adaptation.
- Store tests assert that selecting a symbol loads daily and intraday data
  independently.
- Indices and Watchlist tests assert the new intraday section receives its
  data and preserves the daily chart when intraday data is unavailable.

## Non-Goals

- Multiple intraday intervals, historical intraday date selection, indicators,
  or live streaming updates.
- Any broker, order, mandate, or live-trading changes.
