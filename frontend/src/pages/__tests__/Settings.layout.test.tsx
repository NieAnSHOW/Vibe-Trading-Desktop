import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { Settings } from "../Settings";

const apiMock = vi.hoisted(() => ({
  getLLMSettings: vi.fn(),
  getDataSourceSettings: vi.fn(),
  getChannelStatus: vi.fn(),
  getLiveStatus: vi.fn(),
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

function channelStatus() {
  return {
    running: false,
    inbound_queue: 0,
    outbound_queue: 0,
    session_count: 0,
    channels: {},
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("Settings workspace layout", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
    apiMock.getLLMSettings.mockResolvedValue(llmSettings());
    apiMock.getDataSourceSettings.mockResolvedValue(dataSourceSettings());
    apiMock.getChannelStatus.mockResolvedValue(channelStatus());
    apiMock.getLiveStatus.mockResolvedValue({ global_halted: false, brokers: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/qveris/config") {
          return jsonResponse({
            enabled: true,
            base_url: "https://qveris.ai/api/v1",
            api_key_masked: "sk-...TEST",
            mode: "paid",
            budget_credits_per_session: 50,
            configured: true,
            signup_url: "https://qveris.ai",
            invite_code: "TEST",
          });
        }
        return jsonResponse({
          enabled: true,
          ok: true,
          error: null,
          remaining_credits: 10,
          recent: [],
          signup_url: "https://qveris.ai",
          invite_code: "TEST",
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the compact workspace wrapper while settings load", () => {
    apiMock.getLLMSettings.mockReturnValue(new Promise(() => {}));

    render(<Settings />);

    expect(screen.getByTestId("settings-workspace")).toHaveClass(
      "flex",
      "w-full",
      "p-3",
      "lg:p-5",
    );
  });

  it("groups the configuration forms beside helper cards without losing controls", async () => {
    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "LLM Settings" });
    const qVerisHeading = await screen.findByRole("heading", {
      name: "QVeris Tool Marketplace",
    });
    const workspace = screen.getByTestId("settings-workspace");
    const configGrid = Array.from(workspace.children).find((element) =>
      element.classList.contains("grid"),
    );

    expect(configGrid).toHaveClass(
      "lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.72fr)]",
    );

    const [primaryColumn, helperColumn] = Array.from(configGrid!.children);
    expect(primaryColumn).toContainElement(
      screen.getByRole("heading", { name: "LLM Settings" }),
    );
    expect(primaryColumn).toContainElement(
      screen.getByRole("heading", { name: "Data Source Settings" }),
    );
    expect(helperColumn.tagName).toBe("ASIDE");
    expect(helperColumn).toHaveClass("[&>section>form]:grid-cols-1");
    expect(helperColumn).toContainElement(qVerisHeading);
    expect(helperColumn).toContainElement(screen.getByRole("switch"));

    expect(screen.getByRole("combobox", { name: /^Provider/ })).toBeInTheDocument();
    const dataSourceForm = screen
      .getByRole("heading", { name: "Data Source Settings" })
      .closest("form");
    expect(dataSourceForm?.querySelector('input[type="password"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Save data source settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "IM Channels" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Live / Paper Runtime Status" })).toBeInTheDocument();
  });
});
