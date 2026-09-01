import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const embeddedFlags = { embedded: false, frame: false };

vi.mock("@/lib/desktopShell", () => ({
  isDesktopEmbedded: () => embeddedFlags.embedded,
  isDesktopShellFrame: () => embeddedFlags.frame,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { fetchAnnouncements, type AnnouncementAd } from "../announcements";

const ads: AnnouncementAd[] = [
  {
    id: 1,
    title: "公告一",
    type: 2,
    position: "dashboard",
    images: null,
    content: "公告一内容",
    link: "https://example.com/one",
    sort: 0,
  },
];

function dispatchReply(position: string, replyAds: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window.parent,
      data: { type: "vibe-shell:ads", position, ads: replyAds },
    }),
  );
}

beforeEach(() => {
  embeddedFlags.embedded = false;
  embeddedFlags.frame = false;
  vi.mocked(invoke).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchAnnouncements", () => {
  it("bridges to the shell parent from the retained iframe", async () => {
    embeddedFlags.embedded = true;
    embeddedFlags.frame = true;
    const postMessage = vi.spyOn(window.parent, "postMessage");

    const pending = fetchAnnouncements("dashboard");
    expect(postMessage).toHaveBeenCalledWith(
      { type: "vibe-shell:ads-request", position: "dashboard" },
      "*",
    );
    dispatchReply("dashboard", ads);

    await expect(pending).resolves.toEqual(ads);
  });

  it("ignores bridge replies for other positions", async () => {
    embeddedFlags.embedded = true;
    embeddedFlags.frame = true;

    const pending = fetchAnnouncements("dashboard");
    dispatchReply("banner", ads);
    dispatchReply("dashboard", ads);

    await expect(pending).resolves.toEqual(ads);
  });

  it("resolves to null when the bridge times out", async () => {
    vi.useFakeTimers();
    embeddedFlags.embedded = true;
    embeddedFlags.frame = true;

    const pending = fetchAnnouncements("dashboard");
    const assertion = expect(pending).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
  });

  it("invokes the desktop command when embedded outside the frame", async () => {
    embeddedFlags.embedded = true;
    vi.mocked(invoke).mockResolvedValue(ads);

    await expect(fetchAnnouncements("dashboard")).resolves.toEqual(ads);
    expect(invoke).toHaveBeenCalledWith("console_fetch_ads", { position: "dashboard" });
  });

  it("resolves to null in a plain browser (unavailable)", async () => {
    await expect(fetchAnnouncements("dashboard")).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps old data on fetch failure (null)", async () => {
    embeddedFlags.embedded = true;
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));

    await expect(fetchAnnouncements("dashboard")).resolves.toBeNull();
  });
});
