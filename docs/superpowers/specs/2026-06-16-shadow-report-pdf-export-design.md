---
comet_change: desktop-shadow-report-pdf-export
role: technical-design
canonical_spec: openspec
---

# 技术设计：桌面端影子报告 PDF 导出（前端打印路线）

> 关联 OpenSpec change: `desktop-shadow-report-pdf-export`。需求事实源（canonical spec）为 OpenSpec delta spec；本文为 HOW 层面的技术 RFC。

## 1. 背景与目标

桌面端（Tauri）影子账户报告当前只能产出 HTML：weasyprint 依赖 cairo/pango 等系统原生库，打包时被 `install-deps.sh` 排除，`reporter.py:_try_render_pdf` 永远走 HTML-only 降级。废弃的 `desktop-weasyprint-native-libs`（随包原生库，成本过高）已删除。

**目标**：桌面端用户通过前端 webview 打印生成 PDF，零原生库、零系统依赖、零 Tauri 改动。

**非目标**：不改 Tauri Rust 侧 / capabilities / 后端 PDF 引擎与降级逻辑 / `install-deps.sh`；不引入 `@tauri-apps/api`；不做一键程序化保存（Rust 路线留作未来迭代）。

## 2. 方案选型

| 路线 | 成本 | 体验 | 决策 |
|------|------|------|------|
| 随包原生库（旧） | 极高 | 一键 | ✗ 废弃 |
| **A. 前端 window.print** | **极低** | 打印对话框 | ✅ 选定 |
| B. Rust 程序化 print-to-pdf | 高 | 一键 | 未来迭代 |
| C. 前端 PDF 库 | 中 | 质量差 | ✗ |

打印实现三候选：**C1 隐藏 iframe（选定）** > C2 `window.open`（弹窗易被拦）> C3 当前页注入（污染 SPA、print 全页 hack）。

## 3. 架构与数据流

```
RunCompleteCard  [Shadow Report] [导出 PDF ★]
                                   │
                                   ▼
            usePrintShadowReport(shadowId)
              1. 隐藏 <iframe src="/shadow-reports/{id}?format=html">
              2. onload → 注入 <style media="print"> 浅色覆盖
              3. iframe.contentWindow.print()  → webview 打印对话框
              4. window.addEventListener('afterprint', cleanup)
                                   │ 用户「另存为 PDF」
                                   ▼
                        浅色 PDF（白底深字 + 图表 + 8 节）

reporter.py: _render_charts  file:// ──► data URI
```

后端端点 `GET /shadow-reports/{shadow_id}?format=html`（api_server.py:2022）已存在，直接复用，不新增端点。

## 4. 组件设计

### 4.1 前端 hook：`usePrintShadowReport`

职责：给定 `shadowId`，提供 `exportPdf()` 触发隐藏 iframe 打印流程。

```ts
// 伪代码
function exportPdf() {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = `/shadow-reports/${shadowId}?format=html`;
  iframe.onload = () => {
    injectPrintStyles(iframe.contentDocument!);   // 注入浅色 <style media="print">
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
  };
  document.body.appendChild(iframe);
  const cleanup = () => iframe.remove();
  window.addEventListener('afterprint', cleanup, { once: true });
  // 兜底：超时清理（防止 afterprint 不触发）
  setTimeout(cleanup, 60_000);
}
```

边界：
- 同源 iframe → `contentDocument` 可访问。
- `afterprint` + 超时兜底双保险清理，防残留 iframe。
- 用户在对话框取消 → `afterprint` 仍触发 → 清理，不报错。

### 4.2 浅色打印样式注入

向 iframe `contentDocument.head` 注入 `<style media="print">`，覆盖深色主题：

```css
@media print {
  :root {
    --bg:#fff; --text:#111; --surface:#f5f6f8; --surface2:#eef0f3;
    --border:#d8dde5; --text-dim:#555; --text-mute:#777;
  }
  body { background:#fff !important; color:#111 !important; }
  header.cover,
  header.cover::before,
  .cover-delta, .cover-delta::after,
  section.panel, section.panel.gut-punch,
  table, dl.facts, img.chart {
    background:#fff !important;
    border-color:#d8dde5 !important;
  }
  /* 移除 cover 渐变 */
  header.cover { background:#fff !important; }
  .delta-value.positive { color:#1a7f46 !important; }
  .delta-value.negative { color:#c1392b !important; }
  /* 页码由打印对话框提供（webview 不支持 @bottom-right counter） */
}
```

关键约束：`media="print"` 仅打印生效；**绝不修改后端 `shadow_report.css`**——因 weasyprint 默认 `media=print` 会应用 `@media print`，后端改动会波及 Web 模式深色 PDF，破坏回归保护。

### 4.3 后端图表内联化

`agent/src/shadow_account/reporter.py:_render_charts`：

```python
# 现：charts[name] = path.resolve().as_uri()           # file:// URI
# 改：charts[name] = embed_image_as_data_uri(path)      # data:image/png;base64,...
```

`embed_image_as_data_uri`（reporter.py:325）已存在但未被调用，本次启用。spike 确认 weasyprint 原生支持 data URI，Web PDF 路径无影响；HTML 自包含后顺便修复非本机图片显示问题。

## 5. 关键决策

| ID | 决策 | 依据 |
|----|------|------|
| D1 | 图表 file:// → data URI（改 reporter.py） | weasyprint 兼容；前后端受益；修复潜在显示问题 |
| D2 | 入口复用 RunCompleteCard，并列「导出 PDF」按钮 | 不新建路由 |
| D3 | 浅色样式前端动态注入，不改后端 CSS | 保护 Web 回归（weasyprint media=print） |
| D4 | 两端统一启用入口（无 isTauri 判断） | window.print 对 Web 原生可用 |
| D5 | weasyprint 降级逻辑完全不动 | 前端不依赖后端 PDF |

## 6. 降级与边界

- **自动页码丢失**：webview 打印不支持 `@bottom-right{counter(page)}`（CSS Paged Media L3，仅 weasyprint/Prince）。降级接受；用户可在打印对话框勾选页眉页脚。
- **图表渲染失败**：现有 `_render_charts` 已 try/except 跳过，缺图不崩。
- **取消打印**：`afterprint` + 超时兜底清理。
- **weasyprint 不可用**：不影响（前端不依赖后端 PDF）。

## 7. 测试策略

- **后端单测**：`reporter._render_charts` 返回值断言为 `data:image/png;base64,` 前缀；`render_shadow_report` 全流程回归（weasyprint 可用时仍产 PDF）。
- **前端单测**（jsdom）：`usePrintShadowReport` —— 模拟 iframe `onload`、断言浅色 `<style media="print">` 注入到 iframe head、模拟 `print()` 调用、`afterprint` 触发清理。
- **真机验证**：macOS（WKWebView）+ Windows（WebView2），未装 GTK，导出 PDF 含中文 + 3 图表 + 浅色打印友好。
- **Web 回归**：Web 模式后端 PDF 路径与 HTML 行为不变。

## 8. Spec Patch（已回写 delta spec）

- 「桌面端影子报告 PDF 导出」补充场景：打印输出为浅色打印友好版。
- 补充边界场景：webview 无自动页码时仍可正常导出。

## 9. 风险与后续

- 真机验证 WKWebView/WebView2 打印对话框的「另存为 PDF」可达性与默认纸张（`@page{size:A4}` 部分支持）。
- 浅色覆盖样式对 8 节所有组件的覆盖完整性需真机校验（cover 渐变、gut-punch、caveats 等）。
- 若未来需要「一键保存文件」体验，再评估 Rust 程序化 print-to-pdf（路线 B）。
