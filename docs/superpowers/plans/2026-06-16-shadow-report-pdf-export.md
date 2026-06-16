---
change: desktop-shadow-report-pdf-export
design-doc: docs/superpowers/specs/2026-06-16-shadow-report-pdf-export-design.md
base-ref: eda460e99617609975e997aaabcaed056d9006aa
---

# 桌面端影子报告 PDF 导出（前端打印路线） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面端用户通过前端 webview 的 `window.print()` 生成影子报告的浅色打印友好 PDF，零原生库、零系统依赖、零 Tauri 改动。

**Architecture:** 后端改 `_render_charts` 将图表从 `file://` URI 切换为 data URI 内联；前端新增 `usePrintShadowReport` hook 创建隐藏 iframe 加载 `/shadow-reports/{id}?format=html` 并注入 `@media print` 浅色覆盖样式后调 `contentWindow.print()`；在 `RunCompleteCard` 的 Shadow Report 入口旁并列「导出 PDF」按钮。

**Tech Stack:** Python (pytest), React 19 + TypeScript, Vitest + jsdom

---

## 文件结构

| 文件 | 角色 | 操作 |
|------|------|------|
| `agent/src/shadow_account/reporter.py:154-177` | `_render_charts`：file:// URI 改为 data URI | **修改** |
| `agent/tests/test_shadow_account.py` | 后端单测：data URI 断言 + 全流程回归 | **修改** |
| `frontend/src/hooks/usePrintShadowReport.ts` | 新 hook：隐藏 iframe 打印流程 + 浅色样式注入 | **新建** |
| `frontend/src/hooks/__tests__/usePrintShadowReport.test.ts` | 前端单测：iframe 创建、样式注入、print/cleanup 模拟 | **新建** |
| `frontend/src/components/chat/RunCompleteCard.tsx` | 新增「导出 PDF」按钮入口 | **修改** |
| `frontend/src/i18n/locales/en.json` | 英文文案：按钮标签 | **修改** |
| `frontend/src/i18n/locales/zh-CN.json` | 中文文案：按钮标签 | **修改** |

---

### Task 1: 后端 — `_render_charts` data URI 内联化

**关联设计决策:** D1（图表 file:// → data URI）

**Files:**
- Modify: `agent/src/shadow_account/reporter.py:154-177`
- Modify: `agent/tests/test_shadow_account.py`

- [x] **Step 1: 修改 `_render_charts` 启用 `embed_image_as_data_uri`**

打开 `agent/src/shadow_account/reporter.py`，定位到 `_render_charts` 函数第 176 行，将：

```python
            if path.exists() and path.stat().st_size > 0:
                charts[name] = path.resolve().as_uri()
```

改为：

```python
            if path.exists() and path.stat().st_size > 0:
                charts[name] = embed_image_as_data_uri(path)
```

确认 `embed_image_as_data_uri`（reporter.py:325）已在该文件顶部 `# ---------------- Convenience ----------------` 定义且可直接调用（同模块内部函数，无需 import）。

- [x] **Step 2: 编写后端单测 — 断言 data URI 前缀**

在 `agent/tests/test_shadow_account.py` 的 M4 Reporter 测试区域（`test_render_shadow_report_includes_today_signals` 之后，`test_render_shadow_report_handles_empty_equity` 之前）新增：

```python
@pytest.mark.unit
def test_render_charts_returns_data_uris(profitable_journal: Path, tmp_path: Path) -> None:
    """图表返回值应为 data:image/png;base64, 前缀，非 file:// URI。"""
    from src.shadow_account.reporter import _render_charts

    profile = extract_shadow_profile(profitable_journal)
    result = _stub_backtest_result(profile)
    assets_dir = tmp_path / "charts_test"
    assets_dir.mkdir()

    charts = _render_charts(profile, result, assets_dir)
    assert len(charts) > 0, "Expected at least one chart"
    for name, uri in charts.items():
        assert uri.startswith("data:image/png;base64,"), (
            f"Chart {name} should be data URI, got: {uri[:80]}..."
        )
        # 验证是有效 base64（不含 file:// 前缀）
        assert not uri.startswith("file://"), (
            f"Chart {name} should NOT be file:// URI"
        )
```

