// src/pages/auth/__tests__/Login.test.tsx
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { Login } from "../Login";
import { useAuthStore } from "@/stores/auth";
import { apiUser } from "@/lib/apiUser";

// Make toast non-disruptive
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/profile" element={<div>profile page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ token: null, refreshToken: null, userInfo: null, expiresAt: null, status: "guest" });
  vi.restoreAllMocks();
});

describe("Login page", () => {
  it("renders captcha on mount", async () => {
    vi.spyOn(apiUser, "getCaptcha").mockResolvedValue({ captchaId: "c1", data: "<svg/>" });
    renderLogin();
    await waitFor(() => expect(apiUser.getCaptcha).toHaveBeenCalled());
  });

  it("sends sms code with phone + captchaId + captcha input", async () => {
    const cap = vi.spyOn(apiUser, "getCaptcha").mockResolvedValue({ captchaId: "c1", data: "<svg/>" });
    const sms = vi.spyOn(apiUser, "sendSmsCode").mockResolvedValue(undefined);
    const { userEvent } = await import("@testing-library/user-event");

    renderLogin();
    await waitFor(() => expect(cap).toHaveBeenCalled());

    // phone
    const phoneInput = screen.getByPlaceholderText("13800000000");
    await userEvent.type(phoneInput, "13800000000");
    // captcha code
    const captchaInput = screen.getByPlaceholderText("abcd");
    await userEvent.type(captchaInput, "9a8b");
    // send code button (i18n key "auth.getCode")
    const sendBtn = screen.getByText(/获取验证码|Send code/);
    await userEvent.click(sendBtn);

    await waitFor(() => expect(sms).toHaveBeenCalledWith("13800000000", "c1", "9a8b"));
  });

  it("logs in and navigates to /profile", async () => {
    vi.spyOn(apiUser, "getCaptcha").mockResolvedValue({ captchaId: "c1", data: "<svg/>" });
    vi.spyOn(apiUser, "sendSmsCode").mockResolvedValue(undefined);
    const login = vi.spyOn(apiUser, "loginByPhone").mockResolvedValue({
      token: "T", refreshToken: "R", expire: 3600, refreshExpire: 7200, hasPassword: true,
    });
    const person = vi.spyOn(apiUser, "getPerson").mockResolvedValue({
      id: 1, nickName: "Neo", gender: 0, status: 1, loginType: 2,
    });
    const { userEvent } = await import("@testing-library/user-event");

    renderLogin();
    await waitFor(() => expect(screen.getByPlaceholderText("13800000000")).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText("13800000000"), "13800000000");
    await userEvent.type(screen.getByPlaceholderText("abcd"), "9a8b");
    // click send code
    await userEvent.click(screen.getByText(/获取验证码|Send code/));
    await waitFor(() => expect(login).not.toHaveBeenCalled()); // still need sms code

    // type sms code
    await userEvent.type(screen.getByPlaceholderText("1234"), "1234");
    // click submit button
    const submitBtn = screen.getByRole("button", { name: /登录 \/ 注册|Login \/ Register/ });
    await userEvent.click(submitBtn);

    await waitFor(() => expect(login).toHaveBeenCalledWith("13800000000", "1234"));
    await waitFor(() => expect(person).toHaveBeenCalled());
    expect(useAuthStore.getState().status).toBe("authenticated");
    await waitFor(() => expect(screen.getByText("profile page")).toBeInTheDocument());
  });

  it("switches to password tab and logs in via loginByPassword", async () => {
    vi.spyOn(apiUser, "getCaptcha").mockResolvedValue({ captchaId: "c1", data: "<svg/>" });
    const loginPwd = vi.spyOn(apiUser, "loginByPassword").mockResolvedValue({
      token: "T", refreshToken: "R", expire: 3600, refreshExpire: 7200, hasPassword: true,
    });
    vi.spyOn(apiUser, "getPerson").mockResolvedValue({
      id: 1, nickName: "Neo", gender: 0, status: 1, loginType: 2,
    });
    const { userEvent } = await import("@testing-library/user-event");

    renderLogin();
    await waitFor(() => expect(screen.getByPlaceholderText("13800000000")).toBeInTheDocument());

    // 切到密码登录 Tab
    await userEvent.click(screen.getByRole("button", { name: /密码登录|Password login/ }));

    // 密码 Tab 也有 phone 输入框
    await userEvent.type(screen.getByPlaceholderText("13800000000"), "13800000000");
    const pwdInputs = document.querySelectorAll('input[type="password"]');
    await userEvent.type(pwdInputs[0], "secret123");

    await userEvent.click(screen.getByRole("button", { name: /登录 \/ 注册|Login \/ Register/ }));

    await waitFor(() => expect(loginPwd).toHaveBeenCalledWith("13800000000", "secret123"));
    await waitFor(() => expect(screen.getByText("profile page")).toBeInTheDocument());
  });

  it("opens set-password modal when sms login returns hasPassword:false", async () => {
    vi.spyOn(apiUser, "getCaptcha").mockResolvedValue({ captchaId: "c1", data: "<svg/>" });
    vi.spyOn(apiUser, "sendSmsCode").mockResolvedValue(undefined);
    vi.spyOn(apiUser, "loginByPhone").mockResolvedValue({
      token: "T", refreshToken: "R", expire: 3600, refreshExpire: 7200, hasPassword: false,
    });
    vi.spyOn(apiUser, "getPerson").mockResolvedValue({
      id: 2, nickName: "New", gender: 0, status: 1, loginType: 2,
    });
    const { userEvent } = await import("@testing-library/user-event");

    renderLogin();
    await waitFor(() => expect(screen.getByPlaceholderText("13800000000")).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText("13800000000"), "13800000000");
    await userEvent.type(screen.getByPlaceholderText("abcd"), "9a8b");
    await userEvent.click(screen.getByText(/获取验证码|Send code/));
    await userEvent.type(screen.getByPlaceholderText("1234"), "1234");

    await userEvent.click(screen.getByRole("button", { name: /登录 \/ 注册|Login \/ Register/ }));

    // hasPassword:false → 弹出设密码 modal（标题可见），且未跳转 profile
    await waitFor(() =>
      expect(screen.getByText(/设置登录密码|Set login password/)).toBeInTheDocument()
    );
  });
});
