import { render, screen } from "@testing-library/react";
import { AgentAvatar } from "../AgentAvatar";

describe("AgentAvatar", () => {
  it("renders the Trading Worker logo", () => {
    render(<AgentAvatar />);
    expect(screen.getByRole("img", { name: "Trading Worker" })).toHaveAttribute(
      "src",
      "/trading-worker-logo.png",
    );
  });
});
