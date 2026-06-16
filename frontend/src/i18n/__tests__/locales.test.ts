import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import zhCN from "../locales/zh-CN.json";

describe("i18n — shadow report PDF export", () => {
  it("en.json runComplete.shadowReportPdf exists and is non-empty", () => {
    const val = (en as Record<string, unknown>).runComplete as Record<string, string> | undefined;
    expect(val?.shadowReportPdf).toBeTypeOf("string");
    expect(val?.shadowReportPdf?.length).toBeGreaterThan(0);
  });

  it("zh-CN.json runComplete.shadowReportPdf exists and is non-empty", () => {
    const val = (zhCN as Record<string, unknown>).runComplete as Record<string, string> | undefined;
    expect(val?.shadowReportPdf).toBeTypeOf("string");
    expect(val?.shadowReportPdf?.length).toBeGreaterThan(0);
  });
});
