# Alpha, Correlation, and Settings Workspace Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe Alpha Zoo, Correlation, and Settings as responsive Indices-style workspaces without changing runtime behavior.

**Architecture:** Preserve current state, API calls, event handlers, routes, form controls, and child components. Change page-level JSX wrappers and Tailwind classes only: desktop uses compact headers and `min-h-0` grid surfaces, while mobile stacks the same semantic content.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Vitest, Testing Library, Vite.

## Global Constraints

- Do not alter API calls, request timing, state transitions, routes, form payloads, translations, or business behavior.
- Preserve semantic HTML, labels, IDs, ARIA attributes, button names, keyboard behavior, loading states, and error states.
- Use existing `rounded-lg border bg-card` workspace surfaces and compact Indices/News spacing.
- At widths below `lg`, all page-level grids collapse to one column.
- Do not touch `frontend/src/pages/News.tsx`; it has unrelated worktree changes.

---

### Task 1: Add Stable Workspace Layout Tests

**Files:**
- Create: `frontend/src/pages/__tests__/WorkspaceLayouts.test.tsx`
- Reference: `frontend/src/pages/__tests__/Indices.test.tsx`
- Reference: `frontend/src/pages/__tests__/SettingsChannels.test.tsx`

**Interfaces:** Consumes the existing `AlphaZoo`, `Correlation`, and `Settings` public components. Produces page-level test IDs for structural assertions; existing behavior suites remain the authority for interactions.

- [ ] **Step 1: Write failing layout assertions**

```tsx
expect(await screen.findByTestId("alpha-zoo-workspace")).toHaveClass("lg:grid");
expect(screen.getByTestId("alpha-zoo-filters")).toHaveClass("lg:col-start-1");
expect(screen.getByTestId("alpha-zoo-catalogue")).toHaveClass("lg:col-start-2");
expect(screen.getByTestId("correlation-workspace")).toHaveClass("lg:grid");
expect(screen.getByTestId("correlation-controls")).toHaveClass("lg:col-start-1");
expect(screen.getByTestId("correlation-results")).toHaveClass("lg:col-start-2");
expect(await screen.findByTestId("settings-workspace")).toHaveClass("lg:grid");
```

- [ ] **Step 2: Run the test before implementation**

Run: `cd frontend && npx vitest run src/pages/__tests__/WorkspaceLayouts.test.tsx`

Expected: FAIL because the workspace test IDs do not yet exist.

- [ ] **Step 3: Mock only the existing chart dependency**

```tsx
vi.mock("@/components/charts/CorrelationMatrix", () => ({
  CorrelationMatrix: () => <div data-testid="correlation-matrix" />,
}));
```

### Task 2: Reframe Alpha Zoo Views

**Files:**
- Modify: `frontend/src/pages/AlphaZoo.tsx:215-1440`
- Test: `frontend/src/pages/__tests__/WorkspaceLayouts.test.tsx`

**Interfaces:** Consumes existing browse filters, selection, route links, detail, benchmark, and compare views. Produces browse test IDs `alpha-zoo-workspace`, `alpha-zoo-filters`, and `alpha-zoo-catalogue`.

- [ ] **Step 1: Replace the browse outer flow with a full-width workspace grid**

```tsx
<div data-testid="alpha-zoo-workspace" className="flex h-full w-full min-w-0 flex-col gap-3 p-3 lg:grid lg:grid-cols-[minmax(15rem,0.36fr)_minmax(0,1fr)] lg:grid-rows-[auto_auto_minmax(0,1fr)] lg:gap-3 lg:p-5">
  <header className="min-w-0 lg:col-span-2">...</header>
  <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:col-span-2">...</section>
  <aside data-testid="alpha-zoo-filters" className="min-h-0 rounded-lg border bg-card p-3 lg:col-start-1 lg:row-start-3 lg:overflow-auto">...</aside>
  <section data-testid="alpha-zoo-catalogue" className="min-h-0 rounded-lg border bg-card lg:col-start-2 lg:row-start-3 lg:overflow-auto">...</section>
</div>
```

- [ ] **Step 2: Move only wrappers/classes; preserve existing control semantics**

```tsx
value={search}
onChange={(event) => { setSearch(event.target.value); setVisibleCount(PAGE_SIZE); }}
to={compareHref}
to="/alpha-zoo/bench"
```

- [ ] **Step 3: Normalize detail, bench, and compare outer spacing**

```tsx
<div className="mx-auto w-full max-w-6xl space-y-4 p-3 lg:p-5">
  {/* existing route-specific content unchanged */}
</div>
```

- [ ] **Step 4: Run the layout test**

Run: `cd frontend && npx vitest run src/pages/__tests__/WorkspaceLayouts.test.tsx`

Expected: Alpha Zoo assertions pass; unimplemented-page assertions may still fail.

### Task 3: Reframe Correlation as an Analysis Workspace

**Files:**
- Modify: `frontend/src/pages/Correlation.tsx:35-121`
- Test: `frontend/src/pages/__tests__/WorkspaceLayouts.test.tsx`

**Interfaces:** Consumes current `codes`, `days`, `method`, `compute`, `labels`, `matrix`, and `error` state. Produces `correlation-workspace`, `correlation-controls`, and `correlation-results` without changing the request URL.

- [ ] **Step 1: Add a responsive header/control/result workspace**

