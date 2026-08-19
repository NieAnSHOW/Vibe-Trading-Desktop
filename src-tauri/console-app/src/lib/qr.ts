import qrcode from "qrcode-generator";

// 微信登录二维码:后端 qr_image 是扫码跳转文本(非图片),需客户端编码。
// 用纯字符串 SVG 输出(无 canvas 依赖),webview 渲染与 jsdom 测试行为一致;
// 生成的 SVG 自带白色背景 rect,深色主题下仍可扫描。
export function qrSvgDataUrl(text: string, cellSize = 5, margin = 2): string {
  const qr = qrcode(0, "M"); // typeNumber 0 = 按内容自动;纠错级别 M
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag(cellSize, margin);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