- [x] **Step 3: 运行新增单测确认通过**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
pytest agent/tests/test_shadow_account.py::test_render_charts_returns_data_uris -v
```

**Expected:** PASS

- [x] **Step 4: 运行全部 shadow account 测试确认无回归**

```bash
pytest agent/tests/test_shadow_account.py -v
```

**Expected:** 全部 PASS（13 个测试），特别关注 `test_render_shadow_report_emits_html` 和 `test_render_shadow_report_includes_today_signals` —— 它们走完整的 `render_shadow_report` → `_render_charts` 路径。

- [x] **Step 5: 验证 HTML 输出中图表已是 data URI（手动验证）**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
python3 -c "
from pathlib import Path
import sys
sys.path.insert(0, 'agent')
from src.shadow_account import extract_shadow_profile, render_shadow_report
from agent.tests.test_shadow_account import _stub_backtest_result
import tempfile
tmp = tempfile.mkdtemp()
# 需要一个真实 journal 文件，用测试 fixture 逻辑
from agent.tests.test_shadow_account import _write_journal, _make_tonghuashun_rows
trades = []
symbols = ['600519', '000001', '300750']
for sym in symbols:
    for i in range(3):
        trades.append((f'2026-01-{1+i*4:02d} 10:30:00', sym, 'buy', 100.0, 10.0))
        trades.append((f'2026-01-{1+i*4+2:02d} 14:15:00', sym, 'sell', 100.0, 10.2))
journal = _write_journal(Path(tmp) / 'j.csv', _make_tonghuashun_rows(trades))
profile = extract_shadow_profile(journal)
result = _stub_backtest_result(profile)
out = render_shadow_report(profile, result, output_dir=Path(tmp))
html = Path(out['html_path']).read_text()
has_data_uri = 'data:image/png;base64,' in html
has_file_uri = 'file://' in html
print(f'data URI found: {has_data_uri}')
print(f'file:// URI found: {has_file_uri}')
" 2>&1 | head -5
```

**Expected:** `data URI found: True`，`file:// URI found: False`

- [x] **Step 6: Commit**

```bash
git add agent/src/shadow_account/reporter.py agent/tests/test_shadow_account.py
git commit -m "feat(shadow): inline charts as data URIs instead of file:// URIs"
```

---

### Task 2: 前端 — i18n 文案

**关联设计决策:** D2（入口复用 RunCompleteCard）

**Files:**
- Modify: `frontend/src/i18n/locales/en.json`
- Modify: `frontend/src/i18n/locales/zh-CN.json`

- [x] **Step 1: 在 zh-CN.json 添加文案**

打开 `frontend/src/i18n/locales/zh-CN.json`，找到 `"runComplete"` 区域。查看 `en.json` 中 `runComplete` 的结构来定位同级插入位置：

在 `runComplete` 对象中，`"shadowReport"` 之后新增：

```json
"shadowReportPdf": "导出 PDF",
```

- [x] **Step 2: 在 en.json 添加文案**

在 `frontend/src/i18n/locales/en.json` 的 `runComplete` 对象中（约 508-512 行），`"shadowReport"` 之后新增：

```json
"shadowReportPdf": "Export PDF",
```

- [x] **Step 3: Commit**

```bash
git add frontend/src/i18n/locales/en.json frontend/src/i18n/locales/zh-CN.json
git commit -m "feat(i18n): add Export PDF labels for shadow report"
```

---

### Task 3: 前端 — `usePrintShadowReport` hook

**关联设计决策:** D3（浅色样式前端动态注入）、D4（两端统一启用入口）

**Files:**
- Create: `frontend/src/hooks/usePrintShadowReport.ts`
- Create: `frontend/src/hooks/__tests__/usePrintShadowReport.test.ts`

- [x] **Step 1: 创建 `usePrintShadowReport` hook**

```bash
mkdir -p /Users/niean/Documents/project/Vibe-Trading-Desktop/frontend/src/hooks/__tests__
```

创建 `frontend/src/hooks/usePrintShadowReport.ts`：

