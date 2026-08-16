import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  returnToConsole: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/desktopShell", () => ({
  returnToConsole: mocks.returnToConsole,
}));

vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));

import { DesktopShellRail } from "../DesktopShellRail";

describe("DesktopShellRail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns account navigation to the profile page", async () => {
    render(<DesktopShellRail />);

    await userEvent.click(screen.getByRole("button", { name: "layout.rail.account" }));

    expect(mocks.returnToConsole).toHaveBeenCalledWith("profile");
  });
});
