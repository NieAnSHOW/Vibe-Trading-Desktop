import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Home } from "@/pages/Home";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

const mockStore = {
  summary: {
    available: true,
    summary: {
      headline: "风险偏好回升",
      drivers: ["外资流入"],
      risks: ["地缘风险"],
      focus: ["消费板块"],
    },
    stale: false,
  },
  summaryLoading: false,
  summaryError: null as string | null,
  initialize: vi.fn(),
  refreshSummary: vi.fn(),
};

vi.mock("@/stores/marketDashboard", () => ({
  useMarketDashboardStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}));

describe("Home AI summary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the migrated AI summary and initializes market data", () => {
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    );

    expect(screen.getByText("风险偏好回升")).toBeInTheDocument();
    expect(mockStore.initialize).toHaveBeenCalledOnce();
  });

  it("refreshes the migrated summary from Home", async () => {
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "dashboard.refreshSummary" }));
    });

    expect(mockStore.refreshSummary).toHaveBeenCalledWith(true);
  });
});
