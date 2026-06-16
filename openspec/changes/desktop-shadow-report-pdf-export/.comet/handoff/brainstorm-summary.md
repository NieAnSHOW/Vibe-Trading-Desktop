# Brainstorm Summary（定稿）

- Change: desktop-shadow-report-pdf-export
- Date: 2026-06-16
- 状态：用户已确认设计方案（2026-06-16）

## 确认的技术方案

- 路线：前端 `window.print`，隐藏 iframe 实现（C1）
- 数据流：`RunCompleteCard`「导出 PDF」→ 隐藏 iframe 加载 `/shadow-reports/{id}?format=html` → onload 注入 `<style media="print">` 浅色覆盖 → `contentWindow.print()` → `afterprint` 清理 iframe
- PDF 视觉：**前端动态注入浅色打印友好样式**（不改后端 `shadow_report.css`，保护 Web 回归）
- 图表：`reporter.py:_render_charts` `file://` → data URI（`embed_image_as_data_uri`），weasyprint 兼容
- 后端端点复用 `GET /shadow-reports/{id}?format=html`（api_server.py:2022）

## 关键取舍与风险

- ✅ 零 Tauri 改动 / 零新依赖 / 零 capability 变更
- ⚠️ webview 打印丢失自动页码（`@bottom-right counter` 浏览器不支持）→ 降级接受
- ⚠️ 浅色覆盖样式需覆盖深色主题的全部 `:root` 变量与渐变背景，范围需真机校验
- ⚠️ iframe `contentWindow.print()` 在 WKWebView/WebView2 的打印对话框需真机验证「另存为 PDF」可达

## 测试策略

- 后端：reporter 单测断言 charts 为 data URI；weasyprint PDF 路径回归
- 前端：`usePrintShadowReport` hook 单测（jsdom：iframe onload/print/afterprint + 浅色 style 注入断言）
- 真机：macOS + Windows，PDF 含中文 + 3 图表 + 浅色

## Spec Patch（已确认将回写）

- delta spec「桌面端影子报告 PDF 导出」补充场景：打印输出为浅色打印友好版
- delta spec 补充边界场景：webview 无自动页码仍可正常导出
