import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

function renderLayout() {
  i18n.changeLanguage("zh-CN");
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
  it("starts on the Web UI tab with the existing sidebar and route outlet", () => {
    renderLayout();

    expect(screen.getByRole("tab", { name: /交易智能体/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("link", { name: /首页/i })).toBeInTheDocument();
    expect(screen.getByText("Dashboard route content")).toBeInTheDocument();
  });

  it("keeps the Web UI panel constrained to the available tab body size", () => {
    const { container } = renderLayout();

    expect(container.querySelector('[data-testid="web-ui-tab-panel"]')).toHaveClass("flex", "h-full", "w-full", "min-h-0", "min-w-0");
    expect(container.querySelector('[data-testid="web-ui-shell"]')).toHaveClass("flex", "h-full", "w-full", "min-h-0", "min-w-0");
    expect(container.querySelector('[data-testid="web-ui-main"]')).toHaveClass("min-h-0", "min-w-0", "overflow-hidden");
    expect(container.querySelector('[data-testid="web-ui-outlet"]')).toHaveClass("min-h-0", "min-w-0", "overflow-auto");
  });

  it("shows shortcuts without the Web UI sidebar", async () => {
    const user = userEvent.setup();
    const { container } = renderLayout();

    await user.click(screen.getByRole("tab", { name: /快捷入口/i }));

    expect(screen.getByRole("tab", { name: /快捷入口/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/打开常用的中国大陆金融资讯网站/i)).toBeInTheDocument();
    expect(container.querySelector('[data-testid="web-ui-tab-panel"]')).toHaveClass("hidden");
    expect(container.querySelector('[data-testid="shortcuts-tab-panel"]')).toHaveClass("flex");
  });

  it("opens an external iframe tab from a shortcut and keeps it outside the Web UI sidebar", async () => {
    const user = userEvent.setup();
    const { container } = renderLayout();

    await user.click(screen.getByRole("tab", { name: /快捷入口/i }));
    await user.click(screen.getByRole("button", { name: /打开 同花顺/i }));

    expect(screen.getByRole("tab", { name: /同花顺/i })).toHaveAttribute("aria-selected", "true");
    expect(container.querySelector('[data-testid="web-ui-tab-panel"]')).toHaveClass("hidden");
    expect(container.querySelector('[data-testid="external-tab-panel-tonghuashun"]')).toHaveClass("flex");

    const iframe = screen.getByTitle("同花顺");
    expect(iframe).toHaveAttribute("src", "https://www.10jqka.com.cn/");
    expect(iframe).not.toHaveAttribute("sandbox");
    expect(screen.getByRole("button", { name: /外部打开/i })).toBeInTheDocument();
  });

  it("opens the current external tab URL through the desktop shell", async () => {
    const user = userEvent.setup();
    renderLayout();

    await user.click(screen.getByRole("tab", { name: /快捷入口/i }));
    await user.click(screen.getByRole("button", { name: /打开 同花顺/i }));
    await user.click(screen.getByRole("button", { name: /外部打开/i }));

    const { invoke } = await import("@tauri-apps/api/core");
    expect(invoke).toHaveBeenCalledWith("open_external_url", {
      url: "https://www.10jqka.com.cn/",
    });
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
