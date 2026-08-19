import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const embeddedFlags = { embedded: false, frame: false };

vi.mock("@/lib/desktopShell", () => ({
  isDesktopEmbedded: () => embeddedFlags.embedded,
  isDesktopShellFrame: () => embeddedFlags.frame,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { installExternalLinkInterceptor, openExternalUrl } from "../externalLinks";

function clickOn(element: Element): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  element.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  embeddedFlags.embedded = false;
  embeddedFlags.frame = false;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("openExternalUrl", () => {
  it("bridges to the shell parent from the retained iframe", () => {
    embeddedFlags.embedded = true;
    embeddedFlags.frame = true;
    const postMessage = vi.spyOn(window.parent, "postMessage");

    openExternalUrl("https://www.10jqka.com.cn/");

    expect(postMessage).toHaveBeenCalledWith(
      { type: "vibe-shell:open-external", url: "https://www.10jqka.com.cn/" },
      "*",
    );
  });

  it("invokes the desktop command when embedded outside the frame", async () => {
    embeddedFlags.embedded = true;
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();

    openExternalUrl("https://www.cls.cn/");

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "https://www.cls.cn/" }),
    );
  });

  it("falls back to the browser window when not embedded", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    openExternalUrl("https://wallstreetcn.com/");

    expect(open).toHaveBeenCalledWith(
      "https://wallstreetcn.com/",
      "_blank",
      "noopener,noreferrer",
    );
  });
});

describe("installExternalLinkInterceptor", () => {
  it("redirects external anchor clicks through the shell bridge", () => {
    embeddedFlags.embedded = true;
    embeddedFlags.frame = true;
    const postMessage = vi.spyOn(window.parent, "postMessage");
    const stop = installExternalLinkInterceptor();
    const anchor = document.createElement("a");
    anchor.href = "https://www.eastmoney.com/";
    document.body.append(anchor);

    const event = clickOn(anchor);

    expect(event.defaultPrevented).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      { type: "vibe-shell:open-external", url: "https://www.eastmoney.com/" },
      "*",
    );
    stop();
  });

  it("leaves same-origin links to the default router behavior", async () => {
    embeddedFlags.embedded = true;
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
    const stop = installExternalLinkInterceptor();
    const anchor = document.createElement("a");
    anchor.href = "/agent";
    document.body.append(anchor);

    const event = clickOn(anchor);

    expect(event.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    stop();
  });

  it("ignores clicks with modifier keys so power users keep native control", () => {
    embeddedFlags.embedded = true;
    embeddedFlags.frame = true;
    const postMessage = vi.spyOn(window.parent, "postMessage");
    const stop = installExternalLinkInterceptor();
    const anchor = document.createElement("a");
    anchor.href = "https://finance.sina.com.cn/";
    document.body.append(anchor);

    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    });
    anchor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
    stop();
  });

  it("stops intercepting after the returned cleanup runs", () => {
    embeddedFlags.embedded = true;
    embeddedFlags.frame = true;
    const postMessage = vi.spyOn(window.parent, "postMessage");
    const stop = installExternalLinkInterceptor();
    const anchor = document.createElement("a");
    anchor.href = "https://www.jisilu.cn/";
    document.body.append(anchor);

    stop();
    const event = clickOn(anchor);

    expect(event.defaultPrevented).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
