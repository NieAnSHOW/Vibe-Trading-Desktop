# A Share News Reliability Design

## Goal

Make `/news` useful for China A-share research by default. A refresh must favor sources that users in China can normally read, avoid treating a syntactically valid external URL as a reliable article, and expose actionable source health. Global industry coverage remains available only when the user explicitly selects it.

## Decisions

- The default scope is `a_share`. `global_industry` is a separate, opt-in scope rather than a source filter applied after a global refresh.
- Each scope owns an independent snapshot, refresh task, source statistics, and disk file. Refreshing the global scope never delays or overwrites the A-share snapshot.
- The source directory becomes project-owned and declarative. It carries market scope, source priority, article access policy, and backup relationship metadata; it never accepts URLs from the UI or API caller.
- An article has one of two display policies: `direct` for manually approved domestic sources, or `summary_only` for global/uncertain sources. The client must not probe article URLs in a browser.
- Existing global catalog data is not silently relabeled as A-share content. Sources are explicitly classified during migration; unclassified sources are disabled until reviewed.

## Source Registry

Replace the immutable upstream-only 108/106 catalog contract with a versioned `source_registry.json` owned by this repository. The original vendored manifest and notice remain as provenance for imported global entries, but they are no longer the runtime policy.

Each entry contains:

```text
id, name, track_id, feed_url, scope, priority,
article_access, access_reviewed_for_cn, backup_source_ids, enabled, filters
```

`scope` is `a_share` or `global_industry`; `article_access` is `direct` or `summary_only`; `priority` orders source selection within a track. `direct` requires `access_reviewed_for_cn=true`, established by a manual source-level reader-access review before release. It is a display policy, not an impossible guarantee that every publisher article will remain online.

The initial `a_share` seed consists only of the existing, direct domestic feeds: Eastmoney Stock, Eastmoney News, WallstreetCN, EEO, 36Kr, TMTPost, IT Home, Huxiu, TechNode China, QbitAI, Zhidx, International Energy Network, and CnEVPost. Each is assigned only to its current compatible industry track. A track with no approved domestic source is explicitly unavailable; it does not fall back to an overseas feed. Global sources remain registered only in the `global_industry` scope.

The registry validator rejects unknown scopes, duplicate IDs, cross-scope backups, non-HTTP(S) feeds, unsafe hosts, and a `direct` policy without a China-accessibility review marker. Catalog loading exposes only enabled entries for the requested scope and groups duplicated feed URLs before network work.

## Refresh And Health Model

`GET /news-api/snapshot`, `POST /news-api/refresh`, and `GET /news-api/refresh/status` accept only the optional query parameter `scope=a_share|global_industry`, defaulting to `a_share`. They continue to reject bodies and arbitrary source or URL input. The coordinator registry gives each scope a dedicated single-flight coordinator and writes snapshots to `news/a_share.json` and `news/global_industry.json`.

The transport retains the existing SSRF protections, fixed DNS target handling, response cap, and redirect validation. It adds:

- Per-host concurrency limits in addition to the global limit.
- At most two retries for timeout, network failure, HTTP 408, HTTP 429, and HTTP 5xx, with bounded exponential backoff and `Retry-After` support.
- An in-memory per-endpoint circuit breaker. Repeated transient failures temporarily skip every assignment sharing that feed URL; a successful request resets the breaker. A manual refresh does not bypass a currently open breaker.
- A source outcome for every configured assignment: `success`, `failed`, `skipped_circuit_open`, or `disabled`, with a stable public reason and last successful timestamp.

The snapshot returns source outcomes for the selected track and aggregate counts for the scope. Raw upstream URLs, exception text, proxy configuration, and credentials remain absent from API responses and logs.

## Article And Retention Policy

RSS ingestion still does not fetch article pages. Pre-fetching every article would double external traffic, trigger anti-bot systems, and would not predict a user's geographic access. Instead, source policy controls the UI:

- `direct`: render the existing external-link action with `noopener noreferrer`.
- `summary_only`: retain normalized title, summary, source, and date, but do not render an original-link action. The page identifies it as external research content rather than promising a link that may not open.

Feed items gain `first_seen_at`. Fresh tracks retain an earlier item only while it remains inside the normal publication window; an item without a valid publication date expires after a short first-seen window. A stale track retains its last valid set only until the same expiration rules remove it. This replaces the current unbounded old-item merge and prevents outdated links from persisting indefinitely.

## Frontend Experience

The News page adds a compact segmented scope control next to refresh: `A Share` is selected initially and `Global Industry` is an explicit alternative. Switching scope loads that scope's snapshot and preserves a separate selected track per scope.

Each track continues to show fresh, stale, unavailable, and partial state. When a track is partial, its details show a concise source-health summary and a non-interactive list of failed or skipped source names with stable reasons. The content list uses the article access policy rather than `safeArticleUrl()` alone to decide whether to show the external-link action. The existing URL safety check remains defense in depth.

Existing AI summaries remain scope-local. A failed global refresh must not replace a valid A-share snapshot or turn the A-share page stale.

## Migration And Compatibility

The news snapshot schema increments from version 1 to version 2. The reader continues to accept version 1 as a read-only legacy snapshot for the A-share scope until its first successful v2 A-share refresh; it never invents source health for a v1 snapshot. All new writes use version 2 and the scope-specific file path.

The source registry ships with a reviewed A-share-first set before the global scope becomes visible. If no approved A-share feed is available, the scope reports `unavailable` with source health instead of falling back to overseas content.

## Tests

Backend tests cover registry validation and scope isolation; retry, `Retry-After`, circuit opening/recovery, and per-host limiting using fake transports/clocks; source outcome serialization; legacy v1 read behavior; item expiry; and the guarantee that a global refresh cannot mutate the A-share snapshot.

Frontend tests cover default A-share selection, scope switching, independent refresh behavior, direct versus summary-only articles, source-health rendering, and preservation of existing keyboard navigation and invalid-URL protection. The focused Python and Vitest suites run before the full backend/frontend suites and production frontend build.

## Non-Goals

- No article-body scraping, browser-side reachability probing, proxy auto-discovery, paywall bypass, or VPN behavior.
- No user-supplied feeds, URLs, credentials, or dynamic source management.
- No changes to trading, order, mandate, broker, or live-trading paths.
