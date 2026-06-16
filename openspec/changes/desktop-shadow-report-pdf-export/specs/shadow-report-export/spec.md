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
