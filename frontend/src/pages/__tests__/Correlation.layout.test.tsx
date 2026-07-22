import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

vi.mock("@/components/charts/CorrelationMatrix", () => ({
  CorrelationMatrix: ({ labels }: { labels: string[] }) => (
    <div data-testid="correlation-matrix">{labels.join(",")}</div>
  ),
}));

import { Correlation } from "../Correlation";

describe("Correlation responsive layout contract", () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({ labels: ["000001.SZ"], matrix: [[1]] }),
      ),
    });
  });

  it("uses a two-column desktop workspace that stacks controls before results on mobile", () => {
    render(<Correlation />);

    expect(screen.getByTestId("correlation-workspace")).toHaveClass(
      "min-w-0",
      "lg:grid",
      "lg:grid-cols-[minmax(15rem,0.36fr)_minmax(0,1fr)]",
    );
    expect(screen.getByTestId("correlation-controls")).toHaveClass(
      "rounded-lg",
      "bg-card",
      "lg:overflow-auto",
    );
    expect(screen.getByTestId("correlation-results")).toHaveClass(
      "rounded-lg",
      "bg-card",
      "lg:overflow-auto",
    );
    expect(screen.getByTestId("correlation-windows")).toHaveClass("flex-wrap");
    expect(screen.getByTestId("correlation-methods")).toHaveClass("flex-wrap");
    expect(
      screen
        .getByTestId("correlation-controls")
        .compareDocumentPosition(screen.getByTestId("correlation-results")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps the correlation request on the existing compute action", async () => {
    const user = userEvent.setup();
    render(<Correlation />);

    await user.click(screen.getByRole("button", { name: "Compute" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/correlation?codes=000001.SZ%2C600519.SH%2C000858.SZ%2C601318.SH&days=90&method=pearson",
        expect.objectContaining({ headers: { "Content-Type": "application/json" } }),
      );
    });
    expect(await screen.findByTestId("correlation-matrix")).toHaveTextContent("000001.SZ");
  });

  it("keeps wrapped window and method selections in the compute request", async () => {
    const user = userEvent.setup();
    render(<Correlation />);

    await user.click(screen.getByRole("button", { name: "30d" }));
    await user.click(screen.getByRole("button", { name: "Spearman" }));
    await user.click(screen.getByRole("button", { name: "Compute" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/correlation?codes=000001.SZ%2C600519.SH%2C000858.SZ%2C601318.SH&days=30&method=spearman",
        expect.objectContaining({ headers: { "Content-Type": "application/json" } }),
      );
    });
  });
});
