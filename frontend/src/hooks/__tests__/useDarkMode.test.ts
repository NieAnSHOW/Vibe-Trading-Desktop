import { renderHook } from "@testing-library/react";
import { initDesktopShell } from "@/lib/desktopShell";
import { useDarkMode } from "../useDarkMode";

describe("useDarkMode", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.classList.remove("dark");
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
});
