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

    // afterprint 触发清理（在对话框取消时也会触发）
    iframe.contentWindow?.addEventListener("afterprint", cleanup, {
      once: true,
    });

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

    // 兜底：60s 超时清理（防止 afterprint 不触发）
    setTimeout(() => {
      if (document.body.contains(iframe)) {
        cleanup();
      }
    }, 60_000);
  }, [shadowId]);

  return { exportPdf };
}
