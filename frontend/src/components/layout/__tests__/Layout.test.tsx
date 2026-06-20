import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";
import i18n from "@/i18n";
import { Layout } from "../Layout";

vi.mock("@/lib/api", () => ({
  api: {
    listSessions: vi.fn().mockResolvedValue([]),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
  },
}));

function renderLayout(initialEntry = "/") {
  i18n.changeLanguage("zh-CN");
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<div>Dashboard route content</div>} />
          <Route path="/agent" element={<div>Agent route content</div>} />
          <Route path="/news" element={<div>News route content</div>} />
          <Route path="/stock-hot" element={<div>Stock hot route content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Layout navigation", () => {
  it("shows the React Router-managed app shell and route outlet", () => {
    renderLayout();

    expect(screen.getAllByRole("link", { name: /首页/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /新闻/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /股票热度/i }).length).toBeGreaterThan(0);
    expect(screen.getByText("Dashboard route content")).toBeInTheDocument();
  });

  it("keeps the web UI shell constrained to the available body size", () => {
    const { container } = renderLayout();

    expect(container.querySelector('[data-testid="web-ui-shell"]')).toHaveClass("flex", "h-full", "w-full", "min-h-0", "min-w-0");
    expect(container.querySelector('[data-testid="web-ui-main"]')).toHaveClass("min-h-0", "min-w-0", "overflow-hidden");
    expect(container.querySelector('[data-testid="web-ui-outlet"]')).toHaveClass("min-h-0", "min-w-0", "overflow-auto");
  });

  it("does not render deprecated external shortcut tabs or iframe panels", () => {
    renderLayout();

    expect(screen.queryByRole("tab", { name: /快捷入口/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle("同花顺")).not.toBeInTheDocument();
  });

  it("renders the news module outside the existing Web UI shell", () => {
    const { container } = renderLayout("/news");

    expect(screen.getByText("News route content")).toBeInTheDocument();
    expect(container.querySelector('[data-testid="web-ui-shell"]')).not.toBeInTheDocument();
    expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /智能体/i })).not.toBeInTheDocument();
  });

  it("renders the stock hotness module outside the existing Web UI shell", () => {
    const { container } = renderLayout("/stock-hot");

    expect(screen.getByText("Stock hot route content")).toBeInTheDocument();
    expect(container.querySelector('[data-testid="web-ui-shell"]')).not.toBeInTheDocument();
    expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /智能体/i })).not.toBeInTheDocument();
  });
});
