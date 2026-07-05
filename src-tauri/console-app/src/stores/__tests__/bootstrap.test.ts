import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useBootstrapStore } from "../bootstrap";

describe("bootstrap store 进度条算法", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("start() 后进入 running 态,百分比从低起点开始", () => {
    const s = useBootstrapStore();
    s.start();
    expect(s.state).toBe("running");
    expect(s.visible).toBe(true);
    expect(s.pct).toBeGreaterThanOrEqual(1);
    expect(s.pct).toBeLessThan(15);
  });

  it("advance('venv') 跳到 venv 阶段基准 5-15", () => {
    const s = useBootstrapStore();
    s.start();
    s.advance("venv", "创建虚拟环境");
    expect(s.pct).toBeGreaterThanOrEqual(5);
    expect(s.pct).toBeLessThanOrEqual(15);
    expect(s.stageLabel).toBe("创建虚拟环境");
  });

  it("advance('installing') 渐近爬升且单调不倒退", () => {
    const s = useBootstrapStore();
    s.start();
    s.advance("installing", "downloading a");
    const p1 = s.pct;
    s.advance("installing", "downloading b");
    const p2 = s.pct;
    s.advance("installing", "downloading c");
    const p3 = s.pct;
    expect(p2).toBeGreaterThan(p1);
    expect(p3).toBeGreaterThan(p2);
    // 永不到 100%
    expect(s3PctMax(s, 50)).toBeLessThan(92);
  });

  it("advance('done') 直接到 100%", () => {
    const s = useBootstrapStore();
    s.start();
    s.advance("done", "安装完成");
    expect(s.pct).toBe(100);
    expect(s.state).toBe("done");
    expect(s.spinning).toBe(false);
  });

  it("advance('failed') 停在当前百分比,标记失败", () => {
    const s = useBootstrapStore();
    s.start();
    s.advance("installing", "x");
    const midPct = s.pct;
    s.advance("failed", "");
    expect(s.state).toBe("failed");
    expect(s.pct).toBe(midPct); // 不强推 100
  });

  it("百分比单调不倒退:smaller 输入不会回退", () => {
    const s = useBootstrapStore();
    s.start();
    s.advance("installing", "a");
    const high = s.pct;
    // 模拟后退输入(stage 回到 venv 的低基准不应让 pct 倒退)
    s.advance("venv", "重新创建");
    expect(s.pct).toBeGreaterThanOrEqual(high);
  });
});

// helper:推 N 次 installing,返回最大 pct
function s3PctMax(s: ReturnType<typeof useBootstrapStore>, n: number): number {
  for (let i = 0; i < n; i++) s.advance("installing", "x");
  return s.pct;
}
