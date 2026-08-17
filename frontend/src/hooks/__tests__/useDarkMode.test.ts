import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";
import { getDesktopThemeMode, initDesktopShell } from "@/lib/desktopShell";
import { useDarkMode } from "../useDarkMode";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

describe("useDarkMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(undefined);
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.shellDark;
    window.history.replaceState(null, "", "/");
  });

  it("defaults to light when no preference stored and OS is light", () => {
    const { result } = renderHook(() => useDarkMode());
    expect(result.current.dark).toBe(false);
  });

  it("uses the desktop theme preference instead of the system setting", () => {
    window.history.replaceState(null, "", "?desktop=1&theme=dark");

    const { result } = renderHook(() => useDarkMode());

    expect(result.current.dark).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("keeps the desktop preference after the router removes its query string", () => {
    window.history.replaceState(null, "", "?desktop=1&theme=dark&theme_color=blue");
    initDesktopShell();
    window.history.replaceState(null, "", "/agent");

    const { result } = renderHook(() => useDarkMode());

    expect(result.current.dark).toBe(true);
    expect(document.documentElement.dataset.brand).toBe("blue");
  });

  it("ignores legacy WebUI preferences so the default follows the system", () => {
    localStorage.setItem("qa-theme", "dark");

    const { result } = renderHook(() => useDarkMode());

    expect(result.current.dark).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("allows the desktop rail to switch the current WebUI theme", async () => {
    const { result } = renderHook(() => useDarkMode());

    await act(async () => {
      await result.current.toggleDark();
    });

    expect(result.current.dark).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("persists a desktop rail toggle for the next research session", async () => {
    window.history.replaceState(null, "", "?desktop=1&theme=light");
    initDesktopShell();
    const { result } = renderHook(() => useDarkMode());

    await act(async () => {
      await result.current.toggleDark();
    });

    expect(mocks.invoke).toHaveBeenCalledWith("console_set_theme_mode", { mode: "dark" });
    expect(result.current.dark).toBe(true);
    expect(getDesktopThemeMode()).toBe("dark");
  });

  it("accepts theme updates from the retained desktop shell frame", async () => {
    window.history.replaceState(null, "", "?desktop=1&shell=frame&theme=light");
    initDesktopShell();
    const { result } = renderHook(() => useDarkMode());

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { type: "vibe-shell:theme", dark: true, color: "blue" },
        }),
      );
    });

    expect(result.current.dark).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.brand).toBe("blue");
  });

  it("keeps a shell-synchronized dark theme when a later consumer mounts", async () => {
    window.history.replaceState(null, "", "?desktop=1&shell=frame&theme=light");
    initDesktopShell();
    const first = renderHook(() => useDarkMode());

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { type: "vibe-shell:theme", dark: true },
        }),
      );
    });

    expect(document.documentElement.classList.contains("dark")).toBe(true);

    const second = renderHook(() => useDarkMode());

    expect(second.result.current.dark).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    first.unmount();
    second.unmount();
  });
});
