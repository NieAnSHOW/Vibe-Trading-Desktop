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
