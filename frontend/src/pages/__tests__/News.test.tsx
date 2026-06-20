import { fireEvent, render, screen } from "@testing-library/react";
import { News } from "../News";

describe("News page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders finance news in a masonry-style feed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            tag: "市场",
            summary: "沪指午后震荡走高，机器人概念活跃。",
            url: "https://example.test/news-a",
          },
          {
            tag: "公司",
            summary: "多家公司披露回购进展。",
            url: "https://example.test/news-b",
          },
        ]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    render(<News />);

    expect(await screen.findByText("财经精选")).toBeInTheDocument();
    expect(screen.getByText("沪指午后震荡走高，机器人概念活跃。")).toBeInTheDocument();
    expect(screen.getByText("多家公司披露回购进展。")).toBeInTheDocument();
    expect(screen.getByTestId("news-masonry")).toHaveClass("columns-1", "md:columns-2", "xl:columns-3");
    expect(screen.getAllByRole("link", { name: "阅读原文" })[0]).toHaveAttribute("href", "https://example.test/news-a");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://aktool.nieanshow.cn/api/public/stock_news_main_cx",
      expect.objectContaining({ headers: expect.objectContaining({ "Content-Type": "application/json" }) }),
    );
  });

  it("shows an error state and can retry loading news", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "aktool offline" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(<News />);

    expect(await screen.findByText("财经资讯暂不可用")).toBeInTheDocument();
    expect(screen.getByText("aktool offline")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("暂无财经精选资讯")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