```tsx
<div data-testid="correlation-workspace" className="flex h-full w-full min-w-0 flex-col gap-3 p-3 lg:grid lg:grid-cols-[minmax(17rem,0.38fr)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-3 lg:p-5">
  <header className="flex items-center gap-2 lg:col-span-2">...</header>
  <section data-testid="correlation-controls" className="rounded-lg border bg-card p-3 lg:col-start-1 lg:row-start-2 lg:overflow-auto">...</section>
  <section data-testid="correlation-results" className="min-h-[24rem] rounded-lg border bg-card p-3 lg:col-start-2 lg:row-start-2 lg:min-h-0 lg:overflow-auto">...</section>
</div>
```

- [ ] **Step 2: Retain request construction and provide a visual-only blank result**

```tsx
const result = await request<{ labels: string[]; matrix: number[][] }>(
  `/correlation?codes=${encodeURIComponent(codes)}&days=${days}&method=${method}`,
);
{labels.length > 0 ? <CorrelationMatrix labels={labels} matrix={matrix} height={520} /> : !error ? <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground" /> : null}
```

- [ ] **Step 3: Run the layout test**

Run: `cd frontend && npx vitest run src/pages/__tests__/WorkspaceLayouts.test.tsx`

Expected: Alpha Zoo and Correlation assertions pass.

### Task 4: Reframe Settings at the Page Level

**Files:**
- Modify: `frontend/src/pages/Settings.tsx:493-1133`
- Test: `frontend/src/pages/__tests__/WorkspaceLayouts.test.tsx`
- Test: `frontend/src/pages/__tests__/SettingsChannels.test.tsx`
- Test: `frontend/src/pages/__tests__/SettingsQVeris.test.tsx`

**Interfaces:** Consumes current LLM/data-source forms, `QVerisSettings`, telemetry consent, channel controls, and `RuntimeStatus`. Produces `settings-workspace` on loaded and loading wrappers; nested control interfaces remain unchanged.

- [ ] **Step 1: Give loading and loaded states a full-width workspace wrapper**

```tsx
<div data-testid="settings-workspace" className="mx-auto flex h-full w-full max-w-7xl min-w-0 flex-col gap-3 p-3 lg:p-5">
  <header className="space-y-1">...</header>
  <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.58fr)]">...</div>
</div>
```

- [ ] **Step 2: Place existing LLM/data forms in the primary cell and helper cards in the secondary cell**

```tsx
<div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.58fr)]">
  <div className="min-w-0 space-y-3">{/* LLM and data-source form */}</div>
  <aside className="min-w-0 space-y-3">{localApiAccessSection}<QVerisSettings />{/* consent */}</aside>
</div>
<section className="min-w-0 rounded-lg border bg-card p-5">{/* existing IM channels */}</section>
<RuntimeStatus />
```

- [ ] **Step 3: Retain event handlers and disabled states byte-for-byte where possible**

```tsx
<form onSubmit={submit}>
<button onClick={refreshChannelStatus} disabled={channelBusy}>
<button onClick={() => setChannelsRunning("start")} disabled={channelControlsDisabled}>
<button role="switch" aria-checked={usageDataOn} onClick={() => toggleUsageData(!usageDataOn)}>
```

- [ ] **Step 4: Run layout and Settings behavior suites**

Run: `cd frontend && npx vitest run src/pages/__tests__/WorkspaceLayouts.test.tsx src/pages/__tests__/SettingsChannels.test.tsx src/pages/__tests__/SettingsQVeris.test.tsx`

Expected: PASS.

### Task 5: Verify, Review, and Commit

**Files:**
- Modify: `frontend/src/pages/AlphaZoo.tsx`
- Modify: `frontend/src/pages/Correlation.tsx`
- Modify: `frontend/src/pages/Settings.tsx`
- Create: `frontend/src/pages/__tests__/WorkspaceLayouts.test.tsx`

**Interfaces:** Consumes completed workspace surfaces and existing behavior tests. Produces build-verified, browser-inspected layout-only changes.

- [ ] **Step 1: Run all affected frontend tests**

Run: `cd frontend && npx vitest run src/pages/__tests__/WorkspaceLayouts.test.tsx src/pages/__tests__/SettingsChannels.test.tsx src/pages/__tests__/SettingsQVeris.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run the production build**

Run: `cd frontend && npm run build`

Expected: `tsc -b && vite build` exits 0; existing chunk-size warnings are acceptable.

- [ ] **Step 3: Inspect desktop and mobile routes**

Run: `cd frontend && npm run dev -- --host 127.0.0.1 --port 5899`

Expected: `/alpha-zoo`, `/correlation`, and `/settings` show two-column desktop workspaces and single-column mobile flows without overflow or overlap.

- [ ] **Step 4: Request independent review**

```text
Review the AlphaZoo, Correlation, Settings, and WorkspaceLayouts changes for behavior changes, responsive regressions, accessibility regressions, and missing tests.
```

- [ ] **Step 5: Commit only requested page and test files**

```bash
git add frontend/src/pages/AlphaZoo.tsx frontend/src/pages/Correlation.tsx frontend/src/pages/Settings.tsx frontend/src/pages/__tests__/WorkspaceLayouts.test.tsx
git commit -s -m "feat(frontend): align workspace page layouts"
```