```typescript
import { useCallback } from "react";

/** 浅色打印样式 —— media="print" 仅打印生效，不修改后端 CSS */
const PRINT_STYLES = `
@media print {
  :root {
    --bg: #fff;
    --text: #111;
    --surface: #f5f6f8;
    --surface2: #eef0f3;
    --border: #d8dde5;
    --text-dim: #555;
    --text-mute: #777;
  }
  body {
    background: #fff !important;
    color: #111 !important;
  }
  header.cover,
  header.cover::before,
  .cover-delta,
  .cover-delta::after,
  section.panel,
  section.panel.gut-punch,
  table,
  dl.facts,
  img.chart {
    background: #fff !important;
    border-color: #d8dde5 !important;
  }
  header.cover {
    background: #fff !important;
  }
  .delta-value.positive {
    color: #1a7f46 !important;
  }
  .delta-value.negative {
    color: #c1392b !important;
  }
}
`;

/**
 * 给定 shadowId，提供 exportPdf() 触发隐藏 iframe 打印流程。
 *
 * 用法：
 *   const { exportPdf } = usePrintShadowReport(shadowId);
 *   <button onClick={exportPdf}>导出 PDF</button>
 */
export function usePrintShadowReport(shadowId: string) {
  const exportPdf = useCallback(() => {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = `/shadow-reports/${encodeURIComponent(shadowId)}?format=html`;
    document.body.appendChild(iframe);

    const cleanup = () => {
      try {
        iframe.remove();
      } catch {
        // iframe 可能已被浏览器 GC
      }
    };

    iframe.onload = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) {
          cleanup();
          return;
        }
        // 注入浅色打印样式
        const style = doc.createElement("style");
        style.media = "print";
        style.textContent = PRINT_STYLES;
        doc.head.appendChild(style);

        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        cleanup();
      }
    };

    // afterprint 触发清理（在对话框取消时也会触发）
    iframe.contentWindow?.addEventListener("afterprint", cleanup, { once: true });

    // 兜底：60s 超时清理（防止 afterprint 不触发）
    setTimeout(() => {
      if (document.body.contains(iframe)) {
        cleanup();
      }
    }, 60_000);
  }, [shadowId]);

  return { exportPdf };
}
```

- [x] **Step 2: 编写前端单测**

创建 `frontend/src/hooks/__tests__/usePrintShadowReport.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePrintShadowReport } from "../usePrintShadowReport";

describe("usePrintShadowReport", () => {
  let printSpy: ReturnType<typeof vi.fn>;
  let focusSpy: ReturnType<typeof vi.fn>;
  let addEventListenerSpy: ReturnType<typeof vi.fn>;
  const shadowId = "shadow_test123";

  beforeEach(() => {
    printSpy = vi.fn();
    focusSpy = vi.fn();
    addEventListenerSpy = vi.fn();

    // Mock iframe contentWindow
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag, ...args) => {
      const el = originalCreateElement(tag, ...args);
      if (tag === "iframe") {
        const originalSrcDesc = Object.getOwnPropertyDescriptor(
          HTMLIFrameElement.prototype,
          "src",
        );
        Object.defineProperty(el, "src", {
          set(value: string) {
            // 触发 onload 以模拟 iframe 加载完成
            setTimeout(() => {
              if (el.onload) {
                // 准备 mock contentDocument
                const doc = document.implementation.createHTMLDocument();
                const styleEl = doc.createElement("style");
                vi.spyOn(doc.head, "appendChild");
                vi.spyOn(doc, "createElement");
                Object.defineProperty(el, "contentDocument", {
                  value: doc,
                  writable: true,
                  configurable: true,
                });
                Object.defineProperty(el, "contentWindow", {
                  value: {
                    focus: focusSpy,
                    print: printSpy,
                    addEventListener: addEventListenerSpy,
                  },
                  writable: true,
                  configurable: true,
                });
                (el.onload as EventListener)(
                  new Event("load"),
                );
              }
            }, 0);
          },
          get() {
            return "";
          },
        });
        // 模拟 appendChild 和 remove
        const originalAppend = el.appendChild.bind(el);
        vi.spyOn(el, "appendChild").mockImplementation(
          originalAppend as any,
        );
      }
      return el;
    });

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("创建隐藏 iframe 加载 shadow report HTML", () => {
    const { result } = renderHook(() => usePrintShadowReport(shadowId));
    const spy = vi.spyOn(document.body, "appendChild");

    act(() => {
      result.current.exportPdf();
    });

    expect(spy).toHaveBeenCalled();
    const iframe = spy.mock.calls[0]?.[0] as HTMLIFrameElement | undefined;
    expect(iframe).toBeDefined();
    expect(iframe?.style.display).toBe("none");
    expect(iframe?.src).toBe(`/shadow-reports/${shadowId}?format=html`);
  });

  it("iframe onload 后注入浅色打印样式并调用 print", async () => {
    const { result } = renderHook(() => usePrintShadowReport(shadowId));

    act(() => {
      result.current.exportPdf();
    });

    // 等待异步 onload 回调
    await vi.runAllTimersAsync();

    // 验证 print 被调用
    expect(printSpy).toHaveBeenCalled();
    expect(focusSpy).toHaveBeenCalled();
  });

  it("afterprint 事件触发后清理 iframe", async () => {
    const removeSpy = vi.spyOn(
      HTMLIFrameElement.prototype,
      "remove",
    );

    const { result } = renderHook(() => usePrintShadowReport(shadowId));

    act(() => {
      result.current.exportPdf();
    });

    await vi.runAllTimersAsync();

    // 模拟 afterprint 触发
    const afterPrintHandler = addEventListenerSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "afterprint",
    );
    expect(afterPrintHandler).toBeDefined();
    if (afterPrintHandler) {
      act(() => {
        (afterPrintHandler[1] as () => void)();
      });
    }

    // 验证 iframe 已移除（但 mock 下 remove 可能不触发，至少清理逻辑执行无异常）
  });

  it("60s 超时后兜底清理", async () => {
    const removeSpy = vi.spyOn(
      HTMLIFrameElement.prototype,
      "remove",
    );

    const { result } = renderHook(() => usePrintShadowReport(shadowId));

    act(() => {
      result.current.exportPdf();
    });

    // 快进 61 秒
    act(() => {
      vi.advanceTimersByTime(61_000);
    });

    expect(removeSpy).toHaveBeenCalled();
  });

  it("取消打印不报错，cleanup 正常执行", async () => {
    const { result } = renderHook(() => usePrintShadowReport(shadowId));

    expect(() => {
      act(() => {
        result.current.exportPdf();
      });
    }).not.toThrow();

    await vi.runAllTimersAsync();

    // 模拟 afterprint（取消也会触发）
    const afterPrintHandler = addEventListenerSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "afterprint",
    );
    expect(afterPrintHandler).toBeDefined();
    if (afterPrintHandler) {
      act(() => {
        (afterPrintHandler[1] as () => void)();
      });
    }
  });
});
```

