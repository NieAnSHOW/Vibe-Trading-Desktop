import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { Home } from "../Home";

describe("Home page", () => {
  beforeEach(() => {
    i18n.changeLanguage("en");
  });

  it("presents a research desk entry point with primary actions", () => {
    render(<Home />, { wrapper: MemoryRouter });

    expect(screen.getByRole("heading", { name: "Vibe-Trading" })).toBeInTheDocument();
    expect(screen.getByText("Research desk")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Start research/i })).toHaveAttribute(
      "href",
      "/agent",
    );
    expect(screen.getByRole("link", { name: /Review reports/i })).toHaveAttribute(
      "href",
      "/reports",
    );
  });

  it("surfaces workflows and runtime safety boundaries", () => {
    render(<Home />, { wrapper: MemoryRouter });

    expect(screen.getByText("Today on the desk")).toBeInTheDocument();
    expect(screen.getByText("Runtime stays read-only here")).toBeInTheDocument();
    expect(screen.getByText("Mandate-gated broker actions")).toBeInTheDocument();
  });
});
