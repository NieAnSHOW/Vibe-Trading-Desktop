import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Settings } from "../Settings";
import { useAuthStore } from "@/stores/auth";
import i18n from "@/i18n";

const apiMock = vi.hoisted(() => ({
  getLLMSettings: vi.fn(),
  getDataSourceSettings: vi.fn(),
  updateLLMSettings: vi.fn(),
  updateDataSourceSettings: vi.fn(),
  listOptionalDeps: vi.fn(),
  getOptionalDepsMirror: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
  isAuthRequiredError: vi.fn().mockReturnValue(false),
}));

vi.mock("@/components/settings/OptionalDepsManager", () => ({
  OptionalDepsManager: () => <div>Optional deps manager</div>,
}));

describe("Settings page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    apiMock.getLLMSettings.mockResolvedValue({
      provider: "openai",
      model_name: "gpt-4o",
      base_url: "https://api.example.com/v1",
      temperature: 0.7,
      timeout_seconds: 120,
      max_retries: 2,
      reasoning_effort: "",
      api_key_configured: false,
      api_key_required: true,
      providers: [
        {
          name: "openai",
          label: "OpenAI",
          default_model: "gpt-4o",
          default_base_url: "https://api.example.com/v1",
          auth_type: "api_key",
          api_key_required: true,
        },
      ],
      env_path: "/tmp/agent/.env",
    });
    apiMock.getDataSourceSettings.mockResolvedValue({
      tushare_token_configured: false,
      baostock_supported: true,
      baostock_installed: true,
      baostock_message: "BaoStock is ready",
      env_path: "/tmp/agent/.env",
    });
    apiMock.getOptionalDepsMirror.mockResolvedValue({ name: "official", custom_index_url: "" });
    apiMock.listOptionalDeps.mockResolvedValue({ brokers: [] });
    useAuthStore.setState({
      status: "guest",
      token: null,
      refreshToken: null,
      expiresAt: null,
      userInfo: null,
    });
  });

  it("shows the main settings sections", async () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Identity & access")).toBeInTheDocument();
    expect(screen.getByText("LLM backend")).toBeInTheDocument();
    expect(screen.getByText("Market data")).toBeInTheDocument();
    expect(screen.getByText("Optional broker dependencies")).toBeInTheDocument();
    expect(screen.getByText("Usage data")).toBeInTheDocument();
  });

  it("keeps the login guidance visible for guests", async () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Need faster model access?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to login" })).toBeInTheDocument();
  });

  it("renders the Settings information architecture in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");

    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByText("身份与访问")).toBeInTheDocument();
    expect(screen.getByText("LLM 后端")).toBeInTheDocument();
    expect(screen.getByText("市场数据")).toBeInTheDocument();
    expect(screen.getByText("可选券商依赖")).toBeInTheDocument();
    expect(screen.getByText("使用数据")).toBeInTheDocument();
    expect(screen.getByText("需要更快的模型访问？")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往登录" })).toBeInTheDocument();

    await i18n.changeLanguage("en");
  });

  it("updates visible copy when the language changes after render", async () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });

    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByText("身份与访问")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往登录" })).toBeInTheDocument();
  });
});
