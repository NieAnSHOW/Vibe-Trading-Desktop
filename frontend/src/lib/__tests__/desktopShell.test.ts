import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getShellConsoleUrl,
  initDesktopShell,
  isDesktopEmbedded,
  isShellConsoleUrl,
  returnToConsole,
} from "@/lib/desktopShell";

function setSearch(search: string) {
  window.history.replaceState(null, "", search);
}

describe("desktopShell", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    setSearch("/");
  });

  it("captures desktop flag and console url on init", () => {
    setSearch("/?desktop=1&console=" + encodeURIComponent("tauri://localhost/index.html"));
    initDesktopShell();

    expect(isDesktopEmbedded()).toBe(true);
    expect(getShellConsoleUrl()).toBe("tauri://localhost/index.html");
  });

  it("keeps working after SPA navigation drops the query string", () => {
    setSearch("/?desktop=1&console=" + encodeURIComponent("http://tauri.localhost/"));
    initDesktopShell();
    // 模拟 SPA 路由跳转:查询串丢失
    setSearch("/agent");

    expect(isDesktopEmbedded()).toBe(true);
    expect(getShellConsoleUrl()).toBe("http://tauri.localhost/");
  });

  it("is not embedded in a plain browser visit", () => {
    setSearch("/");
    initDesktopShell();

    expect(isDesktopEmbedded()).toBe(false);
    expect(getShellConsoleUrl()).toBeNull();
  });

  it("rejects console urls with unexpected schemes", () => {
    expect(isShellConsoleUrl("javascript:alert(1)")).toBe(false);
    expect(isShellConsoleUrl("data:text/html,hi")).toBe(false);
    expect(isShellConsoleUrl("not a url")).toBe(false);
    expect(isShellConsoleUrl("http://127.0.0.1:8899/")).toBe(true);
    expect(isShellConsoleUrl("tauri://localhost/index.html")).toBe(true);

    setSearch("/?desktop=1&console=javascript:alert(1)");
    initDesktopShell();
    expect(getShellConsoleUrl()).toBeNull();
  });

  it("navigates only when a valid console url exists", () => {
    const navigate = vi.fn();

    returnToConsole(navigate);
    expect(navigate).not.toHaveBeenCalled();

    setSearch("/?desktop=1&console=" + encodeURIComponent("http://tauri.localhost/index.html"));
    initDesktopShell();
    returnToConsole(navigate);
    expect(navigate).toHaveBeenCalledWith("http://tauri.localhost/index.html");
  });
});
