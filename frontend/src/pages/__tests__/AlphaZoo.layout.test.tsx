import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const listAlphas = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: { listAlphas },
}));

vi.mock("@/lib/telemetry", () => ({
  track: vi.fn(),
}));

import { AlphaZoo } from "../AlphaZoo";

describe("Alpha Zoo workspace layout", () => {
  beforeEach(() => {
    listAlphas.mockReset();
    listAlphas.mockResolvedValue({
      status: "ok",
      alphas: [
        {
          id: "alpha101_1",
          zoo: "alpha101",
          theme: ["momentum"],
          universe: ["csi300"],
          nickname: "Momentum signal",
          decay_horizon: 5,
        },
      ],
      total: 1,
      returned: 1,
      truncated: false,
    });
  });

  it("uses the responsive filter-and-catalogue workspace while preserving alpha links", async () => {
    render(
      <MemoryRouter initialEntries={["/alpha-zoo"]}>
        <AlphaZoo />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("alpha-zoo-workspace")).toHaveClass("w-full", "p-4", "md:p-6");
    expect(screen.getByTestId("alpha-zoo-filters")).toHaveClass(
      "rounded-lg",
      "bg-card",
      "lg:sticky",
    );
    expect(screen.getByTestId("alpha-zoo-catalogue")).toHaveClass(
      "min-w-0",
      "rounded-lg",
      "lg:overflow-auto",
    );

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "alpha101_1" })).toHaveAttribute(
        "href",
        "/alpha-zoo/alpha101_1",
      );
    });
  });
});
