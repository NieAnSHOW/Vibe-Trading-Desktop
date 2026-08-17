import { useEffect, useState } from "react";
import {
  getDesktopThemeColor,
  getDesktopThemeMode,
  isDesktopEmbedded,
  isDesktopShellFrame,
  setDesktopThemeMode,
  type DesktopThemeMode,
} from "@/lib/desktopShell";

function shellThemeOverride(): boolean | null {
  if (!isDesktopShellFrame()) return null;
  const value = document.documentElement.dataset.shellDark;
  if (value === "dark") return true;
  if (value === "light") return false;
  return null;
}

function resolveDark(themeMode: DesktopThemeMode): boolean {
  const shellOverride = shellThemeOverride();
  if (shellOverride !== null) return shellOverride;
  return themeMode === "dark" || (themeMode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

export function useDarkMode() {
  const [themeMode, setThemeMode] = useState<DesktopThemeMode>(getDesktopThemeMode);
  const [dark, setDark] = useState(() => resolveDark(themeMode));
  const [themeSaving, setThemeSaving] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      setDark(resolveDark(themeMode));
    };
    const color = getDesktopThemeColor();
    if (color) document.documentElement.dataset.brand = color;
    else delete document.documentElement.dataset.brand;
    apply();
    if (themeMode === "system") media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    if (!isDesktopShellFrame()) return;
    const onShellTheme = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (data?.type !== "vibe-shell:theme" || typeof data.dark !== "boolean") return;
      document.documentElement.dataset.shellDark = data.dark ? "dark" : "light";
      setDark(data.dark);
      if (typeof data.color === "string") document.documentElement.dataset.brand = data.color;
    };
    window.addEventListener("message", onShellTheme);
    return () => window.removeEventListener("message", onShellTheme);
  }, []);

  const toggleDark = async () => {
    if (themeSaving) return;
    const mode = dark ? "light" : "dark";
    setThemeSaving(true);
    try {
      if (isDesktopEmbedded()) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("console_set_theme_mode", { mode });
      }
      setDesktopThemeMode(mode);
      setThemeMode(mode);
      setDark(mode === "dark");
    } catch {
      // Keep the current theme when the desktop preference cannot be saved.
    } finally {
      setThemeSaving(false);
    }
  };

  return { dark, themeSaving, toggleDark };
}
