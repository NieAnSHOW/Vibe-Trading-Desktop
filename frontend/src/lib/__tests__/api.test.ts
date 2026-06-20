import { api, ApiError } from "../api";

describe("api", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("reports invalid JSON responses as API errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<!doctype html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    await expect(api.listFinanceNews()).rejects.toMatchObject({
      name: "ApiError",
      status: 200,
      message: "HTTP 200: invalid JSON response",
    } satisfies Partial<ApiError>);
  });

  it("requests stock hotness data from AKTools", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ 股票代码: "SH600519", 股票简称: "贵州茅台", 关注: 2763065 }]), {
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

    await expect(api.getStockHot()).resolves.toMatchObject({
      sections: [
        {
          id: "xq-deal",
          function: "stock_hot_deal_xq",
          columns: ["股票代码", "股票简称", "关注"],
          rows: [{ 股票代码: "SH600519", 股票简称: "贵州茅台", 关注: 2763065 }],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://aktool.nieanshow.cn/api/public/stock_hot_deal_xq?symbol=%E6%9C%80%E7%83%AD%E9%97%A8",
      expect.objectContaining({ headers: expect.objectContaining({ "Content-Type": "application/json" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://aktool.nieanshow.cn/api/public/stock_hot_keyword_em?symbol=SZ000665",
      expect.objectContaining({ headers: expect.objectContaining({ "Content-Type": "application/json" }) }),
    );
  });
});
