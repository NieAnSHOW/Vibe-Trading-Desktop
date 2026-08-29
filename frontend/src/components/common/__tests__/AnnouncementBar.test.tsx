import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/announcements", async () => {
  const actual = await vi.importActual<typeof import("@/lib/announcements")>(
    "@/lib/announcements",
  );
  return { ...actual, fetchAnnouncements: vi.fn() };
});
vi.mock("@/lib/externalLinks", () => ({
  openExternalUrl: vi.fn(),
}));

import { AnnouncementBar } from "../AnnouncementBar";
import { fetchAnnouncements, type AnnouncementAd } from "@/lib/announcements";
import { openExternalUrl } from "@/lib/externalLinks";

function ad(id: number, content: string, link: string | null): AnnouncementAd {
  return { id, title: content, type: 2, position: "dashboard", images: null, content, link, sort: 0 };
}

beforeEach(() => {
  vi.mocked(fetchAnnouncements).mockReset();
  vi.mocked(openExternalUrl).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function rows(): HTMLElement[] {
  return Array.from(
    screen.getByTestId("dashboard-announcements").querySelectorAll(".flex.h-8"),
  );
}

describe("AnnouncementBar", () => {
  it("renders nothing when the announcement list is empty", async () => {
    vi.mocked(fetchAnnouncements).mockResolvedValue([]);
    const { container } = render(<AnnouncementBar />);
    await waitFor(() => expect(fetchAnnouncements).toHaveBeenCalled());
    expect(container.firstElementChild).toBeNull();
  });

  it("renders a single announcement statically and opens its link", async () => {
    vi.mocked(fetchAnnouncements).mockResolvedValue([ad(1, "唯一公告", "https://example.com/")]);
    render(<AnnouncementBar />);

    const row = await screen.findByText("唯一公告");
    expect(rows()).toHaveLength(1);
    fireEvent.click(row.closest(".flex.h-8") as HTMLElement);
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/");
  });

  it("cycles vertically with a clone row closing the loop", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchAnnouncements).mockResolvedValue([
      ad(1, "第一条", null),
      ad(2, "第二条", null),
    ]);
    const { container } = render(<AnnouncementBar />);

    // act 冲刷 fetch promise 落地后的 React 渲染
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const bar = container.querySelector('[data-testid="dashboard-announcements"]');
    expect(bar).not.toBeNull();
    const track = bar!.querySelector(".will-change-transform") as HTMLElement;
    // 2 条真实 + 1 条克隆首条
    expect(rows()).toHaveLength(3);
    expect(rows()[2].getAttribute("aria-hidden")).toBe("true");
    expect(track.style.transform).toBe("translateY(-0rem)");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(track.style.transform).toBe("translateY(-2rem)");

    // 滚到克隆行结束后瞬时回零且关闭过渡
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await act(async () => {
      fireEvent.transitionEnd(track);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(track.style.transform).toBe("translateY(-0rem)");
    expect(track.style.transition).toBe("none");
  });

  it("refreshes on the poll interval and keeps old ads when the refresh fails", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchAnnouncements)
      .mockResolvedValueOnce([ad(1, "第一条", null), ad(2, "第二条", null)])
      .mockResolvedValueOnce([ad(3, "新公告", "https://example.com/new")])
      .mockResolvedValueOnce(null);
    const { container } = render(<AnnouncementBar />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 悬停暂停轮播,避免测试推进期间 jsdom 不触发 transitionend 的干扰
    fireEvent.mouseEnter(container.querySelector('[data-testid="dashboard-announcements"]')!);
    expect(screen.getAllByText("第一条")).toHaveLength(2); // 真行 + 克隆行
    expect(screen.getByText("第二条")).toBeInTheDocument();

    // 5 分钟后轮询拿到新列表:整条替换
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(screen.getByText("新公告")).toBeInTheDocument();
    expect(screen.queryByText("第一条")).not.toBeInTheDocument();

    // 再一轮失败(null):保留现有公告
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(screen.getByText("新公告")).toBeInTheDocument();
  });

  it("clamps the rotation position when the list shrinks to one ad", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchAnnouncements)
      .mockResolvedValueOnce([ad(1, "第一条", null), ad(2, "第二条", null)])
      .mockResolvedValueOnce([ad(9, "仅剩一条", null)]);
    const { container } = render(<AnnouncementBar />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 推进到第二条(pos=1)后悬停暂停,让 pos 停在轮换中途
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    fireEvent.mouseEnter(container.querySelector('[data-testid="dashboard-announcements"]')!);
    const track = () =>
      container.querySelector('[data-testid="dashboard-announcements"] .will-change-transform') as HTMLElement;
    expect(track().style.transform).toBe("translateY(-2rem)");

    // 列表缩成单条:pos 越界归零,不轮换,transform 回零
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(screen.getByText("仅剩一条")).toBeInTheDocument();
    expect(rows()).toHaveLength(1);
    expect(track().style.transform).toBe("translateY(-0rem)");
  });
});
