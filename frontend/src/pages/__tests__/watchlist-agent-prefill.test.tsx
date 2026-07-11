import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Mock i18n
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k }),
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

// Mock watchlist store
vi.mock("@/stores/watchlist");
import { useWatchlistStore } from "@/stores/watchlist";
const mockStore = vi.mocked(useWatchlistStore);

// Minimal Agent stub that reads prefill
function AgentStub() {
  const [searchParams] = (function() {
    const { useSearchParams } = require("react-router-dom") as typeof import("react-router-dom");
    return [useSearchParams()];
  })();
  const prefill = searchParams[0].get("prefill");
  return <div data-testid="agent-input">{prefill ?? ""}</div>;
}

import WatchlistPage from "../Watchlist";

function renderWatchlistWithAgent(storeState: Record<string, unknown> = {}) {
  mockStore.mockReturnValue({
    stocks: [{ code: "000001", name: "平安银行", market: "a_stock", added_at: "" }],
    quotes: { "000001": { code: "000001", name: "平安银行", price: 10.5, change_pct: 1.2, change_amt: 0.12 } },
    selected: new Set(["000001"]) as Set<string>,
    loading: false,
    error: null,
    refresh: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    refreshQuotes: vi.fn(),
    toggleSelection: vi.fn(),
    clearSelection: vi.fn(),
    ...storeState,
  } as ReturnType<typeof useWatchlistStore>);

  return render(
    <MemoryRouter initialEntries={["/watchlist"]}>
      <Routes>
        <Route path="/watchlist" element={<WatchlistPage />} />
        <Route path="/agent" element={<AgentStub />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("Watchlist → Agent prefill integration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clicking Send to Agent navigates to /agent with prefill param", async () => {
    renderWatchlistWithAgent();
    const sendBtn = screen.getByTestId("send-to-agent");
    await act(async () => { fireEvent.click(sendBtn); });
    // After navigation, AgentStub renders with prefill value
    const agentInput = screen.getByTestId("agent-input");
    expect(agentInput.textContent).toContain("000001");
    expect(agentInput.textContent).toContain("平安银行");
  });

  it("no prefill navigates cleanly — existing no-param behavior unchanged", () => {
    renderWatchlistWithAgent({
      stocks: [],
      quotes: {},
      selected: new Set<string>(),
    });
    // No send-to-agent button when nothing selected
    expect(screen.queryByTestId("send-to-agent")).toBeNull();
  });
});
