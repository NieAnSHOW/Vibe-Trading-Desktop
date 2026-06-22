// src/pages/profile/__tests__/Profile.test.tsx
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { Profile } from "../Profile";
import { useAuthStore } from "@/stores/auth";
import { apiUser } from "@/lib/apiUser";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderProfile() {
  return render(<MemoryRouter><Profile /></MemoryRouter>);
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({
    status: "authenticated",
    token: "t",
    userInfo: {
      id: 1, nickName: "Neo", phone: "13800001234", gender: 1, status: 1, loginType: 2,
      avatarUrl: null, description: "",
    } as any,
    expiresAt: Date.now() + 1e6,
  });
  vi.restoreAllMocks();
});

describe("Profile page", () => {
  it("masks phone number (138****1234)", async () => {
    renderProfile();
    await waitFor(() => expect(screen.getByText(/138\*+1234/)).toBeInTheDocument());
  });

  it("saves nickname via updatePerson", async () => {
    const upd = vi.spyOn(apiUser, "updatePerson").mockResolvedValue({
      id: 1, nickName: "Neo2", phone: "13800001234", gender: 1, status: 1, loginType: 2,
    } as any);
    const { userEvent } = await import("@testing-library/user-event");

    renderProfile();
    const input = screen.getByDisplayValue("Neo");
    await userEvent.clear(input);
    await userEvent.type(input, "Neo2");
    await userEvent.click(screen.getByRole("button", { name: /profile.save/ }));

    await waitFor(() => expect(upd).toHaveBeenCalledWith(expect.objectContaining({ nickName: "Neo2" })));
  });

  it("shows logout button", async () => {
    renderProfile();
    await waitFor(() => expect(screen.getByText("profile.logout")).toBeInTheDocument());
  });
});
