import { render, screen } from "@testing-library/react";
import type { NewsPageState } from "@/hooks/useNews";

const state = vi.hoisted(() => ({
  value: {
    snapshot: {
      schema_version: 1,
      generated_at: "2026-07-20T09:00:00Z",
      upstream_commit: "fixture",
      source_stats: {
        endpoint_success_count: 1,
        endpoint_failure_count: 0,
        assignment_success_count: 1,
        assignment_failure_count: 0,
      },
      errors: [],
      tracks: [
        {
          track_id: "ai",
          state: "fresh",
          generated_at: "2026-07-20T09:00:00Z",
          stale: false,
          partial: false,
          items: [
            {
              id: "long-title",
              track_id: "ai",
              title: "A-very-long-unbroken-investment-news-headline-that-must-not-overflow",
              title_zh: null,
              summary: "摘要",
              source: { id: "source", name: "Wire", url: "https://example.com/feed" },
              published_at: null,
              url: "https://example.com/story",
            },
          ],
          ai: {
            available: true,
            generated_at: "2026-07-20T09:00:00Z",
            highlights: ["要点一", "要点二", "要点三"],
            error: null,
          },
          source_stats: {
            endpoint_success_count: 1,
            endpoint_failure_count: 0,
            assignment_success_count: 1,
            assignment_failure_count: 0,
          },
        },
      ],
    },
    available: true,
    stale: false,
    snapshotError: null,
    refreshStatus: null,
    selectedTrackId: "ai",
    isLoading: false,
    isRefreshing: false,
    error: null,
  } as NewsPageState,
}));

vi.mock("@/hooks/useNews", () => ({
  useNews: () => ({
    ...state.value,
    selectTrack: vi.fn(),
    refreshNews: vi.fn(),
  }),
}));

import { News } from "../News";

describe("News responsive layout contract", () => {
  it("uses an Indices-style desktop workspace with a bounded navigator and detail surface", () => {
    render(<News />);

    expect(screen.getByTestId("news-workspace")).toHaveClass(
      "min-w-0",
      "lg:grid",
      "lg:grid-cols-[minmax(15rem,0.36fr)_minmax(0,1fr)]",
      "lg:grid-rows-[auto_minmax(0,1fr)]",
    );
    expect(screen.getByTestId("news-desktop-tracks")).toHaveClass(
      "hidden",
      "lg:flex",
      "rounded-lg",
      "bg-card",
    );
    expect(screen.getByTestId("news-detail-surface")).toHaveClass(
      "rounded-lg",
      "bg-card",
      "lg:overflow-auto",
    );
  });

  it("uses a mobile selector and keeps desktop navigation out of the mobile layout", () => {
    render(<News />);

    expect(screen.getByTestId("news-desktop-tracks")).toHaveClass("hidden", "lg:flex");
    expect(screen.getByTestId("news-mobile-tracks")).toHaveClass("lg:hidden");
  });

  it("allows long article titles to wrap without widening the workspace", () => {
    render(<News />);

    expect(screen.getByRole("heading", { name: /A-very-long-unbroken/ })).toHaveClass("break-words");
    expect(screen.getByTestId("long-title")).toHaveClass("min-w-0");
  });
});