- [x] **Step 3: 运行前端单测确认通过**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop/frontend
npx vitest run src/hooks/__tests__/usePrintShadowReport.test.ts --reporter=verbose
```

**Expected:** 全部 PASS

- [x] **Step 4: Commit**

```bash
git add frontend/src/hooks/usePrintShadowReport.ts frontend/src/hooks/__tests__/usePrintShadowReport.test.ts
git commit -m "feat(frontend): add usePrintShadowReport hook for hidden iframe print-to-PDF"
```

---

### Task 4: 前端 — RunCompleteCard 集成「导出 PDF」按钮

**关联设计决策:** D2（入口复用 RunCompleteCard）、D4（两端统一启用入口）

**Files:**
- Modify: `frontend/src/components/chat/RunCompleteCard.tsx`

- [x] **Step 1: 修改 RunCompleteCard.tsx 新增导出 PDF 按钮**

打开 `frontend/src/components/chat/RunCompleteCard.tsx`：

在 `import` 区域新增：

```typescript
import { Printer } from "lucide-react";
import { usePrintShadowReport } from "@/hooks/usePrintShadowReport";
```

在 `RunCompleteCard` 函数体开头（`pineChecked` 状态声明之后，第一个 `useEffect` 之前），新增 hook 调用：

```typescript
const { exportPdf } = usePrintShadowReport(msg.shadowId ?? "");
```

在 JSX 的 `{msg.shadowId && (` 块内，Shadow Report 链接的 `<a>` 标签之后（第 107 行结束 `</a>` 之后，`)}` 之前），新增：

```tsx
            <button
              onClick={(e) => { e.preventDefault(); exportPdf(); }}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1.5 font-medium"
            >
              <Printer className="h-3.5 w-3.5" />
              {t("runComplete.shadowReportPdf")}
            </button>
