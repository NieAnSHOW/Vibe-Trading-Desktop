# Comet Design Handoff

- Change: desktop-shadow-report-pdf-export
- Phase: design
- Mode: compact
- Context hash: 079968868f33effa1e292ba92a4937bf4651793b03ea5565d6958b6cec55fa3b

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/desktop-shadow-report-pdf-export/proposal.md

- Source: openspec/changes/desktop-shadow-report-pdf-export/proposal.md
- Lines: 1-29
- SHA256: ef5be7f9645285a48d75bb0b6855b7d2bc85ff585c8be6cdfb1665a928234a8e

```md
## Why

桌面端（Tauri）当前无法生成影子账户报告 PDF：后端 weasyprint 依赖 cairo/pango 等系统原生库，打包时被 `install-deps.sh` 排除，导致桌面端永远走 `reporter.py` 的 HTML-only 软降级，**用户拿不到 PDF**。此前的 `desktop-weasyprint-native-libs` 方案（随包 weasyprint 原生库链）经评估为成本过高的错配（双平台原生库 + 签名公证 + fontconfig，24 task 全未实现），已废弃。本 change 改走前端 webview 打印路线，让用户通过打印对话框「另存为 PDF」——零原生库、零系统依赖、零 Tauri 改动。

## What Changes

- 前端在影子报告入口（`RunCompleteCard` 的 Shadow Report 区）新增「导出 PDF」动作：隐藏 iframe 加载报告 HTML → 调用 `window.print()` → 用户在打印对话框另存为 PDF。
- 修复报告 HTML 的图表嵌入：`file://` 绝对路径（`reporter.py:176`）→ data URI 内联（复用 `embed_image_as_data_uri`），使 HTML 完全自包含，webview/浏览器加载与打印均可正确显示图表（同时修复潜在的非本机 HTML 图片显示问题）。
- 验证/补充打印 CSS（现有 `shadow_report.css` 已含 `@page{size:A4}` / `page-break-*` 标准分页属性，webview 打印原生兼容）。
- 保留后端 weasyprint 软依赖与 HTML-only 降级逻辑不变（兜底）。
- **不改**：Tauri Rust 侧（`src-tauri/`）、`capabilities`、后端 PDF 引擎、`install-deps.sh`、不引入 `@tauri-apps/api`。

## Capabilities

### New Capabilities

- `shadow-report-export`: 影子账户报告的前端 PDF 导出能力——桌面端（及 Web）通过 webview 打印生成 PDF，含图表 data URI 内联化与打印 CSS 适配。

### Modified Capabilities

（无——不改变任何现有 spec 的 requirement；后端降级逻辑与打包流程保持不变）

## Impact

- **前端**：`frontend/src/components/chat/RunCompleteCard.tsx`（新增导出动作）；新增打印辅助 hook/util；报告 HTML 经隐藏 iframe 加载。
- **后端**：`agent/src/shadow_account/reporter.py`（图表 `file://` → data URI 内联）；按需微调 `templates/shadow_report.css`（`@media print`）。
- **不改**：`src-tauri/**`、`capabilities/default.json`、`install-deps.sh`、后端 PDF 引擎与降级路径。
- **依赖**：无新增前端/后端依赖。
- **平台**：macOS + Windows 桌面端优先；Web 模式入口同样可用（`window.print` 对 Web 原生可用，无需平台判断），Web 后端 PDF 路径不变（回归保护）。
```

## openspec/changes/desktop-shadow-report-pdf-export/design.md

- Source: openspec/changes/desktop-shadow-report-pdf-export/design.md
- Lines: 1-60
- SHA256: 36fa4606377601bdedbf5961b7706e50adbd334a3e2fed0aaab37cba4317a1c0

```md
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
```

## openspec/changes/desktop-shadow-report-pdf-export/tasks.md

- Source: openspec/changes/desktop-shadow-report-pdf-export/tasks.md
- Lines: 1-29
- SHA256: ee31018ecc0c4f79d4d9136f6b8d2a7d9845e303a088ba94d417ca3975dd24cd

```md
# Implementation Tasks — desktop-shadow-report-pdf-export

