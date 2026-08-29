import { useToast } from "../../composables/useToast";

import { mount, flushPromises } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import type { AdItem, PublicConfig, StatusReport } from "../../ipc/types";

// jsdom 25 的 <dialog> 缺 showModal/close,与 App.test 同款 stub
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  },
  close: {
    configurable: true,
    value(this: HTMLDialogElement, returnValue = "") {
      this.open = false;
      if (returnValue) this.returnValue = returnValue;
    },
  },
});

// vi.mock 工厂在提升阶段执行，变量必须通过 vi.hoisted() 声明
const mocks = vi.hoisted(() => ({
  consoleStatus: vi.fn(async (): Promise<StatusReport> => ({
    env: "ready" as const,
    service_running: false,
    port: null,
  })),
  consoleStartService: vi.fn(async () => 8899),
  consoleOpenWebui: vi.fn(async () => true),
  consoleCustomLlmReadiness: vi.fn(async () => ({ customConfigured: false })),
  consoleLoginActivateVip: vi.fn(async () => null as number | null),
  consoleAuthStatus: vi.fn(async () => ({
    authenticated: false,
    userInfo: null,
    expireAt: 0,
  })),
  consoleLoginCaptcha: vi.fn(async () => ({
    captchaId: "c1",
    data: "data:image/svg+xml;base64,AA==",
  })),
  consoleLoginSendSms: vi.fn(async () => ({ message: "" })),
  consoleLoginByPhone: vi.fn(async (_phone: string, _code: string) => ({
    userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1, loginType: 2 },
    hasPassword: true,
    expireAt: 9999999999,
    message: "登录成功",
  })),
  consoleLoginByPassword: vi.fn(async (_phone: string, _password: string) => ({
    userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1, loginType: 2 },
    hasPassword: true,
    expireAt: 9999999999,
    message: "登录成功",
  })),
  consoleLoginRegister: vi.fn(async (_phone: string, _smsCode: string, _password: string) => ({
    userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1, loginType: 2 },
    hasPassword: true,
    expireAt: 9999999999,
    message: "注册成功",
  })),
  consoleLoginSetPassword: vi.fn(async (_password: string) => {}),
  consoleFetchAds: vi.fn(async (): Promise<AdItem[]> => []),
  consoleOpenExternalUrl: vi.fn(async () => {}),
  consoleGetPublicConfig: vi.fn(async (): Promise<PublicConfig> => ({
    officialUrl: "",
    enableLogin: true,
    checkUpdate: false,
    enableService: false,
    serviceQrCode: "",
    kefuQrCode: "",
    rewardQrCode: "",
    enableAd: true,
    imgBase: "",
  })),
}));

vi.mock("../../ipc/commands", () => ({
  consoleStatus: mocks.consoleStatus,
  consoleStartService: mocks.consoleStartService,
  consoleOpenWebui: mocks.consoleOpenWebui,
  consoleCustomLlmReadiness: mocks.consoleCustomLlmReadiness,
  consoleLoginActivateVip: mocks.consoleLoginActivateVip,
  consoleAuthStatus: mocks.consoleAuthStatus,
  consoleLoginCaptcha: mocks.consoleLoginCaptcha,
  consoleLoginSendSms: mocks.consoleLoginSendSms,
  consoleLoginByPhone: mocks.consoleLoginByPhone,
  consoleLoginByPassword: mocks.consoleLoginByPassword,
  consoleLoginRegister: mocks.consoleLoginRegister,
  consoleLoginSetPassword: mocks.consoleLoginSetPassword,
  consoleFetchAds: mocks.consoleFetchAds,
  consoleOpenExternalUrl: mocks.consoleOpenExternalUrl,
  consoleGetPublicConfig: mocks.consoleGetPublicConfig,
}));

import LoginPage from "../LoginPage.vue";
import { useAuthStore } from "../../stores/auth";
import { useEnvStore } from "../../stores/env";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<div>home</div>" } },
    { path: "/login", component: LoginPage },
    { path: "/settings", component: { template: "<div>settings</div>" } },
  ],
});

beforeEach(async () => {
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.consoleStatus.mockResolvedValue({
    env: "ready",
    service_running: false,
    port: null,
  });
  mocks.consoleStartService.mockResolvedValue(8899);
  mocks.consoleOpenWebui.mockResolvedValue(true);
  mocks.consoleCustomLlmReadiness.mockResolvedValue({ customConfigured: false });
  mocks.consoleLoginActivateVip.mockResolvedValue(null);
  setActivePinia(createPinia());
  await router.push("/login");
  await router.isReady();
});

