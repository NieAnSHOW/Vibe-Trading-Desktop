import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { Runtime } from "../Runtime";

const apiMock = vi.hoisted(() => ({
  getLiveStatus: vi.fn(),
}));

// 注意勿用 importActual 展开:与页面模块组合会触发 vitest worker OOM,页面仅用到 api。
vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

// 真实遥测在 jsdom(fake-indexeddb)下会拖垮 worker,与其它页面测试一致地 mock 掉。
const telemetryMock = vi.hoisted(() => ({
  track: vi.fn(),
  getConsent: vi.fn(() => false),
  setConsent: vi.fn(async () => {}),
}));
vi.mock("@/lib/telemetry", () => telemetryMock);

vi.mock("@/lib/apiAuth", () => ({
  getApiAuthKey: vi.fn(() => ""),
  setApiAuthKey: vi.fn(),
}));

describe("Runtime workspace layout", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
    apiMock.getLiveStatus.mockResolvedValue({
      global_halted: false,
      brokers: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the compact workspace wrapper", () => {
    render(
      <MemoryRouter>
        <Runtime />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("runtime-workspace")).toHaveClass(
      "flex",
      "w-full",
      "p-3",
      "lg:p-5",
    );
  });

  it("leads with the runtime monitor and keeps browser-side access panels", async () => {
    render(
      <MemoryRouter>
        <Runtime />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Live / Paper Runtime Status",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Runtime" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Local API access" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Usage Data" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
});
