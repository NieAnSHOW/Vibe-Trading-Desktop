import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { createPinia, setActivePinia } from "pinia";

// vi.mock 工厂在提升阶段执行，变量必须通过 vi.hoisted() 声明
const mocks = vi.hoisted(() => ({
  consoleLoginCaptcha: vi.fn(async () => ({
    captchaId: "c1",
    data: "data:image/svg+xml;base64,AA==",
  })),
  consoleLoginSendSms: vi.fn(async () => {}),
  consoleLoginByPhone: vi.fn(async (_phone: string, _code: string) => ({
    userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1, loginType: 2 },
    hasPassword: true,
    expireAt: 9999999999,
  })),
  consoleLoginByPassword: vi.fn(async (_phone: string, _password: string) => ({
    userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1, loginType: 2 },
    hasPassword: true,
    expireAt: 9999999999,
  })),
  consoleLoginRegister: vi.fn(async (_phone: string, _smsCode: string, _password: string) => ({
    userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1, loginType: 2 },
    hasPassword: true,
    expireAt: 9999999999,
  })),
  consoleLoginSetPassword: vi.fn(async (_password: string) => {}),
}));

vi.mock("../../ipc/commands", () => ({
  consoleLoginCaptcha: mocks.consoleLoginCaptcha,
  consoleLoginSendSms: mocks.consoleLoginSendSms,
  consoleLoginByPhone: mocks.consoleLoginByPhone,
  consoleLoginByPassword: mocks.consoleLoginByPassword,
  consoleLoginRegister: mocks.consoleLoginRegister,
  consoleLoginSetPassword: mocks.consoleLoginSetPassword,
}));

import LoginPage from "../LoginPage.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<div>home</div>" } },
    { path: "/login", component: LoginPage },
  ],
});

beforeEach(async () => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  await router.push("/login");
  await router.isReady();
});

describe("LoginPage", () => {
  it("渲染两个 tab 且默认短信", () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    expect(w.text()).toContain("短信登录");
    expect(w.text()).toContain("密码登录");
    // 默认 tab=sms：应有"获取"验证码按钮
    expect(w.text()).toContain("获取");
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
    await inputs[1]!.setValue("secret1");

    // 在密码 tab 下","登录"是 submit 按钮的唯一内容
    const submit = w.findAll("button").find((b) => b.text() === "登录")!;
    await submit.trigger("click");
    await flushPromises();

    expect(mocks.consoleLoginByPassword).toHaveBeenCalledWith(
      "13800000000",
      "secret1",
    );
  });

  it("短信登录：手机号 11 位 + 4 位验证码后提交", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    const inputs = w.findAll("input");
    await inputs[0]!.setValue("13800000000"); // phone
    await inputs[1]!.setValue("abcd"); // captchaCode
    await inputs[2]!.setValue("1234"); // smsCode
    // 短信 tab 下","登录"是 submit 按钮的唯一内容
    const submit = w.findAll("button").find((b) => b.text() === "登录")!;
    await submit.trigger("click");
    await flushPromises();
    expect(mocks.consoleLoginByPhone).toHaveBeenCalledWith(
      "13800000000",
      "1234",
    );
  });

  it("注册页在密码和图形验证码都合法前禁用获取验证码", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="register-tab"]').trigger("click");
    await w.get('[data-test="register-phone"]').setValue("13800000000");
    await w.get('[data-test="register-password"]').setValue("weak");
    await w.get('[data-test="register-captcha"]').setValue("abcd");

    expect(w.get('[data-test="register-send-code"]').attributes("disabled")).toBeDefined();
  });

  it("注册仅接受服务端规则的可打印 ASCII 密码", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="register-tab"]').trigger("click");
    await w.get('[data-test="register-phone"]').setValue("13800000000");
    await w.get('[data-test="register-captcha"]').setValue("abcd");
    await w.get('[data-test="register-password"]').setValue("Passw0rd! ");

    expect(w.get('[data-test="register-send-code"]').attributes("disabled")).toBeDefined();
  });

  it("完整注册表单调用注册 IPC", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.get('[data-test="register-tab"]').trigger("click");
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
});
