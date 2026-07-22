import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { Reports } from "../Reports";

const apiMock = vi.hoisted(() => ({
  listRuns: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

describe("Reports page", () => {
  beforeEach(() => {
    apiMock.listRuns.mockReset();
    return i18n.changeLanguage("en");
  });

  it("lists backtest reports newest first with Full Report links and skips non-report runs", async () => {
    apiMock.listRuns.mockResolvedValue([
      {
        run_id: "old-report",
        status: "success",
        created_at: "2026-06-01T00:00:00Z",
        prompt: "Old report",
        codes: ["MSFT"],
        total_return: 0.05,
        sharpe: 1.1,
      },
      {
        run_id: "chat-only",
        status: "success",
        created_at: "2026-06-03T00:00:00Z",
        prompt: "No metrics",
        codes: [],
      },
      {
        run_id: "new-report",
        status: "success",
        created_at: "2026-06-04T00:00:00Z",
        prompt: "New report",
        codes: ["AAPL"],
        total_return: 0.12,
        sharpe: 1.8,
      },
    ]);

    render(<Reports />, { wrapper: MemoryRouter });

    expect(await screen.findByRole("heading", { level: 1, name: "Backtest Report Library" })).toBeInTheDocument();
    expect(apiMock.listRuns).toHaveBeenCalledWith(100);
    expect(screen.queryByText("chat-only")).not.toBeInTheDocument();
    const reportRunLinks = screen.getAllByRole("link", { name: /-report$/ });
    expect(reportRunLinks[0]).toHaveAttribute("href", "/runs/new-report");
    expect(reportRunLinks[1]).toHaveAttribute("href", "/runs/old-report");
    const fullReportLinks = screen.getAllByRole("link", { name: "Full Report" });
    expect(fullReportLinks[0]).toHaveAttribute("href", "/runs/new-report");
    expect(fullReportLinks[1]).toHaveAttribute("href", "/runs/old-report");
  });

  it("filters reports by search text", async () => {
    apiMock.listRuns.mockResolvedValue([
      {
        run_id: "aapl-report",
        status: "success",
        created_at: "2026-06-04T00:00:00Z",
        prompt: "Apple strategy",
        codes: ["AAPL"],
        total_return: 0.12,
      },
      {
        run_id: "msft-report",
        status: "success",
        created_at: "2026-06-03T00:00:00Z",
        prompt: "Microsoft strategy",
        codes: ["MSFT"],
        total_return: 0.08,
      },
    ]);

    render(<Reports />, { wrapper: MemoryRouter });
    await screen.findByText("aapl-report");

    fireEvent.change(screen.getByPlaceholderText("Search run id, prompt, symbol, status..."), {
      target: { value: "MSFT" },
    });

    expect(screen.queryByText("aapl-report")).not.toBeInTheDocument();
    expect(screen.getByText("msft-report")).toBeInTheDocument();
  });

  it("shows summary metrics and clears every report filter", async () => {
    apiMock.listRuns.mockResolvedValue([
      {
        run_id: "winning-report",
        status: "success",
        created_at: "2026-06-04T00:00:00Z",
        prompt: "Winning strategy",
        codes: ["AAPL"],
        total_return: 0.12,
        sharpe: 1.8,
      },
      {
        run_id: "failed-report",
        status: "failed",
        created_at: "2026-06-03T00:00:00Z",
        prompt: "Failed strategy",
        codes: ["MSFT"],
        total_return: -0.03,
        sharpe: -0.4,
      },
    ]);

    render(<Reports />, { wrapper: MemoryRouter });

    const overview = await screen.findByRole("region", { name: "Report overview" });
    expect(overview).toHaveTextContent("Reports");
    expect(overview).toHaveTextContent("Success");
    expect(overview).toHaveTextContent("+4.50%");
    expect(overview).toHaveTextContent("+0.70");

    fireEvent.change(screen.getByRole("combobox", { name: "All statuses" }), {
      target: { value: "failed" },
    });
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-12-31" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
      target: { value: "sharpe_desc" },
    });
    fireEvent.change(screen.getByPlaceholderText("Search run id, prompt, symbol, status..."), {
      target: { value: "missing" },
    });
    expect(screen.getByText("No matching reports")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("winning-report")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search run id, prompt, symbol, status...")).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "All statuses" })).toHaveValue("all");
    expect(screen.getByLabelText("Start date")).toHaveValue("");
    expect(screen.getByLabelText("End date")).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("created_desc");
  });

  it("uses Reports-owned translations for workspace regions and filter reset", async () => {
    apiMock.listRuns.mockResolvedValue([
      {
        run_id: "localized-report",
        status: "success",
        created_at: "2026-06-04T00:00:00Z",
        prompt: "Localized strategy",
        codes: ["AAPL"],
        total_return: 0.12,
      },
    ]);
    await i18n.changeLanguage("ja");

    render(<Reports />, { wrapper: MemoryRouter });
    await screen.findByText("localized-report");

    expect(screen.getByRole("region", { name: "レポートの概要" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("実行ID、プロンプト、シンボル、状態を検索..."), {
      target: { value: "missing" },
    });

    expect(screen.getByRole("button", { name: "フィルターをクリア" })).toBeInTheDocument();
  });
});
