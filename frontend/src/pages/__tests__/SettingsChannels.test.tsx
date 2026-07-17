import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { Settings } from "../Settings";

// ponytail: local Settings uses useNavigate() for auth redirects (fork
// customization upstream doesn't have), so render inside a Router.

const apiMock = vi.hoisted(() => ({
  getLLMSettings: vi.fn(),
  getDataSourceSettings: vi.fn(),
  getChannelStatus: vi.fn(),
  startChannels: vi.fn(),
  stopChannels: vi.fn(),
  runChannelPairingCommand: vi.fn(),
  getVipModels: vi.fn(),
  updateLLMSettings: vi.fn(),
  updateDataSourceSettings: vi.fn(),
  startWeixinLogin: vi.fn(),
  weixinLoginStatus: vi.fn(),
  // ponytail: fork-only OptionalDepsManager (desktop optional-deps UI) calls
  // these; upstream's mock doesn't include them.
  listOptionalDeps: vi.fn(() => Promise.resolve({ brokers: [] })),
  getOptionalDepsMirror: vi.fn(() => Promise.resolve({})),
  installOptionalDep: vi.fn(),
  optionalDepStatusUrl: vi.fn((jobId: string) => `http://localhost:8899/optional-deps/status/${jobId}`),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: apiMock,
    isAuthRequiredError: vi.fn(() => false),
  };
});

vi.mock("@/lib/apiAuth", () => ({
  getApiAuthKey: vi.fn(() => ""),
  setApiAuthKey: vi.fn(),
}));

function llmSettings() {
  return {
    provider: "openrouter",
    model_name: "deepseek/deepseek-v3.2",
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
    api_key_configured: false,
    api_key_required: true,
    temperature: 0.1,
    timeout_seconds: 120,
    max_retries: 2,
    reasoning_effort: "",
    sse_timeout_seconds: 300,
    env_path: "agent/.env",
    providers: [
      {
        name: "openrouter",
        label: "OpenRouter",
        api_key_env: "OPENROUTER_API_KEY",
        base_url_env: "OPENROUTER_BASE_URL",
        default_model: "deepseek/deepseek-v3.2",
        default_base_url: "https://openrouter.ai/api/v1",
        api_key_required: true,
        auth_type: "api_key",
      },
    ],
  };
}

function dataSourceSettings() {
  return {
    tushare_token_configured: false,
    baostock_supported: true,
    baostock_installed: true,
    baostock_message: "BaoStock available",
    env_path: "agent/.env",
  };
}

function vipLlmSettings() {
  return {
    ...llmSettings(),
    provider: "vip_server",
    model_name: "deepseek-v4-flash",
    base_url: "https://vip.example/v1",
    api_key_env: "VIP_API_KEY",
    providers: [
      {
        name: "vip_server",
        label: "VIP Server",
        api_key_env: "VIP_API_KEY",
        base_url_env: "VIP_BASE_URL",
        default_model: "deepseek-v4-flash",
        default_base_url: "https://vip.example/v1",
        api_key_required: true,
        auth_type: "api_key",
      },
    ],
  };
}

function channelStatus(overrides = {}) {
  return {
    running: false,
    inbound_queue: 0,
    outbound_queue: 0,
    session_count: 0,
    channels: {
      // ponytail: WebUI 仅展示微信渠道(其他 IM 渠道暂不开放),mock 反映这个默认现实
      weixin: {
        name: "weixin",
        display_name: "WeChat",
        configured: true,
        enabled: true,
        available: true,
        loaded: true,
        running: false,
        error: "",
        install_hint: "",
      },
    },
    ...overrides,
  };
}

