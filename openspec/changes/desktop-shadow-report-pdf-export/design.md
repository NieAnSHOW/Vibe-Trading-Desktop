# Design — desktop-shadow-report-pdf-export

> 高层架构与方案选型。深度技术设计（RFC）由随后的 `/comet-design` 阶段产出，本文聚焦 WHAT 层面的架构决策。

## 背景

桌面端影子账户报告当前只能产出 HTML：weasyprint 依赖 cairo/pango 等系统原生库，`install-deps.sh` 打包时将其排除，`reporter.py` 的 `_try_render_pdf`（reporter.py:299-320）永远走 HTML-only 降级。废弃的 `desktop-weasyprint-native-libs` 试图随包原生库，成本过高。本 change 改走前端打印。

## 方案选型

| 路线 | 描述 | 成本 | 体验 | 决策 |
|------|------|------|------|------|
| 随包原生库（废弃） | 打包 weasyprint 的 cairo/pango/glib 链 | 极高（双平台/签名/公证/fontconfig） | 一键 PDF | ✗ 已废弃 |
| **A. 前端 window.print** | iframe + print 对话框另存 PDF | **极低** | 打印对话框 | ✅ **选定** |
| B. Rust 程序化 print-to-pdf | Tauri command + WKWebView/WebView2 平台 API | 高（无官方跨平台 API、双平台差异） | 一键保存 | 留作未来迭代 |
| C. 前端 PDF 库 | jsPDF / html2canvas | 中 | 一键但质量差 | ✗ 分页差、字体易丢、图糊 |

**选定 A 的理由**：零 Tauri 改动、零新依赖、零 capability 变更，且复用既有 HTML + CSS（`shadow_report.css` 已含 `@page{size:A4}` / `page-break-after:always` / `page-break-inside:avoid` 标准分页属性，webview 打印原生兼容）。符合「轻量替代废弃方案」的目标。

## 架构与数据流

```
RunCompleteCard (Shadow Report 入口区)
   │ 点击「导出 PDF」
   ▼
[前端] 创建隐藏 <iframe src="/shadow-reports/{id}?format=html">
   │ iframe.onload
   ▼
[前端] iframe.contentWindow.print()  → webview 打印对话框
   │ 用户选「另存为 PDF」+ 保存位置
   ▼
PDF 文件（含中文 + 3 图表 + 8 节，由 webview 渲染引擎产出）
```

后端 `GET /shadow-reports/{id}?format=html`（`api_server.py:2022`）已存在，直接复用，无需新增端点。

## 关键决策（高层）

**D1：图表 `file://` → data URI 内联（必须）**
`_render_charts`（reporter.py:176）返回 `file:///...` URI，http 页面/webview 加载会被跨域策略拦截。改为 data URI 内联（复用现成 `embed_image_as_data_uri`），HTML 完全自包含。同时修复潜在的非本机/浏览器 HTML 图片显示问题。

**D2：入口位置**
复用 `RunCompleteCard` 现有 Shadow Report 入口区，新增「导出 PDF」按钮，与现有「Shadow Report」（HTML 链接）并列。不新建路由。

**D3：CSS 打印兼容**
现有分页属性已达标。仅需验证/按需补充 `@media print`（隐藏交互元素、纸张/边距预设），具体在 `/comet-design` 确定。

**D4：两端统一启用入口**
`window.print` 对 Web 原生可用，入口两端统一启用，**无需 `isTauri` 平台判断**（实现最简）。Web 后端 weasyprint PDF 路径不变，仅作为回归保护。

**D5：降级兜底保留**
`reporter.py` 的 weasyprint 软依赖 + HTML-only 降级逻辑完全不动。前端打印不依赖后端 PDF，故即使 weasyprint 完全不可用，桌面端 PDF 导出仍工作。

## 风险与未知（留待 /comet-design 深挖）

- webview 打印对话框的默认文件名/纸张/边距是否需经 `@page` CSS 预设。
- WKWebView vs WebView2 打印输出的中文字体一致性（依赖系统字体 PingFang/Noto/Windows Fonts）。
- iframe 加载同源后端报告 HTML 的策略（同源应无问题，需验证 `contentWindow.print` 跨 iframe 调用）。
- 图表 data URI 内联对 HTML 体积的影响（3 张 PNG @ 150dpi，需评估）。
- 是否需在打印前对 HTML 做 print-only 预处理（注入 `@media print` 样式块）。
