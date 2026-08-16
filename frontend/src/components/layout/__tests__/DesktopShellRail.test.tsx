import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  returnToConsoleWithTransition: vi.fn(),
  track: vi.fn(),
  toggleTheme: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/desktopShell", () => ({
  returnToConsoleWithTransition: mocks.returnToConsoleWithTransition,
}));

vi.mock("@/lib/telemetry", () => ({ track: mocks.track }));

import { DesktopShellRail } from "../DesktopShellRail";

function renderRail(dark = false) {
  return render(<DesktopShellRail dark={dark} onToggleTheme={mocks.toggleTheme} />);
}

describe("DesktopShellRail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns account navigation to the profile page", async () => {
    renderRail();

    await userEvent.click(screen.getByRole("button", { name: "layout.rail.account" }));

    expect(mocks.returnToConsoleWithTransition).toHaveBeenCalledWith("profile");
  });

  it("does not expose environment navigation in the embedded research rail", () => {
    renderRail();

    expect(screen.queryByRole("button", { name: /environment/i })).not.toBeInTheDocument();
    expect(mocks.track).not.toHaveBeenCalledWith(
      "feature_use",
      { nav_target: "desktop-environment" },
      { name: "desktop_rail" },
    );
  });

  it("places the theme toggle beside settings at the bottom of the rail", async () => {
    renderRail();

    await userEvent.click(screen.getByRole("button", { name: "layout.light" }));

    expect(mocks.toggleTheme).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "layout.settings" })).toBeInTheDocument();
  });

  it("shows the current theme with the matching icon", () => {
    const { rerender } = renderRail(true);

    const darkTheme = screen.getByRole("button", { name: "layout.dark" });
    expect(darkTheme.querySelector(".lucide-moon")).toBeInTheDocument();

    rerender(<DesktopShellRail dark={false} onToggleTheme={mocks.toggleTheme} />);

    const lightTheme = screen.getByRole("button", { name: "layout.light" });
    expect(lightTheme.querySelector(".lucide-sun")).toBeInTheDocument();
  });

  it("uses the shared desktop rail style hooks", () => {
    renderRail();

    expect(screen.getByRole("complementary")).toHaveClass("desktop-shell-rail");
    expect(screen.getByRole("button", { name: "layout.rail.research" })).toHaveClass(
      "desktop-shell-rail__item--active",
    );
  });
});
