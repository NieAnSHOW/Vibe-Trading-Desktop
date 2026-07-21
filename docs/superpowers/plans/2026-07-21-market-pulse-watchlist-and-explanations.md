# 市场异动自选与详细说明 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让市场异动中的股票可直接加入自选，并在详情区显示结构化解读和原始异动说明。

**Architecture:** 新增无 UI、无 store 依赖的说明生成模块，按现有分类函数把 `MarketPulseItem` 转为三段固定、非投资建议的文案。`MarketPulsePanel` 复用 `useWatchlistStore` 和 sonner；列表改为选择按钮与图标操作按钮并列，详情操作使用文字按钮，所有入口按代码共享提交和成功状态。

**Tech Stack:** React 19、TypeScript strict、Zustand、Lucide、sonner、Vitest、Testing Library、Tailwind CSS。

## Global Constraints

- 只能使用 `MarketPulseItem.changeType`、`info` 和现有分类结果；不得补造价格、成交量、新闻原因或交易建议。
- 复用 `/watchlist/stocks` 既有 store/API；不修改后端、分类函数或接口契约。
- 已自选和本次成功加入的股票不可重复提交；失败后恢复可用状态。
- 列表行不得嵌套交互元素；操作按钮使用 Lucide 图标、`aria-label` 和 `title`。
- 新文案通过 `t(key, fallback)` 提供中文 fallback；本 change 不编辑 locale JSON。
- 测试先行：每项先观察目标测试失败，再写最小实现；完成后运行组件测试和 `npm run build`。
- 不触及 `agent/src/live/`，不执行任何实盘或写入型交易流程。

---

### Task 1: 纯异动说明规则

**Files:**
- Create: `frontend/src/components/market-pulse/marketPulseExplanation.ts`
- Create: `frontend/src/components/market-pulse/__tests__/marketPulseExplanation.test.ts`

**Interfaces:**
- Consumes: `MarketPulseItem` from `@/lib/stockSdk` and `categorizeMarketPulse` from `./marketPulse`.
- Produces: `getMarketPulseExplanation(item: MarketPulseItem): MarketPulseExplanation`.

- [ ] **Step 1: Write the failing test**

```ts
it.each([["封涨停板", "涨停异动"], ["火箭发射", "上涨异动"], ["高台跳水", "下跌异动"], ["打开涨停板", "跌停/炸板"], ["成交放量", "成交/资金"], ["未知事件", "未归类盘中变化"]])("describes %s", (changeType, signal) => {
  const result = getMarketPulseExplanation(event(changeType));
  expect(result.signal).toContain(signal);
  expect(result.interpretation).not.toHaveLength(0);
  expect(result.risk).not.toHaveLength(0);
});
```

`event(changeType)` returns a complete `MarketPulseItem` fixture and the test imports the new helper from `../marketPulseExplanation`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/market-pulse/__tests__/marketPulseExplanation.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface MarketPulseExplanation { signal: string; interpretation: string; risk: string; }

export function getMarketPulseExplanation(item: MarketPulseItem): MarketPulseExplanation {
  const category = categorizeMarketPulse(item);
  return EXPLANATIONS[category === "all" ? "other" : category];
}
```

Define `EXPLANATIONS` with these exact values; do not interpolate `info` or add market facts:

| Category | Signal | Interpretation | Risk |
| --- | --- | --- | --- |
| `limitUp` | 涨停异动：封板或冲板信号 | 盘中买方力量增强，需观察封板是否持续。 | 封单变化和炸板会放大波动，次日表现存在不确定性。 |
| `upward` | 上涨异动：短时上行信号 | 盘中买盘或价格动能增强，需结合后续量价验证。 | 短时拉升不代表趋势确认，注意追高与回落风险。 |
| `downward` | 下跌异动：短时走弱信号 | 盘中卖压或下行动能增强，需观察后续承接。 | 支撑失守、流动性变化和情绪扩散可能加剧波动。 |
| `limitDownBroken` | 跌停/炸板：强势价格状态变化 | 封板被打开或下行压力显现，盘中分歧正在扩大。 | 封单和承接快速变化时，价格波动可能加大。 |
| `turnoverCapital` | 成交/资金：盘中活动异常 | 成交或资金活动出现变化，单一时点不足以确认趋势。 | 资金与成交信号需要结合持续性和整体行情验证。 |
| `other` | 未归类盘中变化 | 系统检测到尚未归类的异动，需要结合行情进一步判断。 | 请结合公开信息和后续行情验证，避免仅凭单条信号决策。 |

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/market-pulse/__tests__/marketPulseExplanation.test.ts`

Expected: PASS with one assertion set for every category.