> 任务按依赖排序。深度技术细节（CSS print 适配、iframe 策略验证、webview 打印字体一致性）在 `/comet-design` 后细化。

## 1. 后端：图表 data URI 内联化

- [ ] 1.1 修改 `_render_charts`（`reporter.py`）：将 `file://` URI（`reporter.py:176`）改为 data URI 内联（复用 `embed_image_as_data_uri`），使 HTML 自包含
- [ ] 1.2 验证内联后 HTML 在浏览器直接打开图表可见；HTML 体积可接受（3 PNG @ 150dpi）
- [ ] 1.3 回归：现有 weasyprint PDF 路径与 HTML-only 降级不受影响

## 2. 前端：PDF 导出入口与打印流程

- [ ] 2.1 在 `RunCompleteCard` 现有 Shadow Report 入口区新增「导出 PDF」按钮（含 i18n 文案）
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
```

## openspec/changes/desktop-shadow-report-pdf-export/specs/shadow-report-export/spec.md

- Source: openspec/changes/desktop-shadow-report-pdf-export/specs/shadow-report-export/spec.md
- Lines: 1-53
- SHA256: f72956d7953619676b033748aec19ba2b92cb394e204824a8b922444366d7b1e

```md
## ADDED Requirements

### Requirement: 桌面端影子报告 PDF 导出

影子账户报告 SHALL 提供通过 webview 打印生成 PDF 的能力：用户触发导出后，系统 SHALL 加载报告 HTML 并调起打印对话框，用户可通过「另存为 PDF」获得 PDF 文件；该过程 SHALL 不依赖任何系统原生库（cairo/pango/GTK 等）或后端 weasyprint，且 SHALL 不新增任何 Tauri Rust 命令或 capability。

#### Scenario: 桌面端正常导出 PDF

- **WHEN** 用户在未安装 weasyprint/GTK 的桌面端点击「导出 PDF」
- **THEN** 系统加载报告 HTML 并打开打印对话框，用户另存为 PDF 后得到含中文文本、全部图表、8 节内容的 PDF

#### Scenario: 打印输出为浅色打印友好版

- **WHEN** 用户经前端打印导出 PDF
- **THEN** 生成的 PDF 为浅色（白底深字）打印友好版，且该浅色样式仅在前端打印时注入、不修改后端报告模板 CSS（Web 模式 weasyprint 深色 PDF 不受影响）

#### Scenario: 后端 weasyprint 不可用不阻断导出

- **WHEN** 后端 weasyprint 缺失或已降级为 HTML-only
- **THEN** 前端 PDF 导出仍正常工作（不依赖后端 PDF 产物）

#### Scenario: webview 无自动页码仍可导出

- **WHEN** webview 打印不支持自动页码（CSS Paged Media `@bottom-right` counter 不被浏览器支持）
- **THEN** PDF 仍可正常导出（页码降级，用户可经打印对话框页眉页脚补充）

#### Scenario: 用户取消打印

- **WHEN** 用户在打印对话框点击取消
- **THEN** 不抛异常、不留残留 iframe

### Requirement: 报告图表以 data URI 内联

报告 HTML 中的图表 SHALL 以 data URI 内联嵌入，而非 `file://` 绝对路径引用，以确保 HTML 自包含，可在 webview/浏览器加载与打印流程中正确显示图表。

#### Scenario: 图表在打印 PDF 中可见

- **WHEN** 报告含渲染成功的图表
- **THEN** 生成的 PDF 中图表可见且清晰

#### Scenario: 图表渲染失败优雅降级

- **WHEN** 某图表渲染失败
- **THEN** 报告与 PDF 仍生成，仅缺该图表，不抛异常

### Requirement: Web 模式行为保持

本 change SHALL 不改变 Web 模式下影子报告的既有行为（后端 weasyprint 可用时产 PDF、HTML 始终可用）；前端打印入口对 Web 同样可用（`window.print` 原生支持），但不改变后端 PDF 路径与报告模板样式。

#### Scenario: Web 模式回归保护

- **WHEN** 在 Web 模式访问影子报告
- **THEN** 后端 PDF 路径、HTML 行为与报告模板样式与本 change 前一致
```

