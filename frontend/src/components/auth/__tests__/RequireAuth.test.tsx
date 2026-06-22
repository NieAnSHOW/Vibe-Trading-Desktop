// src/components/auth/__tests__/RequireAuth.test.tsx
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { RequireAuth } from "../RequireAuth";
import { useAuthStore } from "@/stores/auth";

function setup(status: "loading" | "guest" | "authenticated") {
  useAuthStore.setState({ status } as any);
  return render(
    <MemoryRouter initialEntries={["/profile"]}>
      <Routes>
        <Route path="/login" element={<div>login page</div>} />
        <Route element={<RequireAuth />}>
          <Route path="/profile" element={<div>profile page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ token: null, refreshToken: null, userInfo: null, expiresAt: null, status: "guest" });
});

describe("RequireAuth", () => {
  it("shows loading when status=loading", () => {
    setup("loading");
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("redirects to /login when guest", () => {
    setup("guest");
    expect(screen.getByText("login page")).toBeInTheDocument();
    expect(screen.queryByText("profile page")).toBeNull();
  });

  it("renders outlet when authenticated", () => {
    useAuthStore.setState({
      status: "authenticated",
      token: "t",
      userInfo: { id: 1, gender: 0, status: 1, loginType: 2 },
    } as any);
    setup("authenticated");
    expect(screen.getByText("profile page")).toBeInTheDocument();
  });
});