- [ ] **Step 5: Commit**

Run: `git add frontend/src/components/market-pulse/marketPulseExplanation.ts frontend/src/components/market-pulse/__tests__/marketPulseExplanation.test.ts && git commit -s -m "feat(market-pulse): explain event signals"`

### Task 2: 加入自选入口与详情说明

**Files:**
- Modify: `frontend/src/components/market-pulse/MarketPulsePanel.tsx`
- Modify: `frontend/src/components/market-pulse/__tests__/MarketPulsePanel.test.tsx`

**Interfaces:**
- Consumes: `getMarketPulseExplanation(item)`, `useWatchlistStore(state => state.stocks | state.refresh | state.add)`, and `toast` from `sonner`.
- Produces: list and detail actions with accessible names `加入自选 {{code}}` and `已自选 {{code}}`; detail headings “信号含义”, “盘面解读”, “关注风险”, and “原始异动说明”.

- [ ] **Step 1: Write failing component tests**

```ts
const watchlistState = vi.hoisted(() => ({
  stocks: [] as Array<{ code: string; name?: string | null; market: string; added_at: string }>,
  refresh: vi.fn<() => Promise<void>>(),
  add: vi.fn<(code: string) => Promise<{ added: boolean; exists: boolean }>>(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("@/stores/watchlist", () => ({ useWatchlistStore: <T,>(select: (state: typeof watchlistState) => T) => select(watchlistState) }));
vi.mock("sonner", () => ({ toast }));
```

Add four cases: successful `加入自选 600519` invokes `add("600519")`, success feedback, and updates both list/detail actions; a preset watchlist makes the action disabled without an `add` call; rejection shows error feedback then re-enables the action; the selected event shows all four headings and its raw `info`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/market-pulse/__tests__/MarketPulsePanel.test.tsx`

Expected: FAIL because the store and structured explanation are not rendered.

- [ ] **Step 3: Implement the minimal component changes**

```ts
const addToWatchlist = async (code: string) => {
  if (watchedCodes.has(code) || addingCodes.has(code)) return;
  setAddingCodes((current) => new Set(current).add(code));
  try {
    const result = await add(code);
    setAddedCodes((current) => new Set(current).add(code));
    if (result.exists) toast.info(t("watchlist.alreadyAdded", "{{code}} 已在自选股中", { code }));
    else toast.success(t("watchlist.added", "已添加 {{code}}", { code }));
  } catch { toast.error(t("watchlist.addError", "添加失败，请稍后重试")); }
  finally { setAddingCodes((current) => { const next = new Set(current); next.delete(code); return next; }); }
};
```

Import `Check`, `Star`, `toast`, `useWatchlistStore`, and `getMarketPulseExplanation`. Refresh the watchlist on mount. Replace each list row's outer button with a flex wrapper containing its selection button plus a sibling icon action; use `Star` when actionable and disabled `Check` when watched. Render an icon-and-text detail action beside the badge. Render the three fields from `getMarketPulseExplanation(selectedEvent.item)`, then `item.info` under “原始异动说明”, using current focus, disabled and tone classes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/market-pulse/__tests__/MarketPulsePanel.test.tsx`

Expected: PASS, including all new cases and existing panel tests.

- [ ] **Step 5: Commit**

Run: `git add frontend/src/components/market-pulse/MarketPulsePanel.tsx frontend/src/components/market-pulse/__tests__/MarketPulsePanel.test.tsx && git commit -s -m "feat(market-pulse): add watchlist actions"`

### Task 3: 集成验证与独立审查

**Files:**
- Verify only: `frontend/src/components/market-pulse/**`

**Interfaces:**
- Consumes: completed Task 1 and Task 2 behavior.
- Produces: passing test/build evidence and independent review findings.

- [ ] **Step 1: Run focused tests**

Run: `cd frontend && npx vitest run src/components/market-pulse/__tests__/marketPulseExplanation.test.ts src/components/market-pulse/__tests__/MarketPulsePanel.test.tsx`

Expected: PASS with no test failures.

- [ ] **Step 2: Run the frontend build**

Run: `cd frontend && npm run build`

Expected: `tsc -b && vite build` completes with exit code 0.

- [ ] **Step 3: Request independent review**

Give an independent reviewer the final diff. It must check nested interactive controls, add/error/duplicate flows, TypeScript strictness, and no-investment-advice wording.

- [ ] **Step 4: Resolve confirmed review findings**

For each confirmed finding, add a focused failing test before changing production code; rerun the focused test and build after the fix.

- [ ] **Step 5: Commit verification fixes only when needed**

Run: `git add frontend/src/components/market-pulse && git commit -s -m "fix(market-pulse): address review findings"`
