import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissDesktopRailBootstrap,
  getDesktopThemeColor,
  getDesktopThemeMode,
  getShellConsoleUrl,
  initDesktopShell,
  isDesktopEmbedded,
  isDesktopShellFrame,
  isShellConsoleUrl,
  preserveDesktopShellFrameUrl,
  returnToConsole,
  returnToConsoleWithTransition,
  shellConsolePageUrl,
} from "@/lib/desktopShell";
import { getApiAuthKey } from "@/lib/apiAuth";
import webuiDocument from "../../../index.html?raw";

function setSearch(search: string) {
  window.history.replaceState(null, "", search);
}

describe("desktopShell", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    setSearch("/");
  });

  it("does not ship an environment item in the HTML-first desktop rail", () => {
    expect(webuiDocument).not.toContain('data-bootstrap-label="environment"');
    expect(webuiDocument).not.toContain(">环境<");
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

  it("keeps desktop theme preferences after SPA navigation drops the query string", () => {
    setSearch("/?desktop=1&theme=dark&theme_color=blue");
    initDesktopShell();
    // 模拟 SPA 路由跳转：查询串会被 React Router 清掉。
    setSearch("/agent");

    expect(getDesktopThemeMode()).toBe("dark");
    expect(getDesktopThemeColor()).toBe("blue");
  });

  it("captures the api key passed by the desktop console (empty clears)", () => {
    setSearch("/?desktop=1&api_key=sk-from-console");
    initDesktopShell();
    expect(getApiAuthKey()).toBe("sk-from-console");

    // 桌面侧清除(空值)后,下次内嵌加载同步清掉 WebUI 本地存储
    setSearch("/?desktop=1&api_key=");
    initDesktopShell();
    expect(getApiAuthKey()).toBe("");
  });

  it("leaves the api key untouched on plain browser visits", () => {
    window.localStorage.setItem("vibe_trading_api_auth_key", "sk-manual");
    setSearch("/agent");
    initDesktopShell();
    expect(getApiAuthKey()).toBe("sk-manual");
  });

  it("clears a stale theme color when the desktop shell does not provide one", () => {
    window.sessionStorage.setItem("vibe.desktop.themeColor", "blue");
    setSearch("/?desktop=1&theme=dark");
    initDesktopShell();

    expect(getDesktopThemeColor()).toBeNull();
  });

  it("is not embedded in a plain browser visit", () => {
    setSearch("/");
    initDesktopShell();

    expect(isDesktopEmbedded()).toBe(false);
    expect(getShellConsoleUrl()).toBeNull();
  });

  it("recognizes a WebUI iframe while retaining desktop privileges", () => {
    setSearch("/?desktop=1&shell=frame&theme=dark");
    initDesktopShell();

    expect(isDesktopEmbedded()).toBe(true);
    expect(isDesktopShellFrame()).toBe(true);
  });

  it("restores frame query markers after a SPA route drops them", () => {
    setSearch("/?desktop=1&shell=frame");
    initDesktopShell();
    setSearch("/settings?tab=appearance#theme");

    preserveDesktopShellFrameUrl();

    expect(window.location.pathname).toBe("/settings");
    expect(window.location.search).toBe("?tab=appearance&desktop=1&shell=frame");
    expect(window.location.hash).toBe("#theme");
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

    returnToConsole("console", navigate);
    expect(navigate).not.toHaveBeenCalled();

    setSearch("/?desktop=1&console=" + encodeURIComponent("http://tauri.localhost/index.html"));
    initDesktopShell();
    returnToConsole("console", navigate);
    expect(navigate).toHaveBeenCalledWith("http://tauri.localhost/index.html?theme=system&transition=1");
  });

  it("targets console pages via hash routes", () => {
    setSearch("/?desktop=1&theme=dark&theme_color=blue&console=" + encodeURIComponent("tauri://localhost/index.html#/settings"));
    initDesktopShell();

    // base 规范化:剥掉壳侧携带的旧 hash 后再拼目标页;同时携带主题供控制台首屏同步绘制。
    expect(shellConsolePageUrl("login")).toBe("tauri://localhost/index.html?theme=dark&theme_color=blue&transition=1#/login");
    expect(shellConsolePageUrl("profile")).toBe("tauri://localhost/index.html?theme=dark&theme_color=blue&transition=1#/profile");
    expect(shellConsolePageUrl("settings")).toBe("tauri://localhost/index.html?theme=dark&theme_color=blue&transition=1#/settings");
    expect(shellConsolePageUrl("console")).toBe("tauri://localhost/index.html?theme=dark&theme_color=blue&transition=1");

    const navigate = vi.fn();
    returnToConsole("settings", navigate);
    expect(navigate).toHaveBeenCalledWith("tauri://localhost/index.html?theme=dark&theme_color=blue&transition=1#/settings");
  });

  it("waits for the shell exit transition before returning to the console", () => {
    vi.useFakeTimers();
    try {
      setSearch("/?desktop=1&theme=dark&console=" + encodeURIComponent("tauri://localhost/index.html"));
      initDesktopShell();
      const navigate = vi.fn();

      returnToConsoleWithTransition("settings", navigate);

      expect(navigate).not.toHaveBeenCalled();
      expect(document.documentElement.classList.contains("desktop-shell-leaving")).toBe(true);
      vi.advanceTimersByTime(220);
      expect(navigate).toHaveBeenCalledWith("tauri://localhost/index.html?theme=dark&transition=1#/settings");
    } finally {
      vi.useRealTimers();
      document.documentElement.classList.remove("desktop-shell-leaving");
    }
  });

  it("does not queue a second shell navigation while one is leaving", () => {
    vi.useFakeTimers();
    try {
      setSearch("/?desktop=1&theme=dark&console=" + encodeURIComponent("tauri://localhost/index.html"));
      initDesktopShell();
      const navigate = vi.fn();

      returnToConsoleWithTransition("settings", navigate);
      returnToConsoleWithTransition("profile", navigate);
      vi.advanceTimersByTime(220);

      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith("tauri://localhost/index.html?theme=dark&transition=1#/settings");
    } finally {
      vi.useRealTimers();
      document.documentElement.classList.remove("desktop-shell-leaving");
    }
  });

  it("skips the shell delay when reduced motion is requested", () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
      setSearch("/?desktop=1&theme=dark&console=" + encodeURIComponent("tauri://localhost/index.html"));
      initDesktopShell();
      const navigate = vi.fn();

      returnToConsoleWithTransition("settings", navigate);

      expect(navigate).toHaveBeenCalledWith("tauri://localhost/index.html?theme=dark&transition=1#/settings");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      document.documentElement.classList.remove("desktop-shell-leaving");
    }
  });

  it("removes the pre-rendered rail only after the React rail can take over", () => {
    const bootstrap = document.createElement("aside");
    bootstrap.id = "desktop-shell-rail-bootstrap";
    document.body.append(bootstrap);

    dismissDesktopRailBootstrap();

    expect(document.getElementById("desktop-shell-rail-bootstrap")).toBeNull();
  });
});
