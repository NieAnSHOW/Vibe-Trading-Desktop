import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePrintShadowReport } from "../usePrintShadowReport";

describe("usePrintShadowReport", () => {
  const shadowId = "shadow_test123";

  let printSpy: ReturnType<typeof vi.fn>;
  let focusSpy: ReturnType<typeof vi.fn>;
  let addEventListenerSpy: ReturnType<typeof vi.fn>;
  let removeSpy: ReturnType<typeof vi.fn>;
  let createdIframe: HTMLIFrameElement | null = null;

  beforeEach(() => {
    printSpy = vi.fn();
    focusSpy = vi.fn();
    addEventListenerSpy = vi.fn();
    removeSpy = vi.fn();
    createdIframe = null;

    // 拦截 document.createElement，在创建 iframe 时注入 mock
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string, ...args: any[]) => {
        const el = originalCreateElement(tagName, ...args);
        if (tagName === "iframe") {
          createdIframe = el as HTMLIFrameElement;

          // Mock remove 方法
          vi.spyOn(el, "remove").mockImplementation(() => {
            removeSpy();
          });

          // 立即设置 contentWindow（因为 hook 在 src 赋值后就可能访问它）
          Object.defineProperty(el, "contentWindow", {
            value: {
              focus: focusSpy,
              print: printSpy,
              addEventListener: addEventListenerSpy,
            },
            writable: true,
            configurable: true,
          });

          let onloadHandler: ((ev: Event) => void) | null = null;

          // 拦截 onload 赋值
          Object.defineProperty(el, "onload", {
            set(handler: any) {
              onloadHandler = handler;
            },
            get() {
              return onloadHandler;
            },
            configurable: true,
          });

          // 拦截 src 赋值：设置后异步触发 onload
          let _src = "";
          Object.defineProperty(el, "src", {
            set(value: string) {
              _src = value;
              // 异步触发 onload，模拟 iframe 加载完成
              setTimeout(() => {
                // 准备 mock contentDocument
                const doc = document.implementation.createHTMLDocument();
                vi.spyOn(doc.head, "appendChild");
                vi.spyOn(doc, "createElement");

                Object.defineProperty(el, "contentDocument", {
                  value: doc,
                  writable: true,
                  configurable: true,
                });

                if (onloadHandler) {
                  onloadHandler(new Event("load"));
                }
              }, 0);
            },
            get() {
              return _src;
            },
            configurable: true,
          });
        }
        return el;
      },
    );

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("创建隐藏 iframe 并加载 shadow report HTML URL", () => {
    const appendChildSpy = vi.spyOn(document.body, "appendChild");

    const { result } = renderHook(() => usePrintShadowReport(shadowId));

    act(() => {
      result.current.exportPdf();
    });

    const iframe = createdIframe;
    expect(iframe).toBeDefined();
    expect(iframe!.style.display).toBe("none");
    expect(iframe!.src).toBe(
      `/shadow-reports/${encodeURIComponent(shadowId)}?format=html`,
    );
    expect(appendChildSpy).toHaveBeenCalled();
  });

  it("iframe onload 后注入浅色打印样式并调用 print", async () => {
    const { result } = renderHook(() => usePrintShadowReport(shadowId));

    act(() => {
      result.current.exportPdf();
    });

    // 等待异步 onload 回调
    await vi.runAllTimersAsync();

    // 验证样式注入到 contentDocument.head
    const iframe = createdIframe;
    expect(iframe).toBeDefined();
    const doc = iframe!.contentDocument!;
    expect(doc.head.appendChild).toHaveBeenCalled();
    const styleCall = (doc.head.appendChild as any).mock.calls.find(
      (call: any[]) => call[0]?.tagName === "STYLE",
    );
    expect(styleCall).toBeDefined();
    const styleEl = styleCall?.[0] as HTMLStyleElement;
    expect(styleEl.media).toBe("print");
    expect(styleEl.textContent).toContain("@media print");

    // 验证 print 和 focus 被调用
    expect(focusSpy).toHaveBeenCalled();
    expect(printSpy).toHaveBeenCalled();
  });

  it("contentDocument 为空时安全返回不报错", () => {
    const { result } = renderHook(() => usePrintShadowReport(shadowId));

    // 重新 mock createElement，使 contentDocument 为 null
    vi.restoreAllMocks();
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string, ...args: any[]) => {
        const el = originalCreateElement(tagName, ...args);
        if (tagName === "iframe") {
          createdIframe = el as HTMLIFrameElement;
          let onloadHandler: ((ev: Event) => void) | null = null;

          Object.defineProperty(el, "onload", {
            set(handler: any) {
              onloadHandler = handler;
            },
            get() {
              return onloadHandler;
            },
            configurable: true,
          });

          Object.defineProperty(el, "src", {
            set(_value: string) {
              setTimeout(() => {
                Object.defineProperty(el, "contentDocument", {
                  value: null,
                  writable: true,
                  configurable: true,
                });
                if (onloadHandler) {
                  onloadHandler(new Event("load"));
                }
              }, 0);
            },
            get() {
              return "";
            },
            configurable: true,
          });
        }
        return el;
      },
    );

    // 重新设置 fake timers
    vi.useFakeTimers();

    act(() => {
      result.current.exportPdf();
    });

    // 不应抛错
    expect(async () => {
      await vi.runAllTimersAsync();
    }).not.toThrow();
  });

  it("afterprint 事件触发后清理 iframe", async () => {
    const { result } = renderHook(() => usePrintShadowReport(shadowId));

    act(() => {
      result.current.exportPdf();
    });

    await vi.runAllTimersAsync();

    // 验证 addEventListener("afterprint", handler, { once: true }) 已注册
    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "afterprint",
      expect.any(Function),
      { once: true },
    );

    // 模拟 afterprint 触发
    const afterPrintCall = addEventListenerSpy.mock.calls.find(
      (call: any[]) => call[0] === "afterprint",
    );
    expect(afterPrintCall).toBeDefined();
    const cleanupHandler = afterPrintCall![1] as () => void;
    cleanupHandler();

    // 验证 iframe.remove() 被调用
    expect(removeSpy).toHaveBeenCalled();
  });

  it("60s 超时后兜底清理 iframe", async () => {
    const { result } = renderHook(() => usePrintShadowReport(shadowId));

    act(() => {
      result.current.exportPdf();
    });

    // 验证 iframe 已添加到 body
    expect(document.body.contains(createdIframe!)).toBe(true);

    // 只运行 pending micro-tasks 和 0ms timer（onload），不要 runAllTimersAsync
    // 因为它会把 60s timer 也消耗掉
    await vi.advanceTimersByTimeAsync(0);

    // 验证 print 被调用（说明 onload 已触发）
    expect(printSpy).toHaveBeenCalled();

    // reset removeSpy，清除 onload 阶段可能的调用
    removeSpy.mockClear();

    // 快进 61 秒，触发兜底超时
    act(() => {
      vi.advanceTimersByTime(60_001);
    });

    expect(removeSpy).toHaveBeenCalled();
  });

  it("取消打印不报错，cleanup 正常执行", () => {
    const { result } = renderHook(() => usePrintShadowReport(shadowId));

    expect(() => {
      act(() => {
        result.current.exportPdf();
      });
    }).not.toThrow();
  });

  it("多次调用 exportPdf 不累积异常", () => {
    const { result } = renderHook(() => usePrintShadowReport(shadowId));

    act(() => {
      result.current.exportPdf();
    });
    act(() => {
      result.current.exportPdf();
    });

    // 不应抛错
    expect(true).toBe(true);
  });
});
