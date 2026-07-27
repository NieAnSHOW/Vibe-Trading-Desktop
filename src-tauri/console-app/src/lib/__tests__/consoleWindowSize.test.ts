import { describe, expect, it } from "vitest";

import { resolveConsoleWindowHeight } from "../consoleWindowSize";

describe("resolveConsoleWindowHeight", () => {
  it("caps the outer height at 880 when an ad slot has data", () => {
    expect(
      resolveConsoleWindowHeight({
        contentHeight: 900,
        titleBarHeight: 28,
        hasAdData: true,
      }),
    ).toBe(880);
  });

  it("uses the measured content height when neither ad slot has data", () => {
    expect(
      resolveConsoleWindowHeight({
        contentHeight: 900,
        titleBarHeight: 28,
        hasAdData: false,
      }),
    ).toBe(928);
  });

  it("keeps a 600px minimum height when neither ad slot has data", () => {
    expect(
      resolveConsoleWindowHeight({
        contentHeight: 500,
        titleBarHeight: 28,
        hasAdData: false,
      }),
    ).toBe(600);
  });
});
