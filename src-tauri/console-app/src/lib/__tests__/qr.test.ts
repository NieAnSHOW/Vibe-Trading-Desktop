import { describe, expect, it } from "vitest";
import { qrSvgDataUrl } from "../qr";

// 应用内微信登录二维码:qr_image 是扫码跳转文本,需客户端编码为 SVG data URL。
// 纯字符串生成(无 canvas),webview 与 jsdom 行为一致。
describe("qrSvgDataUrl", () => {
  it("encodes text into an SVG data URL", () => {
    const url = qrSvgDataUrl("https://open.weixin.qq.com/connect?x=1");

    expect(url.startsWith("data:image/svg+xml")).toBe(true);
    const svg = decodeURIComponent(url.split(",").slice(1).join(","));
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("produces enough modules for a real QR pattern", () => {
    const url = qrSvgDataUrl("approve UM59-EGIT");
    const svg = decodeURIComponent(url.split(",").slice(1).join(","));

    // path d 由大量 "M<x>,<y>" 模块子路径构成(仅匹配 d 内的指令,不误伤属性名)
    const d = svg.match(/ d="([^"]+)"/)?.[1] ?? "";
    expect((d.match(/M\d+,/g) ?? []).length).toBeGreaterThan(20);
    // 自带白色背景,深色主题下二维码仍可扫描
    expect(svg).toContain('fill="white"');
  });

  it("encodes non-http fallback content (raw qrcode id)", () => {
    const url = qrSvgDataUrl("qQrCoDeId-123");

    expect(url.startsWith("data:image/svg+xml")).toBe(true);
  });
});
