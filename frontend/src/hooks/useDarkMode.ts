import { useEffect, useState } from "react";
import {
  getDesktopThemeColor,
  getDesktopThemeMode,
  isDesktopEmbedded,
  setDesktopThemeMode,
  type DesktopThemeMode,
} from "@/lib/desktopShell";

export function useDarkMode() {
  const [themeMode, setThemeMode] = useState<DesktopThemeMode>(getDesktopThemeMode);
  const [dark, setDark] = useState(() => {
    return themeMode === "dark" || (themeMode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  });
  const [themeSaving, setThemeSaving] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      setDark(themeMode === "dark" || (themeMode === "system" && media.matches));
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