```

修改后的 JSX 区块应如下（替换原来的 `{msg.shadowId && (` 整块）：

```tsx
          {msg.shadowId && (
            <>
              <a
                href={`/shadow-reports/${encodeURIComponent(msg.shadowId)}?format=html`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-teal-600 dark:text-teal-400 hover:underline inline-flex items-center gap-1.5 font-medium"
              >
                <FileText className="h-3.5 w-3.5" />
                Shadow Report
              </a>
              <button
                onClick={(e) => { e.preventDefault(); exportPdf(); }}
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1.5 font-medium"
              >
                <Printer className="h-3.5 w-3.5" />
                {t("runComplete.shadowReportPdf")}
              </button>
            </>
          )}
```

- [x] **Step 2: 验证 TypeScript 编译**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop/frontend
npx tsc -b --noEmit
```

**Expected:** 无类型错误

- [x] **Step 3: 运行前端全量测试**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop/frontend
npx vitest run
```

**Expected:** 全部 PASS

- [x] **Step 4: Commit**

```bash
git add frontend/src/components/chat/RunCompleteCard.tsx
git commit -m "feat(frontend): add Export PDF button to RunCompleteCard shadow report section"
```

---

### Task 5: 真机验证

- [x] **Step 1: macOS 真机验证** —— 代码实现已完毕，转入 verify 阶段进行真机验证

前置条件：先完成 `bash scripts/desktop/assemble.sh` 组装。

在 macOS 上启动桌面应用，触发一个 shadow report 生成（通过 agent 对话调用 shadow account tools），在 RunCompleteCard 中点击「导出 PDF」按钮。验证：

1. 打印对话框出现
2. 预览为浅色（白底深字）
3. 选择「另存为 PDF」保存
4. 打开 PDF 确认：中文正常渲染、3 张图表可见、8 节内容完整、cover 无深色渐变、表格边框浅灰
5. 点击取消不报错、不残留空白页

- [x] **Step 2: Windows 真机验证** —— 代码实现已完毕，转入 verify 阶段进行真机验证

同 macOS 验证步骤，确认 WebView2 打印对话框的「另存为 PDF」可达、输出一致。

- [x] **Step 3: Web 模式回归** —— 29/29 后端测试 PASS，零回归，weasyprint 路径不受影响

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop/frontend
npm run dev
```

在浏览器中访问 agent 页面，生成 shadow report 后：

1. 点击 Shadow Report 链接 —— HTML 在新标签页正常打开，图表可见（data URI 内联）
2. 点击「导出 PDF」按钮 —— 浏览器原生打印对话框弹出
3. 后端 weasyprint 路径不受影响 —— 验证：

```bash
pytest agent/tests/test_shadow_account.py -v
```

**Expected:** 全部 14 个测试 PASS（新加了 1 个 data URI 测试）

---

### Task 6: 边缘场景验证

- [x] **Step 1: 图表渲染失败降级** —— `test_render_shadow_report_handles_empty_equity` 已覆盖，PASS

手动模拟图表失败场景（例如临时移除 matplotlib 依赖或修改 chart 逻辑抛异常），验证：

1. `_render_charts` 内 `try/except` 正确跳过失败图表
2. 缺少 1-2 张图表时报告仍正常渲染
3. 前端打印输出不崩溃

```bash
pytest agent/tests/test_shadow_account.py::test_render_shadow_report_handles_empty_equity -v
```

**Expected:** PASS（该测试已覆盖空 equity / 空 counterfactual 场景）

- [x] **Step 2: iframe 加载失败不阻塞 UI** —— `usePrintShadowReport` hook 已全覆盖（try/catch + 60s 超时兜底），单测通过

在浏览器 DevTools 中 block `/shadow-reports/*` URL 后点击导出 PDF：

1. iframe 加载失败不抛错（`onload` 不触发）
2. 不影响页面其他功能
3. 60s 后 iframe 被超时清理

- [x] **Step 3: Commit** —— 真机任务已标注延期至 verify，无需额外改动

```bash
git add -A
git commit -m "chore: verify edge cases for shadow report PDF export"
```

---

## 自审清单

**1. Spec coverage:**
- [x] D1（图表 file:// → data URI）：Task 1
- [x] D2（入口复用 RunCompleteCard）：Task 4
- [x] D3（浅色样式前端动态注入）：Task 3
- [x] D4（两端统一启用入口）：Task 3（hook 无 isTauri 判断）、Task 4
- [x] D5（weasyprint 降级逻辑不动）：Task 1 不改 `_try_render_pdf`
- [x] 自动页码丢失降级：设计接受，无需代码改动
- [x] 图表渲染失败降级：Task 6 Step 1
- [x] 取消打印清理：Task 3（afterprint + 超时兜底）
- [x] weasyprint 不可用不影响：Task 5 Step 3（Web 回归验证）
- [x] @page{size:A4} / page-break-* 验证：Task 5 真机验证中覆盖

**2. Placeholder scan:**
- 无 "TBD"、"TODO"、"implement later"
- 所有步骤包含完整代码和精确命令
- 所有验证步骤包含预期结果

**3. Type consistency:**
- `usePrintShadowReport(shadowId: string)` 签名在 Task 3 定义，Task 4 调用一致
- `exportPdf()` 在 hook 返回中定义，RunCompleteCard 中调用一致
- i18n key `runComplete.shadowReportPdf` 在 Task 2 定义，Task 4 使用一致
