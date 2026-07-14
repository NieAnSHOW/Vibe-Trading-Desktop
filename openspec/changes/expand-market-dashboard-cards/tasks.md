## 1. Market Snapshot Data

- [x] 1.1 Define market-snapshot DTOs in the `stockSdk` adapter and implement normalized full-market breadth, emotion, trend, limit-up ladder, and concept-heat data with a 60-second cache.
- [x] 1.2 Add mock-SDK tests for market-snapshot calculations, cache reuse, and stale fallback when a single upstream fails.

## 2. Dashboard State and UI

- [x] 2.1 Extend the market-dashboard Zustand store so the added snapshot area has independent loading, error, and last-successful-data state and participates in existing visibility polling.
- [ ] 2.2 Implement responsive breadth, emotion radar, trend, limit-up ladder, and concept-heat cards on `/dashboard`, including local loading, error, and stale states.
- [ ] 2.3 Add English and Chinese dashboard copy and store/page coverage for the new cards and partial degradation.

## 3. Verification and Delivery

- [ ] 3.1 Run focused Vitest, the frontend production build, and strict OpenSpec validation; confirm existing AI summary, watchlist, and Agent handoff behavior does not regress.
