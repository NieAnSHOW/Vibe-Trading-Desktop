import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { Layout } from "../Layout";

vi.mock("@/lib/desktopShell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktopShell")>();
  return { ...actual, isDesktopEmbedded: () => true };
});

vi.mock("@/lib/api", () => ({
  api: {
    listSessions: vi.fn().mockResolvedValue([]),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
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
          <Route path="/usage" element={<div>Usage route content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Layout sidebar", () => {
  it("renders the embedded theme toggle with the shared Chinese label", () => {
    renderLayout();

    expect(screen.getByRole("button", { name: "浅色" })).toBeInTheDocument();
  });

  it("renders the sidebar with nav links and route outlet", () => {
    renderLayout();

    expect(screen.queryByRole("link", { name: /首页/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /市场看板/i })).toHaveClass(
      "bg-primary/10",
      "text-primary",
    );
    expect(screen.getByRole("link", { name: /指数/i })).toHaveAttribute("href", "/indices");
    expect(screen.getByText("Dashboard route content")).toBeInTheDocument();
  });

  it("places Market Pulse directly after Dashboard and before Indices", () => {
    renderLayout();

    const dashboard = screen.getByRole("link", { name: /市场看板/i });
    const marketPulse = screen.getByRole("link", { name: /市场异动/i });
    const indices = screen.getByRole("link", { name: /指数/i });

    expect(marketPulse).toHaveAttribute("href", "/market-pulse");
    expect(
      Boolean(
        dashboard.compareDocumentPosition(marketPulse) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      Boolean(
        marketPulse.compareDocumentPosition(indices) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  it("renders the investment news workspace link with active state", () => {
    renderLayout("/news");

    const news = screen.getByRole("link", { name: "投资资讯" });
    expect(news).toHaveAttribute("href", "/news");
    expect(news).toHaveClass("bg-primary/10", "text-primary");
    expect(screen.getByText("News route content")).toBeInTheDocument();
  });

  it("places the usage center beside Agent as an active workspace link", () => {
    renderLayout("/usage");

    const agent = screen.getByRole("link", { name: "智能体" });
    const usage = screen.getByRole("link", { name: "LLM 用量" });
    expect(usage).toHaveAttribute("href", "/usage");
    expect(usage).toHaveClass("bg-primary/10", "text-primary");
    expect(agent.compareDocumentPosition(usage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Usage route content")).toBeInTheDocument();
  });

  it("groups research tools under a collapsible research menu", async () => {
    const user = userEvent.setup();
    renderLayout();

    expect(screen.queryByRole("link", { name: "报告" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "运行时" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /投研工具/i }));

    const reports = screen.getByRole("link", { name: "报告" });
    const alphaZoo = screen.getByRole("link", { name: "Alpha 因子库" });
    const correlation = screen.getByRole("link", { name: "相关性矩阵" });
    const runtime = screen.getByRole("link", { name: "运行时" });
    expect(reports).toHaveAttribute("href", "/reports");
    expect(alphaZoo).toHaveAttribute("href", "/alpha-zoo");
    expect(correlation).toHaveAttribute("href", "/correlation");
    expect(runtime).toHaveAttribute("href", "/runtime");
    expect(
      Boolean(reports.compareDocumentPosition(alphaZoo) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(alphaZoo.compareDocumentPosition(correlation) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(correlation.compareDocumentPosition(runtime) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: /投研工具/i }));
    expect(screen.queryByRole("link", { name: "报告" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "运行时" })).not.toBeInTheDocument();
  });

  it("sits the research menu between workspace links and external shortcuts", () => {
    renderLayout();

    const usage = screen.getByRole("link", { name: "LLM 用量" });
    const research = screen.getByRole("button", { name: /投研工具/i });
    const shortcuts = screen.getByRole("button", { name: /快捷入口/i });

    expect(
      Boolean(usage.compareDocumentPosition(research) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(research.compareDocumentPosition(shortcuts) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(screen.queryByRole("link", { name: "设置" })).not.toBeInTheDocument();
  });

  it("keeps the main area constrained", () => {
    const { container } = renderLayout();

    expect(container.querySelector('[data-testid="web-ui-main"]')).toHaveClass("min-h-0", "min-w-0", "overflow-hidden");
    expect(container.querySelector('[data-testid="web-ui-outlet"]')).toHaveClass("min-h-0", "min-w-0", "overflow-auto");
  });

  it("keeps the desktop rail outside the cross-document transition content", () => {
    const { container } = renderLayout();
    const content = container.querySelector('[data-testid="desktop-shell-content"]');
    const rail = container.querySelector("aside[aria-label]");

    expect(content).toBeInTheDocument();
    expect(rail).toBeInTheDocument();
    expect(content).not.toContainElement(rail);
  });

  it("keeps session actions in the flex flow so long titles cannot overlap them", async () => {
    const session = {
      session_id: "session-with-a-long-title",
      title: "A long session title that must yield space to its actions",
    };
    vi.mocked(api.listSessions).mockResolvedValueOnce([session]);

    renderLayout("/agent?session=session-with-a-long-title");

    await screen.findByRole("link", { name: session.title });
    const actions = screen.getByTestId(`session-actions-${session.session_id}`);

    expect(actions).toHaveClass("shrink-0");
    expect(actions).not.toHaveClass("absolute");
    expect(screen.getByRole("button", { name: "重命名" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
  });

  it("renders external shortcut buttons when the group is expanded", async () => {
    const user = userEvent.setup();
    renderLayout();

    await user.click(screen.getByRole("button", { name: /快捷入口/i }));

    expect(screen.getByRole("button", { name: /同花顺/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /腾讯财经/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /东方财富/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新浪财经/i })).toBeInTheDocument();
  });

  it("opens external shortcut URL through the desktop shell", async () => {
    const user = userEvent.setup();
    renderLayout();

    await user.click(screen.getByRole("button", { name: /快捷入口/i }));
    await user.click(screen.getByRole("button", { name: /同花顺/i }));

    const { invoke } = await import("@tauri-apps/api/core");
    expect(invoke).toHaveBeenCalledWith("open_external_url", {
      url: "https://www.10jqka.com.cn/",
    });
  });

  it("opens the docs link through the system browser in the desktop shell", async () => {
    const user = userEvent.setup();
    renderLayout();
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();

    await user.click(screen.getByRole("link", { name: /文档/i }));

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("open_external_url", {
      url: "https://agent.nieanshow.cn/column/04-ai-trading/",
    });
  });

  it("routes plain external anchors in page content through the desktop shell", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<Layout />}>
            <Route
              path="/"
              element={
                <a href="https://stockapp.finance.qq.com/" target="_blank" rel="noreferrer">
                  quote
                </a>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();

    await user.click(screen.getByRole("link", { name: "quote" }));

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_external_url", {
        url: "https://stockapp.finance.qq.com/",
      }),
    );
  });
});
