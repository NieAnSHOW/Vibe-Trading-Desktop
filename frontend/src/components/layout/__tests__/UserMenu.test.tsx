// src/components/layout/__tests__/UserMenu.test.tsx
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { UserMenu } from "../UserMenu";
import { useAuthStore } from "@/stores/auth";

function renderMenu() {
  return render(
    <MemoryRouter>
      <UserMenu />
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ token: null, refreshToken: null, userInfo: null, expiresAt: null, status: "guest" });
});

describe("UserMenu", () => {
  it("shows login link when guest", () => {
    renderMenu();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/login");
  });

  it("shows nickname when authenticated", () => {
    useAuthStore.setState({
      status: "authenticated",
      token: "t",
      userInfo: { id: 1, nickName: "Neo", gender: 0, status: 1, loginType: 2 } as any,
    });
    renderMenu();
    // 按钮包含昵称
    expect(screen.getByText("Neo")).toBeInTheDocument();
  });

  it("dropdown appears after clicking toggle button", async () => {
    const { userEvent } = await import("@testing-library/user-event");
    useAuthStore.setState({
      status: "authenticated",
      token: "t",
      userInfo: { id: 1, nickName: "Neo", gender: 0, status: 1, loginType: 2 } as any,
    });
    renderMenu();
    // 点击展开按钮
    const toggle = screen.getByRole("button");
    await userEvent.click(toggle);
    // 下拉出现后应该有 logout 按钮（i18n key 为 userMenu.logout）
    expect(screen.getByText("userMenu.logout")).toBeInTheDocument();
  });
});
