# Frontend External Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a React-only top-level tab experience for the existing Web UI, China finance shortcuts, and iframe-based external site tabs.

**Architecture:** `Layout.tsx` owns desktop-level tab state. The fixed `Web UI` tab renders the existing sidebar, connection banner, and route outlet unchanged inside that tab. The fixed `Shortcuts` tab and dynamic external tabs render outside the Web UI sidebar boundary.

**Tech Stack:** React 19, react-router-dom, lucide-react, Testing Library, Vitest, Tailwind utility classes.

---

## File Structure

- Modify `frontend/src/components/layout/Layout.tsx`: add desktop tab state, shortcut grid, external iframe panels, and keep existing Web UI layout as a tab panel.
- Create `frontend/src/components/layout/__tests__/Layout.test.tsx`: focused tests for fixed tabs, opening/closing external tabs, and sidebar boundary behavior.

## Task 1: Layout Tests

**Files:**
- Create: `frontend/src/components/layout/__tests__/Layout.test.tsx`

- [x] **Step 1: Write failing tests**

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";
import { Layout } from "../Layout";

vi.mock("@/lib/api", () => ({
  api: {
    listSessions: vi.fn().mockResolvedValue([]),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
  },
}));

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<div>Dashboard route content</div>} />
          <Route path="/agent" element={<div>Agent route content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Layout desktop tabs", () => {
  it("starts on the Web UI tab with the existing sidebar and route outlet", async () => {
    renderLayout();
    expect(screen.getByRole("tab", { name: /交易智能体/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("link", { name: /首页/i })).toBeInTheDocument();
    expect(screen.getByText("Dashboard route content")).toBeInTheDocument();
  });

  it("shows shortcuts without the Web UI sidebar", async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole("tab", { name: /快捷入口/i }));
    expect(screen.getByRole("tab", { name: /快捷入口/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/打开常用的中国大陆金融资讯网站/i)).toBeInTheDocument();
    expect(container.querySelector('[data-testid="web-ui-tab-panel"]')).toHaveClass("hidden");
  });

  it("opens an external iframe tab from a shortcut and keeps it outside the Web UI sidebar", async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole("tab", { name: /快捷入口/i }));
    await user.click(screen.getByRole("button", { name: /打开 同花顺/i }));
    expect(screen.getByRole("tab", { name: /同花顺/i })).toHaveAttribute("aria-selected", "true");
    expect(container.querySelector('[data-testid="web-ui-tab-panel"]')).toHaveClass("hidden");

    const iframe = screen.getByTitle("同花顺");
    expect(iframe).toHaveAttribute("src", "https://www.10jqka.com.cn/");
    expect(screen.getByRole("link", { name: /外部打开/i })).toHaveAttribute("href", "https://www.10jqka.com.cn/");
  });

  it("closing an external tab returns to Shortcuts", async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByRole("tab", { name: /快捷入口/i }));
    await user.click(screen.getByRole("button", { name: /打开 同花顺/i }));
    await user.click(screen.getByRole("button", { name: /关闭 同花顺/i }));
    expect(screen.queryByRole("tab", { name: /同花顺/i })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /快捷入口/i })).toHaveAttribute("aria-selected", "true");
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm run test:run -- src/components/layout/__tests__/Layout.test.tsx`

Expected: FAIL because `Shortcuts` tab and external iframe tab behavior do not exist yet.

## Task 2: Implement Frontend Tabs

**Files:**
- Modify: `frontend/src/components/layout/Layout.tsx`

- [x] **Step 1: Add tab state and shortcut metadata**

Add `ExternalTab`, `Shortcut`, fixed tab ids, and a static shortcut list near the top of `Layout.tsx`. The final shortcut list uses mainland China finance sites: 同花顺、腾讯财经、东方财富、新浪财经.

- [x] **Step 2: Wrap the existing layout as the Web UI panel**

Keep the existing sidebar, session list, footer, connection banner, and `<Outlet />` behavior intact, but render that whole structure only when active tab is `web-ui`.

- [x] **Step 3: Add the desktop tab bar and Shortcuts panel**

Render a top-level tab bar above the active panel. The Shortcuts panel displays shortcut buttons, has no Web UI sidebar, and clicking a shortcut opens or activates a matching external tab.

- [x] **Step 4: Add external iframe panels**

Render every open external tab in a mounted container and hide inactive ones with `hidden`/`flex` class switching. Each panel includes URL display, refresh button, external-open link, helper text, and an iframe.

- [x] **Step 5: Run focused tests**

Run: `cd frontend && npm run test:run -- src/components/layout/__tests__/Layout.test.tsx`

Expected: PASS.

## Task 3: Verify Build

**Files:**
- Verify all modified frontend files.

- [x] **Step 1: Run focused frontend tests**

Run: `cd frontend && npm run test:run -- src/components/layout/__tests__/Layout.test.tsx src/i18n/__tests__/locales.test.ts`

Expected: PASS.

- [x] **Step 2: Run frontend build**

Run: `cd frontend && npm run build`

Expected: PASS.
