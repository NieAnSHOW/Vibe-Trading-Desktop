import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntradayChart } from "../IntradayChart";

const setOption = vi.fn();
const dispose = vi.fn();
const resize = vi.fn();

vi.mock("@/lib/echarts", () => ({
  echarts: {
    init: vi.fn(() => ({ setOption, dispose, resize })),
  },
}));

vi.mock("@/lib/chart-theme", () => ({
  getChartTheme: () => ({
    axisColor: "#111",
    gridColor: "#222",
    textColor: "#333",
    tooltipBg: "#fff",
    tooltipBorder: "#ddd",
    tooltipText: "#111",
    upColor: "#f00",
    downColor: "#0a0",
    volumeUp: "#faa",
    volumeDown: "#afa",
  }),
}));

vi.mock("@/hooks/useDarkMode", () => ({
  useDarkMode: () => ({ dark: false }),
}));

describe("IntradayChart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets a price line and volume bars from intraday PriceBars", async () => {
    render(
      <IntradayChart
        data={[
          {
            time: "2026-07-23T09:31:00",
            open: 10,
            high: 11,
            low: 9,
            close: 10.5,
            volume: 1000,
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(setOption).toHaveBeenCalledWith(
        expect.objectContaining({
          series: expect.arrayContaining([
            expect.objectContaining({ name: "Price", type: "line" }),
            expect.objectContaining({ name: "Vol", type: "bar" }),
          ]),
        }),
      );
    });
  });
});
