import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import Indices from "@/pages/Indices";
import {
  fetchDashboardDailyBars,
  fetchDashboardIntradayBars,
  fetchDashboardIndexes,
} from "@/lib/stockSdk";

vi.mock("@/lib/stockSdk", () => ({
  fetchDashboardIndexes: vi.fn(),
  fetchDashboardDailyBars: vi.fn(),
  fetchDashboardIntradayBars: vi.fn(),
}));

vi.mock("@/components/charts/CandlestickChart", () => ({
  CandlestickChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="candlestick-chart" data-count={data.length} />
  ),
}));

vi.mock("@/components/charts/IntradayChart", () => ({
  IntradayChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="intraday-chart" data-count={data.length} />
  ),
}));

const indexes = [
  {
    code: "000001",
    symbol: "sh000001",
    name: "上证指数",
    price: 3200,
    changePct: 0.5,
    changeAmt: 16,
    source: "test",
    stale: false,
  },
  {
    code: "399001",
    symbol: "sz399001",
    name: "深证成指",
    price: 10000,
    changePct: -0.25,
    changeAmt: -25,
    source: "test",
    stale: false,
  },
];

const bars = [
  {
    time: "2026-07-13",
    open: 3180,
    close: 3200,
    high: 3210,
    low: 3175,
    volume: 100000,
  },
];

const mockFetchIndexes = vi.mocked(fetchDashboardIndexes);
const mockFetchDailyBars = vi.mocked(fetchDashboardDailyBars);
const mockFetchIntradayBars = vi.mocked(fetchDashboardIntradayBars);

function SearchParamsProbe() {
  const { search } = useLocation();
  return <output data-testid="search-params">{search}</output>;
}

function renderIndices(initialEntry = "/indices") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Indices />
      <SearchParamsProbe />
    </MemoryRouter>,
  );
}

describe("Indices page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    vi.clearAllMocks();
    mockFetchIndexes.mockResolvedValue({
      data: indexes,
      asOf: "2026-07-14T09:30:00Z",
      stale: false,
    });
    mockFetchDailyBars.mockResolvedValue({
      data: bars,
      asOf: "2026-07-14T09:30:00Z",
      stale: false,
    });
    mockFetchIntradayBars.mockResolvedValue({
      data: [
        {
          time: "2026-07-14T09:31:00",
          open: 3180,
          close: 3190,
          high: 3195,
          low: 3175,
          volume: 10_000,
        },
      ],
      asOf: "2026-07-14T09:31:00Z",
      stale: false,
    });
  });

  it("uses the full available page width", () => {
    const { container } = renderIndices();

    expect(container.firstElementChild).toHaveClass("w-full");
    expect(container.firstElementChild).not.toHaveClass("max-w-[1440px]");
  });

  it("selects the first supported index and loads its daily history by default", async () => {
    renderIndices();

    expect(await screen.findByRole("heading", { name: "上证指数" })).toBeInTheDocument();
    await waitFor(() => {
      expect(mockFetchDailyBars).toHaveBeenCalledWith("sh000001");
    });
    expect(screen.getByRole("button", { name: /上证指数 000001/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("candlestick-chart")).toHaveAttribute("data-count", "1");
  });

  it("renders a current-day intraday chart below the selected index K-line", async () => {
    renderIndices();

    await waitFor(() => {
      expect(mockFetchIntradayBars).toHaveBeenCalledWith("sh000001");
    });
    expect(await screen.findByTestId("intraday-chart")).toHaveAttribute(
      "data-count",
      "1",
    );
  });

  it("uses the symbol search parameter as the selected index", async () => {
    renderIndices("/indices?symbol=399001");

    expect(await screen.findByRole("heading", { name: "深证成指" })).toBeInTheDocument();
    await waitFor(() => {
      expect(mockFetchDailyBars).toHaveBeenCalledWith("sz399001");
    });
    expect(screen.getByRole("button", { name: /深证成指 399001/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps a normalized URL while requesting qualified daily history after selecting an index", async () => {
    const user = userEvent.setup();
    renderIndices();

    await user.click(await screen.findByRole("button", { name: /深证成指 399001/i }));

    await waitFor(() => {
      expect(mockFetchDailyBars).toHaveBeenLastCalledWith("sz399001");
    });
    expect(screen.getByTestId("search-params")).toHaveTextContent("?symbol=399001");
    expect(screen.getByRole("button", { name: /深证成指 399001/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows an unavailable state instead of a chart when selected daily history is empty", async () => {
    mockFetchDailyBars.mockResolvedValue({
      data: [],
      asOf: "2026-07-14T09:30:00Z",
      stale: false,
    });

    renderIndices();

    expect(await screen.findByText("暂无日线数据")).toBeInTheDocument();
    expect(screen.queryByTestId("candlestick-chart")).not.toBeInTheDocument();
  });

  it("shows a market summary for the loaded indices", async () => {
    renderIndices();

    expect(await screen.findByText("显示 2 / 2")).toBeInTheDocument();
    expect(screen.getAllByText("上涨").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("下跌").length).toBeGreaterThanOrEqual(1);
  });

  it("filters the index list by name without changing the selected detail", async () => {
    const user = userEvent.setup();
    renderIndices();

    const search = await screen.findByRole("searchbox", { name: "搜索指数" });
    await user.type(search, "深证");

    expect(screen.getByRole("button", { name: /深证成指 399001/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /上证指数 000001/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "上证指数" })).toBeInTheDocument();
  });
});
