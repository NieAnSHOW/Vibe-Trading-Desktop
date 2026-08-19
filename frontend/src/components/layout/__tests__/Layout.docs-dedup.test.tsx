import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { Layout } from "../Layout";

// 文件级隔离:打开路径全部记入 opens,拦截器替换为手动 claim 以复现
// 生产时序(document 捕获阶段先 preventDefault 并打开一次)。
const opens: string[] = [];

vi.mock("@/lib/externalLinks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/externalLinks")>();
  return {
    ...actual,
    openExternalUrl: (url: string) => opens.push(url),
    installExternalLinkInterceptor: () => () => {},
  };
});

vi.mock("@/lib/desktopShell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktopShell")>();
  return { ...actual, isDesktopEmbedded: () => true };
});

vi.mock("@/lib/api", () => ({
  api: { listSessions: vi.fn().mockResolvedValue([]) },
}));

beforeEach(() => {
  opens.length = 0;
});

describe("docs link single-open in the desktop shell", () => {
  it("yields to the capture-phase interceptor instead of opening twice", async () => {
    const claim = (event: MouseEvent) => {
      if ((event.target as HTMLElement)?.closest?.("a[href]")) {
        event.preventDefault();
        opens.push("interceptor");
      }
    };
    document.addEventListener("click", claim, true);
    try {
      i18n.changeLanguage("zh-CN");
      const user = userEvent.setup();
      render(
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<div>Dashboard route content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );

      await user.click(screen.getByRole("link", { name: /文档/i }));

      expect(opens).toEqual(["interceptor"]);
    } finally {
      document.removeEventListener("click", claim, true);
    }
  });

  it("still opens the docs link itself when no interceptor claimed the click", async () => {
    i18n.changeLanguage("zh-CN");
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<div>Dashboard route content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("link", { name: /文档/i }));

    expect(opens).toEqual(["https://agent.nieanshow.cn/column/04-ai-trading/"]);
  });
});
