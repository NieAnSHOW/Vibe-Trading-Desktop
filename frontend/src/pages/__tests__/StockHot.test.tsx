import { fireEvent, render, screen, within } from "@testing-library/react";
import { StockHot } from "../StockHot";

describe("StockHot page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders stock hotness sections grouped by source category", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ 股票代码: "SH600519", 股票简称: "贵州茅台", 关注: 2763065, 最新价: 1663.36 }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ 时间: "2026-06-19 12:00:00", 股票代码: "SZ000665", 概念名称: "云计算", 热度: 411 }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    render(<StockHot />);

    expect(await screen.findByText("股票热度")).toBeInTheDocument();
    expect(screen.getByText("股票热度-雪球")).toBeInTheDocument();
    expect(screen.getAllByText("热门关键词").length).toBeGreaterThan(0);
    expect(screen.getByText("stock_hot_deal_xq")).toBeInTheDocument();
    expect(screen.getByText("贵州茅台")).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "交易排行榜" });
    expect(within(table).getByText("股票代码")).toBeInTheDocument();
    expect(within(table).getByText("SH600519")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://aktool.nieanshow.cn/api/public/stock_hot_deal_xq?symbol=%E6%9C%80%E7%83%AD%E9%97%A8",
      expect.objectContaining({ headers: expect.objectContaining({ "Content-Type": "application/json" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://aktool.nieanshow.cn/api/public/stock_hot_keyword_em?symbol=SZ000665",
      expect.objectContaining({ headers: expect.objectContaining({ "Content-Type": "application/json" }) }),
    );
  });

  it("shows section-level errors without hiding healthy sections", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "upstream timeout" }), {
          status: 504,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ 时间: "2026-06-19 12:00:00", 股票代码: "SZ000665", 概念名称: "云计算", 热度: 411 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(<StockHot />);

    expect(await screen.findByText("交易排行榜")).toBeInTheDocument();
    expect(screen.getByText("upstream timeout")).toBeInTheDocument();
    expect(screen.getByText("云计算")).toBeInTheDocument();
  });

  it("shows page-level errors and can retry", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network offline"))
      .mockRejectedValueOnce(new Error("network offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(<StockHot />);

    expect(await screen.findByText("股票热度暂不可用")).toBeInTheDocument();
    expect(screen.getByText("network offline")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("暂无股票热度数据")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
