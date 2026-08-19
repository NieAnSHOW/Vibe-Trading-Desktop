import { act, render, screen, waitFor } from "@testing-library/react";
import { Outlet, RouterProvider } from "react-router-dom";

vi.mock("@/components/layout/Layout", () => ({
  Layout: () => <Outlet />,
}));

vi.mock("@/pages/Runtime", () => ({
  Runtime: () => <div>Runtime page</div>,
}));

vi.mock("@/pages/Dashboard", () => ({
  default: () => <div>Dashboard page</div>,
}));

vi.mock("@/pages/Usage", () => ({
  Usage: () => <div>Usage page</div>,
}));

import { router } from "@/router";

describe("dashboard routes", () => {
  it("renders Dashboard at the root route", async () => {
    render(<RouterProvider router={router} />);

    await waitFor(() =>
      expect(screen.getByText("Dashboard page")).toBeInTheDocument(),
    );
  });
});

describe("legacy settings route", () => {
  it("redirects to runtime", async () => {
    render(<RouterProvider router={router} />);

    await act(async () => {
      await router.navigate("/settings");
    });

    await waitFor(() => expect(router.state.location.pathname).toBe("/runtime"));
    expect(screen.getByText("Runtime page")).toBeInTheDocument();
  });
});

describe("usage route", () => {
  it("lazy-loads the global usage center", async () => {
    render(<RouterProvider router={router} />);

    await act(async () => {
      await router.navigate("/usage");
    });

    expect(await screen.findByText("Usage page")).toBeInTheDocument();
  });
});