describe("Settings IM channels panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ponytail: fork tests mutate the global i18n language; this suite asserts
    // English copy, so reset to "en" for isolation in the full-suite run.
    i18n.changeLanguage("en");
    window.localStorage.clear();
    apiMock.getLLMSettings.mockResolvedValue(llmSettings());
    apiMock.getDataSourceSettings.mockResolvedValue(dataSourceSettings());
    apiMock.getChannelStatus.mockResolvedValue(channelStatus());
    apiMock.startChannels.mockResolvedValue(channelStatus({ running: true }));
    apiMock.stopChannels.mockResolvedValue(channelStatus());
    apiMock.runChannelPairingCommand.mockResolvedValue({ channel: "weixin", reply: "approved" });
    apiMock.startWeixinLogin.mockResolvedValue({ login_id: "qid-1", qr_image: "data:image/png;base64,AAAA" });
    apiMock.weixinLoginStatus.mockResolvedValue({ status: "wait" });
  });

  it("renders channel runtime status and refreshes it", async () => {
    render(<MemoryRouter><Settings /></MemoryRouter>);

    expect(await screen.findByText("IM Channels")).toBeInTheDocument();
    // ponytail: 仅微信在 WebUI 露出,其他渠道(如 telegram)不渲染。
    // 断言 display_name "WeChat"(weixin 文本在表格 + pairing 下拉各出现一次,不唯一)
    expect(screen.getByText("WeChat")).toBeInTheDocument();
    expect(screen.queryByText("telegram")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(apiMock.getChannelStatus).toHaveBeenCalledTimes(2));
  });

  it("retrieves VIP models into a selectable list without displaying the base URL", async () => {
    window.localStorage.setItem("vt_provider_picked", "1");
    apiMock.getLLMSettings.mockResolvedValue(vipLlmSettings());
    apiMock.getVipModels.mockResolvedValue({ models: ["gpt-5-mini", "gpt-5"] });

    render(<MemoryRouter><Settings /></MemoryRouter>);

    await screen.findByText("LLM Settings");
    expect(screen.queryByDisplayValue("https://vip.example/v1")).not.toBeInTheDocument();
    fireEvent.change(screen.getAllByPlaceholderText("Leave blank to keep the current key")[0], {
      target: { value: "new-vip-key" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Get model list" }));

    await waitFor(() =>
      expect(apiMock.getVipModels).toHaveBeenCalledWith({ api_key: "new-vip-key" }),
    );
    expect(await screen.findByRole("option", { name: "gpt-5" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "gpt-5-mini" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Model/ })).toHaveValue("gpt-5-mini");
  });

  it("persists the user-selected VIP model without refreshing the model list", async () => {
    window.localStorage.setItem("vt_provider_picked", "1");
    apiMock.getLLMSettings.mockResolvedValue(vipLlmSettings());
    apiMock.getVipModels.mockResolvedValue({ models: ["gpt-5-mini", "gpt-5"] });
    apiMock.updateLLMSettings.mockResolvedValue({
      ...vipLlmSettings(),
      model_name: "gpt-5",
    });

    render(<MemoryRouter><Settings /></MemoryRouter>);
    await screen.findByText("LLM Settings");

    fireEvent.click(screen.getByRole("button", { name: "Get model list" }));
    await screen.findByRole("option", { name: "gpt-5" });
    fireEvent.change(screen.getByRole("combobox", { name: /Model/ }), {
      target: { value: "gpt-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(apiMock.updateLLMSettings).toHaveBeenCalledOnce());
    expect(apiMock.getVipModels).toHaveBeenCalledOnce();
    expect(apiMock.updateLLMSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "vip_server",
        model_name: "gpt-5",
      }),
    );
    expect(screen.getByRole("combobox", { name: /Model/ })).toHaveValue("gpt-5");
  });

  it("hides generation controls and saves the fixed generation defaults from Connection", async () => {
    window.localStorage.setItem("vt_provider_picked", "1");
    apiMock.getLLMSettings.mockResolvedValue(vipLlmSettings());
    apiMock.updateLLMSettings.mockResolvedValue(vipLlmSettings());

    render(<MemoryRouter><Settings /></MemoryRouter>);

    await screen.findByText("LLM Settings");
    expect(screen.queryByText("Generation")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Temperature/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Timeout/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Reasoning effort/)).not.toBeInTheDocument();

    const connection = screen.getByRole("heading", { name: "LLM Settings" }).closest("section");
    expect(connection).toContainElement(screen.getByRole("button", { name: "Save" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(apiMock.updateLLMSettings).toHaveBeenCalledOnce());
    expect(apiMock.updateLLMSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.7,
        timeout_seconds: 200,
        reasoning_effort: "high",
      }),
    );
  });

  it("saves a cleared VIP key without attempting to refresh its models", async () => {
    window.localStorage.setItem("vt_provider_picked", "1");
    apiMock.getLLMSettings.mockResolvedValue(vipLlmSettings());
    apiMock.updateLLMSettings.mockResolvedValue({
      ...vipLlmSettings(),
      api_key_configured: false,
    });

    render(<MemoryRouter><Settings /></MemoryRouter>);
    await screen.findByText("LLM Settings");

    fireEvent.click(screen.getByLabelText("Clear saved API key"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(apiMock.updateLLMSettings).toHaveBeenCalledOnce());
    expect(apiMock.getVipModels).not.toHaveBeenCalled();
    expect(apiMock.updateLLMSettings).toHaveBeenCalledWith(
      expect.objectContaining({ clear_api_key: true }),
    );
  });

  it("starts channels from the settings control surface", async () => {
    render(<MemoryRouter><Settings /></MemoryRouter>);
    await screen.findByText("IM Channels");

    fireEvent.click(screen.getByRole("button", { name: "Start channels" }));

    await waitFor(() => expect(apiMock.startChannels).toHaveBeenCalledTimes(1));
  });

  it("runs pairing commands from the settings control surface", async () => {
    render(<MemoryRouter><Settings /></MemoryRouter>);
    await screen.findByText("IM Channels");

    fireEvent.change(screen.getByLabelText("Pairing command"), { target: { value: "approve UM59-EGIT" } });
    fireEvent.click(screen.getByRole("button", { name: "Run pairing" }));

    await waitFor(() =>
      expect(apiMock.runChannelPairingCommand).toHaveBeenCalledWith({
        channel: "weixin",
        command: "approve UM59-EGIT",
      }),
    );
  });

  // ponytail: 删除的两个 install-dep 用例测的是 IM 渠道表格里非微信渠道的「安装依赖」
  // 按钮——WebUI 现仅展示微信(微信无可选 SDK 依赖,永不触发该按钮),该 UI 路径不可达。
  // matchedPkg/installChannelDep 代码保留,待未来开放其他渠道时复用。

  it("renders WeChat QR login button and displays QR modal", async () => {
    render(<MemoryRouter><Settings /></MemoryRouter>);
    await screen.findByText("IM Channels");

    // 扫码登录按钮在微信行渲染
    expect(screen.getByText("Scan to login")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Scan to login"));
    await waitFor(() => expect(apiMock.startWeixinLogin).toHaveBeenCalledTimes(1));

    // ponytail: modal 为「等待轮询」UI(commit 9a2c93e),不再是二维码图片
    expect(await screen.findByText("WeChat Scan Login")).toBeInTheDocument();
    expect(screen.getByText(/Please complete WeChat scan login in the opened page/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText("WeChat Scan Login")).not.toBeInTheDocument());
  });

  it("flags weixin login-expired when health=expired despite poll loop running", async () => {
    // 复现 bug: bot_token 失效时 poll 循环仍在空转(running=true),
    // 后端给出 health="expired"。WebUI 必须据此显示「登录失效」,
    // 而不是用绿色 running badge 误报在线(与 desktop console 口径一致)。
    apiMock.getChannelStatus.mockResolvedValue(channelStatus({
      running: true,
      channels: {
        weixin: {
          name: "weixin",
          display_name: "WeChat",
          configured: true,
          enabled: true,
          available: true,
          loaded: true,
          running: true,
          health: "expired",
          error: "",
          install_hint: "",
        },
      },
    }));

    render(<MemoryRouter><Settings /></MemoryRouter>);
    await screen.findByText("IM Channels");

    expect(await screen.findByText("Login expired · rescan required")).toBeInTheDocument();
    // 恢复动作(扫码)在该行仍可用
    expect(screen.getByText("Scan to login")).toBeInTheDocument();
  });

  it("closes QR modal and refreshes status on confirmed login", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.weixinLoginStatus.mockResolvedValue({ status: "confirmed" });

    render(<MemoryRouter><Settings /></MemoryRouter>);
    await screen.findByText("IM Channels");

    fireEvent.click(screen.getByText("Scan to login"));
    expect(await screen.findByText("WeChat Scan Login")).toBeInTheDocument();

    // Advance past one polling interval; confirmed status closes the modal
    await vi.advanceTimersByTimeAsync(2500);

    await waitFor(() => expect(screen.queryByText("WeChat Scan Login")).not.toBeInTheDocument());
    // getChannelStatus was called: once on mount, + at least one refresh after confirmed
    expect(apiMock.getChannelStatus.mock.calls.length).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
  });

  // upstream 容错测试: channel status 接口失败时, LLM / data source 设置仍可渲染。
  // 依赖 Settings.tsx 用 Promise.allSettled 而非 Promise.all (单接口失败不整体崩)。
  // ponytail: 包 MemoryRouter (fork 的 Settings 用 useNavigate 做 auth 重定向)。
  it("still renders LLM and data source settings when channel status fails", async () => {
    apiMock.getChannelStatus.mockRejectedValue(
      new Error('Expected JSON from /channels/status, got text/html: <!doctype html>'),
    );

    render(<MemoryRouter><Settings /></MemoryRouter>);

    expect(await screen.findByText("LLM Settings")).toBeInTheDocument();
    expect(screen.getByText("Data Source Settings")).toBeInTheDocument();
    expect(screen.getByText("IM Channels")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start channels" })).toBeDisabled();
  });
});
