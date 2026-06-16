# Implementation Tasks — desktop-shadow-report-pdf-export

> 任务按依赖排序。深度技术细节（CSS print 适配、iframe 策略验证、webview 打印字体一致性）在 `/comet-design` 后细化。

## 1. 后端：图表 data URI 内联化

- [x] 1.1 修改 `_render_charts`（`reporter.py`）：将 `file://` URI（`reporter.py:176`）改为 data URI 内联（复用 `embed_image_as_data_uri`），使 HTML 自包含
- [x] 1.2 验证内联后 HTML 在浏览器直接打开图表可见；HTML 体积可接受（3 PNG @ 150dpi）
- [x] 1.3 回归：现有 weasyprint PDF 路径与 HTML-only 降级不受影响

## 2. 前端：PDF 导出入口与打印流程

- [x] 2.1 在 `RunCompleteCard` 现有 Shadow Report 入口区新增「导出 PDF」按钮（含 i18n 文案）
- [ ] 2.2 实现打印辅助 hook/util：创建隐藏 iframe 加载 `/shadow-reports/{id}?format=html` → `onload` 后调 `contentWindow.print()` → 打印结束/取消后清理 iframe
- [ ] 2.3 用户在打印对话框取消时不报错、不留残留 iframe
- [ ] 2.4 入口两端统一启用（`window.print` 对 Web 原生可用，无需 `isTauri` 平台判断）

## 3. 打印 CSS 适配（按需）

- [ ] 3.1 验证现有 `@page{size:A4}` / `page-break-*` 在 WKWebView / WebView2 打印输出符合预期
- [ ] 3.2 按需补充 `@media print`（隐藏交互元素、边距/纸张预设）

## 4. 验证与测试

- [ ] 4.1 macOS 真机：未装 GTK，导出 PDF 含中文 + 图表 + 8 节
- [ ] 4.2 Windows 真机：同上
- [ ] 4.3 图表渲染失败降级验证（缺图不崩）
- [ ] 4.4 Web 模式回归验证（后端 PDF 路径与 HTML 行为不变）
- [ ] 4.5 前端单元测试（打印流程 hook/util，jsdom 环境）
