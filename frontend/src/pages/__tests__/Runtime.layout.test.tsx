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

// 避免向 fake-indexeddb 写入测试事件,与其它页面测试一致地 mock 掉遥测。
vi.mock("@/lib/telemetry", () => ({
  track: vi.fn(),
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

  it("shows only the runtime monitor", async () => {
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
      screen.queryByRole("heading", { name: "Local API access" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Usage Data" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});