describe("LoginPage", () => {
  it("continues to settings without starting an already running local service", async () => {
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready",
      service_running: true,
      port: 8899,
    });
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="continue-custom"]').trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/settings");
    expect(mocks.consoleStartService).not.toHaveBeenCalled();
    expect(mocks.consoleOpenWebui).not.toHaveBeenCalled();
  });

  it("continues directly to research when custom LLM is already configured", async () => {
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready",
      service_running: true,
      port: 8899,
    });
    mocks.consoleCustomLlmReadiness.mockResolvedValueOnce({ customConfigured: true });
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="continue-custom"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleCustomLlmReadiness).toHaveBeenCalledTimes(1);
    expect(mocks.consoleOpenWebui).toHaveBeenCalledWith(8899);
    expect(router.currentRoute.value.path).toBe("/");
  });

  it("starts a stopped local service without opening WebUI before continuing to settings", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="continue-custom"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleStartService).toHaveBeenCalledTimes(1);
    expect(mocks.consoleOpenWebui).not.toHaveBeenCalled();
    expect(useEnvStore().port).toBe(8899);
    expect(router.currentRoute.value.path).toBe("/settings");
  });

  it("starts a stopped local service and goes to research when custom LLM is configured", async () => {
    mocks.consoleCustomLlmReadiness.mockResolvedValueOnce({ customConfigured: true });
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="continue-custom"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleCustomLlmReadiness).toHaveBeenCalledTimes(1);
    expect(mocks.consoleOpenWebui).toHaveBeenCalledWith(8899);
    expect(router.currentRoute.value.path).toBe("/");
  });

  it("keeps the login route and shows the startup error when custom continuation fails", async () => {
    mocks.consoleStartService.mockRejectedValueOnce(new Error("服务启动失败"));
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="continue-custom"]').trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/login");
    expect(useToast().toasts.value.some((t) => t.kind === "error" && t.message.includes("服务启动失败"))).toBe(true);
  });

  it("keeps the login route and shows the readiness error when custom LLM status fails", async () => {
    mocks.consoleStatus.mockResolvedValueOnce({
      env: "ready",
      service_running: true,
      port: 8899,
    });
    mocks.consoleCustomLlmReadiness.mockRejectedValueOnce(new Error("配置状态读取失败"));
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="continue-custom"]').trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/login");
    expect(useToast().toasts.value.some((t) => t.kind === "error" && t.message.includes("配置状态读取失败"))).toBe(true);
  });

  it("redirects a remembered token-only session after restoring auth status", async () => {
    mocks.consoleAuthStatus.mockResolvedValueOnce({
      authenticated: true,
      userInfo: null,
      expireAt: 9999999999,
    });

    mount(LoginPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/");
  });

  it("redirects a fully restored session to the console", async () => {
    const auth = useAuthStore();
    auth.setFromLogin({
      userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1, loginType: 2 },
      expireAt: 9999999999,
    });

    mount(LoginPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/");
  });

  it("渲染两个 tab 且默认短信", () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    expect(w.text()).toContain("短信登录");
    expect(w.text()).toContain("密码登录");
    // 默认 tab=sms：应有"获取"验证码按钮
    expect(w.text()).toContain("获取");
  });

  it("登录后等待运行中的自定义服务切换到 VIP runtime", async () => {
    mocks.consoleLoginActivateVip.mockResolvedValueOnce(8899);
    const w = mount(LoginPage, { global: { plugins: [router] } });
    const inputs = w.findAll("input");
    await inputs[0]!.setValue("13800000000");
    await inputs[2]!.setValue("1234");
    await inputs[3]!.setValue("1234");
    await w.findAll("button").find((button) => button.text() === "登录")!.trigger("click");
    await flushPromises();

    expect(mocks.consoleLoginActivateVip).toHaveBeenCalledOnce();
    expect(useEnvStore().port).toBe(8899);
    expect(router.currentRoute.value.path).toBe("/");
  });

  it("进入注册页后隐藏登录方式切换", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="register-entry"]').trigger("click");

    expect(w.findAll('[role="tablist"]')).toHaveLength(0);
    expect(w.findAll('[data-test="back-to-login"]')).toHaveLength(1);
  });

  it("从注册页切回登录后记住登录保持默认勾选", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    // 默认勾选记住登录
    expect((w.get('[data-test="remember-login"]').element as HTMLInputElement).checked).toBe(true);

    await w.get('[data-test="register-entry"]').trigger("click");
    await w.get('[data-test="back-to-login"]').trigger("click");

    expect(
      (w.get('[data-test="remember-login"]').element as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("切换到密码 tab 后提交调 consoleLoginByPassword", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    // 点"密码登录" tab 切换
    const tabs = w.findAll(".tab");
    const pwdTab = tabs.find((b) => b.text().includes("密码登录"))!;
    await pwdTab.trigger("click");

    const inputs = w.findAll("input");
    // 手机号 + 密码
    await inputs[0]!.setValue("13800000000");
    await inputs[2]!.setValue("secret1");

    // 在密码 tab 下","登录"是 submit 按钮的唯一内容
    const submit = w.findAll("button").find((b) => b.text() === "登录")!;
    await submit.trigger("click");
    await flushPromises();

    expect(mocks.consoleLoginByPassword).toHaveBeenCalledWith(
      "13800000000",
      "secret1",
      true,
    );
  });

  it("勾选记住登录后将持久化请求传给密码登录 IPC", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    const pwdTab = w.findAll(".tab").find((button) => button.text().includes("密码登录"))!;
    await pwdTab.trigger("click");
    await w.get('[data-test="remember-login"]').setValue(true);

    const inputs = w.findAll("input");
    await inputs[0]!.setValue("13800000000");
    await inputs[2]!.setValue("secret1");
    await w.findAll("button").find((button) => button.text() === "登录")!.trigger("click");
    await flushPromises();

    expect(mocks.consoleLoginByPassword).toHaveBeenCalledWith(
      "13800000000",
      "secret1",
      true,
    );
  });

  it("密码登录成功后将 API 消息带到控制台", async () => {
    mocks.consoleLoginByPassword.mockResolvedValueOnce({
      userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1, loginType: 2 },
      hasPassword: true,
      expireAt: 9999999999,
      message: "欢迎回来",
    });
    const w = mount(LoginPage, { global: { plugins: [router] } });
    const pwdTab = w.findAll(".tab").find((button) => button.text().includes("密码登录"))!;
    await pwdTab.trigger("click");
    const inputs = w.findAll("input");
    await inputs[0]!.setValue("13800000000");
    await inputs[2]!.setValue("secret1");

    await w.findAll("button").find((button) => button.text() === "登录")!.trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.query.loginMessage).toBe("欢迎回来");
  });

  it("短信登录：手机号 11 位 + 4 位验证码后提交", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    const inputs = w.findAll("input");
    await inputs[0]!.setValue("13800000000"); // phone
    await inputs[2]!.setValue("abcd"); // captchaCode
    await inputs[3]!.setValue("1234"); // smsCode
    // 短信 tab 下","登录"是 submit 按钮的唯一内容
    const submit = w.findAll("button").find((b) => b.text() === "登录")!;
    await submit.trigger("click");
    await flushPromises();
    expect(mocks.consoleLoginByPhone).toHaveBeenCalledWith(
      "13800000000",
      "1234",
      true,
    );
  });

  it("获取验证码后显示 API 返回的成功消息", async () => {
    mocks.consoleLoginSendSms.mockResolvedValueOnce({ message: "验证码已发送" });
    const w = mount(LoginPage, { global: { plugins: [router] } });
    const inputs = w.findAll("input");
    await inputs[0]!.setValue("13800000000");
    await inputs[2]!.setValue("abcd");

    await w.find(".code-btn").trigger("click");
    await flushPromises();

    expect(useToast().toasts.value.some((t) => t.kind === "success" && t.message === "验证码已发送")).toBe(true);
  });

  it("获取验证码失败后保留 API 返回的错误消息", async () => {
    mocks.consoleLoginSendSms.mockRejectedValueOnce({ message: "图形验证码错误" });
    const w = mount(LoginPage, { global: { plugins: [router] } });
    const inputs = w.findAll("input");
    await inputs[0]!.setValue("13800000000");
    await inputs[2]!.setValue("abcd");

    await w.find(".code-btn").trigger("click");
    await flushPromises();

    expect(useToast().toasts.value.some((t) => t.kind === "error" && t.message === "图形验证码错误")).toBe(true);
  });

  it("注册页在密码和图形验证码都合法前禁用获取验证码", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="register-entry"]').trigger("click");
    await w.get('[data-test="register-phone"]').setValue("13800000000");
    await w.get('[data-test="register-password"]').setValue("weak");
    await w.get('[data-test="register-captcha"]').setValue("abcd");

    expect(w.get('[data-test="register-send-code"]').attributes("disabled")).toBeDefined();
  });

  it("注册页拒绝不含大写字母的密码", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="register-entry"]').trigger("click");
    await w.get('[data-test="register-phone"]').setValue("13800000000");
    await w.get('[data-test="register-captcha"]').setValue("abcd");
    await w.get('[data-test="register-password"]').setValue("passw0rd");

    expect(w.get('[data-test="register-send-code"]').attributes("disabled")).toBeDefined();
  });

  it("完整注册表单调用注册 IPC", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="register-entry"]').trigger("click");
    await w.get('[data-test="register-phone"]').setValue("13800000000");
    await w.get('[data-test="register-password"]').setValue("Passw0rd!");
    await w.get('[data-test="register-captcha"]').setValue("abcd");
    await w.get('[data-test="register-sms"]').setValue("1234");
    await w.get('[data-test="register-submit"]').trigger("click");
    await flushPromises();

    expect(mocks.consoleLoginRegister).toHaveBeenCalledWith(
      "13800000000",
      "1234",
      "Passw0rd!",
    );
  });

  it("密码输入框支持显示/隐藏切换", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    const pwdTab = w.findAll(".tab").find((b) => b.text().includes("密码登录"))!;
    await pwdTab.trigger("click");

    const input = w.get('input[autocomplete="current-password"]');
    expect(input.attributes("type")).toBe("password");

    await w.get(".pwd-toggle").trigger("click");
    expect(input.attributes("type")).toBe("text");

    await w.get(".pwd-toggle").trigger("click");
    expect(input.attributes("type")).toBe("password");
  });

  it("发送短信成功后以 toast 提醒而非内联文案", async () => {
    useToast().clear();
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('input[autocomplete="tel"]').setValue("13800000000");
    await w.get('input[autocomplete="off"]').setValue("abcd");
    await w.findAll(".code-btn")[0].trigger("click");
    await flushPromises();

    const { toasts } = useToast();
    expect(toasts.value.some((t) => t.kind === "success" && t.message.includes("验证码已发送"))).toBe(true);
    expect(w.find("p.notice").exists()).toBe(false);
  });

  it("登录页公告:接口返回多条公告时,弹出可关闭模态窗,一条一行", async () => {
    mocks.consoleFetchAds.mockResolvedValueOnce([
      {
        id: 1,
        title: "维护公告",
        type: 2,
        position: "loginNotice",
        content: "平台将于今晚 23:00 停机维护",
        link: null,
        sort: 1,
      },
      {
        id: 2,
        title: "热门活动",
        type: 2,
        position: "loginNotice",
        content: "注册即送专业会员",
        link: null,
        sort: 2,
      },
    ]);
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(w.find('[data-test="login-notice-modal"]').exists()).toBe(true);
    expect(w.findAll(".notice-row")).toHaveLength(2);
    expect(w.text()).toContain("平台将于今晚 23:00 停机维护");
    expect(w.text()).toContain("注册即送专业会员");

    await w.get('[data-test="login-notice-ok"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="login-notice-modal"]').exists()).toBe(false);
  });

  it("登录页公告:带链接的行点击拉起系统浏览器", async () => {
    mocks.consoleFetchAds.mockResolvedValueOnce([
      {
        id: 2,
        title: "热门活动",
        type: 2,
        position: "loginNotice",
        content: "热门活动",
        link: "https://new.ailjf.cc/",
        sort: 0,
      },
    ]);
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await flushPromises();

    await w.get(".notice-row--link").trigger("click");
    expect(mocks.consoleOpenExternalUrl).toHaveBeenCalledWith("https://new.ailjf.cc/");
  });

  it("登录页公告:接口无公告时不弹窗", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(w.find('[data-test="login-notice-modal"]').exists()).toBe(false);
  });

  it("登录页公告:每次应用运行只展示一次,再次进入页面不重复弹窗", async () => {
    mocks.consoleFetchAds.mockResolvedValue([
      {
        id: 1,
        title: "维护公告",
        type: 2,
        position: "loginNotice",
        content: "平台将于今晚 23:00 停机维护",
        link: null,
        sort: 1,
      },
    ]);

    const first = mount(LoginPage, { global: { plugins: [router] } });
    await flushPromises();
    expect(first.find('[data-test="login-notice-modal"]').exists()).toBe(true);
    await first.get('[data-test="login-notice-ok"]').trigger("click");
    await flushPromises();
    first.unmount();

    // 同一次应用运行内重新进入登录页:不再弹
    await router.push("/settings");
    await router.push("/login");
    const second = mount(LoginPage, { global: { plugins: [router] } });
    await flushPromises();
    expect(second.find('[data-test="login-notice-modal"]').exists()).toBe(false);
    second.unmount();

    // 完全退出应用再启动 = 清空 sessionStorage:重新弹
    sessionStorage.clear();
    const third = mount(LoginPage, { global: { plugins: [router] } });
    await flushPromises();
    expect(third.find('[data-test="login-notice-modal"]').exists()).toBe(true);
  });
});
