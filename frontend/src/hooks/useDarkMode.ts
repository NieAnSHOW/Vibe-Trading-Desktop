import { useEffect, useState } from "react";
import { getDesktopThemeColor, getDesktopThemeMode } from "@/lib/desktopShell";

export function useDarkMode() {
  const [dark, setDark] = useState(() => {
    const mode = getDesktopThemeMode();
    return mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  });

  useEffect(() => {
    const mode = getDesktopThemeMode();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      setDark(mode === "dark" || (mode === "system" && media.matches));
    };
    const color = getDesktopThemeColor();
    if (color) document.documentElement.dataset.brand = color;
    else delete document.documentElement.dataset.brand;
    apply();
    if (mode === "system") media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return { dark };
}
