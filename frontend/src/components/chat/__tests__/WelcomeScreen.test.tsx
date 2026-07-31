import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach } from "vitest";
import i18n from "@/i18n";
import { WelcomeScreen } from "../WelcomeScreen";

describe("WelcomeScreen", () => {
  const onExample = vi.fn();

  beforeEach(async () => {
    onExample.mockClear();
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("renders the title", () => {
    render(<WelcomeScreen onExample={onExample} />);
    expect(screen.getByText("Trading Worker")).toBeInTheDocument();
  });

  it("renders the Trading Worker logo", () => {
    render(<WelcomeScreen onExample={onExample} />);
    expect(screen.getByRole("img", { name: "Trading Worker" })).toHaveAttribute(
      "src",
      "/trading-worker-logo.png",
    );
  });

  it("renders capability chips", () => {
    render(<WelcomeScreen onExample={onExample} />);
    expect(screen.getByText("Finance Skills Library")).toBeInTheDocument();
    expect(screen.getByText("Swarm Agent Teams")).toBeInTheDocument();
    expect(screen.getByText("Shadow Account Backtest")).toBeInTheDocument();
  });

  it("renders example categories", () => {
    render(<WelcomeScreen onExample={onExample} />);
    expect(screen.getByText("A-Share Backtest")).toBeInTheDocument();
    expect(screen.getByText("Research & Analysis")).toBeInTheDocument();
    expect(screen.getByText("Swarm Teams")).toBeInTheDocument();
  });

  it("calls onExample with prompt when an example button is clicked", async () => {
    render(<WelcomeScreen onExample={onExample} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("A-Share Portfolio Optimization"));
    expect(onExample).toHaveBeenCalledTimes(1);
    expect(onExample).toHaveBeenCalledWith(
      expect.stringContaining("risk-parity portfolio"),
    );
  });

  it("renders the helper text", () => {
    render(<WelcomeScreen onExample={onExample} />);
    expect(screen.getByText("Describe a trading strategy to get started.")).toBeInTheDocument();
    expect(screen.getByText("Try an example:")).toBeInTheDocument();
  });
});
