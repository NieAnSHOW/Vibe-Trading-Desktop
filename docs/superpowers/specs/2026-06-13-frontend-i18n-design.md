# 前端 i18n 多语言切换 — 设计文档

- **日期**：2026-06-13
- **状态**：已通过设计评审，待编写实现计划
- **作者**：Claude（brainstorming 协作产出）
- **涉及范围**：`frontend/`（React 19 + Vite 6 + TypeScript + Zustand 5 + react-router-dom 7 + Tailwind 3）

## 1. 背景与目标

Vibe-Trading-Desktop 前端目前所有 UI 文案均为英文硬编码，分布在约 42 个 `.tsx` 文件（7 个 `pages/` + `components/{chat,layout,charts,common}` 四层），无任何 i18n 基础设施。

**目标**：为前端加入中英双语切换能力，用户可在应用内切换界面语言，选择被持久化。

**非目标（YAGNI）**：
- 不翻译 agent 的 LLM 动态回复、技能输出、回测报告（由用户提示词 / LLM 语言决定）。
- 不联动数字 / 日期 / 货币的 locale 格式化（`formatters.ts` 保持 `undefined` locale 不变）。
- 不做复数 / 性别 / ICU 语法（当前静态文案无此需求）。
- 不做按语言懒加载 chunk（双语言全量打包，体积可控）。

## 2. 需求确认（已与用户澄清）

| 维度 | 决定 |
| --- | --- |
| 支持语言 | 简体中文 + 英文 |
| 翻译范围 | 仅静态 UI 文案（按钮、导航、标签、空状态、设置项、错误提示等） |
| 默认语言 | 首次默认简体中文；用户手动切换后 `localStorage` 持久化记住 |
| 检测策略 | `localStorage` 优先，否则默认 `zh`（不读 `navigator.language`） |

## 3. 方案选型

三个候选：

- **A. react-i18next**：行业标准，命名空间 / 复数 / 懒加载 / 提取工具齐全；但新增约 45–55KB 依赖与配置样板，默认 key 无编译期检查。
- **B. react-intl (FormatJS)**：ICU 复数与数字格式化最强；对本项目「静态文案、不做格式化联动」属杀鸡用牛刀。
- **C. 轻量自建（Context + 强类型字典 + `t()`）**：零运行时依赖；TS 字典类型让 `t()` 的 key 在**编译期**即受约束（拼错直接报错）；实现简单、完全可控；与项目克制依赖的风格一致。

**选定方案 C。** 理由：范围明确（双语、仅静态文案、不联动格式化）、项目依赖克制、TS strict，自建方案的零依赖与编译期 key 安全正好匹配；A/B 的核心优势（复数、ICU、懒加载）在本场景用不上。代价：若未来扩展到 3+ 语言或需要复杂插值，需迁移至 A——届时 `t()` 调用点 API 可保持兼容，迁移成本主要在字典与 Provider 内部。

## 4. 详细设计

### 4.1 模块结构

新建 `frontend/src/i18n/`：

```
src/i18n/
├── index.ts          // 对外出口：LanguageProvider、useI18n、类型
├── context.tsx       // React Context + Provider（依赖 React）
├── translator.ts     // 纯函数：get(obj, path)、t(dict, key, vars?)、插值（不依赖 React，可独立单测）
├── types.ts          // Translation 类型、NestedKeyOf<T>、KeyPath 联合类型
└── locales/
    ├── zh.ts         // 简中源字典（as const），类型基准
    └── en.ts         // 英文字典，须 satisfies Translation
```

**职责边界**：`translator.ts` 是纯函数模块，不 import React，便于直接单测；`context.tsx` 仅在它之上提供 React 绑定。每个文件单一职责、可独立理解与测试。

### 4.2 字典与类型安全

按模块命名空间组织（避免扁平大对象）。`zh.ts` 为源字典：

```ts
export const zh = {
  common: {
    confirm: "确认", cancel: "取消", save: "保存", delete: "删除",
    loading: "加载中…", rename: "重命名", expand: "展开", collapse: "收起",
  },
  nav: {
    home: "首页", agent: "Agent", alphaZoo: "Alpha 动物园",
    settings: "设置", correlation: "相关性矩阵",
  },
  layout: {
    sessions: "会话", newChat: "新对话", noSessions: "暂无会话",
    light: "浅色", dark: "深色",
  },
  chat: {
    placeholder: "输入你的问题…",
    sampleDesc: "解析 {{sources}} CSV — 持有天数、胜率、盈亏比、小时分布",
  },
  settings: { title: "设置" /* … */ },
  // …其余按 page/组件补充
} as const;
```

> 上表仅为**结构示意**（展示命名空间层级与 `as const` 用法）。本次实现一次性覆盖全部页面与组件（见 §4.6），字典按模块命名空间补齐 `common` / `nav` / `layout` / `chat` / `charts` / `settings` / `compare` / `correlation` / `alphaZoo` / `home` / `runDetail` 等，复用项归入 `common`。

**编译期安全（核心卖点）**：

- `export type Translation = typeof zh` —— 从源字典推导结构。
- `en.ts` 写作 `export const en = { … } satisfies Translation`（或 `: Translation`）—— key 缺失 / 多余 / 类型不符直接编译失败。
- `NestedKeyOf<Translation>` 递归生成点号路径字面量联合（如 `"common.confirm" | "nav.home" | …`），并导出为 `type KeyPath = NestedKeyOf<Translation>`。
- `t(key: KeyPath)` —— key 参数受该联合类型约束，**拼错编译失败**，强于 i18next 默认行为。

### 4.3 核心 API

`useI18n()` 返回 `{ t, lang, setLang }`：

```tsx
const { t, lang, setLang } = useI18n();
t("nav.home");                              // → "首页"
t("chat.sampleDesc", { sources: "同花顺/东财/富途" }); // → "解析 同花顺/东财/富途 CSV — …"
```

`t()` 实现规则：
1. 用 `get(dict, key)` 按点号路径取值。
2. 值为字符串时，对 `{{name}}` 占位符用 `vars` 做简单替换（正则）。
3. 值非字符串（取到对象 / undefined）或插值变量缺失时：返回 **key 本身**作为兜底，dev 环境（`import.meta.env.DEV`）`console.warn` 指出缺失项；生产环境静默，**永不抛错**。

### 4.4 语言检测与持久化

- 初始化顺序：`localStorage.getItem("vibe-lang")` → 命中则用之；否则默认 `"zh"`。非法值（非 `zh`/`en`）回落 `"zh"`。
- `setLang(lang)`：`localStorage.setItem("vibe-lang", lang)` + 更新 Context state + 同步 `document.documentElement.lang = lang`（无障碍与排版友好）。
- 与现有 `useDarkMode`、`qa-sidebar` 的 localStorage 模式保持一致。

### 4.5 Provider 挂载与切换器 UI

- **Provider 挂载**：`src/main.tsx` 中 `<LanguageProvider>` 包在 `<ErrorBoundary>` 内、`<RouterProvider>` 外，保证全组件树可调用 `useI18n`。
- **切换器位置**：`components/layout/Layout.tsx` 的 sidebar footer，与 dark mode 切换器并排。
- **切换器形态**：双语言用简洁 toggle 按钮——展开态显示目标语言文字（当前为 zh 时显示「EN」，意为「切到英文」；当前为 en 时显示「中」），收起态同样显示缩写并配 `title`。交互与样式与现有 dark mode 按钮（`Sun`/`Moon` 图标按钮）保持一致，复用 `lucide-react` 的 `Languages` 图标作为可选装饰。

### 4.6 改造范围（单阶段全量）

`t()` 仍按**可增量替换**设计（实现时按文件逐步替换，便于 review 与测试），但本次实现**一次性覆盖全部页面与组件**，不分阶段交付。

**实现顺序（供 writing-plans 拆解任务，非交付里程碑）**：

1. **基建**：`src/i18n/`（types / translator / context / locales(zh,en) / index）+ 对应单元测试。
2. **挂载**：`main.tsx` 接入 `<LanguageProvider>`。
3. **框架层**：`router.tsx`（`PageLoader` 的 `Loading…`）、`components/layout/Layout.tsx`（品牌、NAV 标签、Sessions / New Chat / Confirm / Cancel / Rename / Delete? / Expand / Collapse / Light / Dark / No sessions yet）、`components/layout/ConnectionBanner.tsx`、`components/common/{ErrorBoundary,Skeleton}.tsx`。
4. **chat 层**：`components/chat/*` 全部可见文案（含 `WelcomeScreen` 的「同花顺/东财」示例描述，用 `t("chat.sampleDesc", { sources: "同花顺/东财/富途" })` 插值迁移，英文版保留 `generic`）。
5. **charts 层**：`components/charts/*` 中的标题、按钮、空状态、提示等可见文案；`formatters.ts` 的 `METRIC_LABELS` 等纯数据标签一并纳入 i18n（值本身仍是字符串、按 locale 取）。
6. **pages 层**：`Home.tsx`、`Agent.tsx`、`Settings.tsx`、`Compare.tsx`、`Correlation.tsx`、`AlphaZoo.tsx`、`RunDetail.tsx` 逐页抽取标题、按钮、表单标签、占位符、空状态、错误提示等可见文案。
7. **切换器**：`Layout` sidebar footer 上线中 / 英 toggle。
8. **回归**：`npm run build` + `npx vitest run` 全绿。

> 全量替换意味着改动面较广（约 42 个 `.tsx` 文件），但每个文件都是机械式的「硬编码字符串 → `t(key)`」替换 + 字典补充，风险低、可逐文件 review。实现计划（writing-plans）将按上述顺序拆成可独立验证的任务。

## 5. 错误处理与边界

| 情况 | 行为 |
| --- | --- |
| `t()` key 不存在 | 返回 key 字符串；dev 环境 `console.warn` |
| `t()` 插值变量缺失 | 保留 `{{name}}` 原样；dev 环境 `console.warn` |
| `localStorage` 不可用（异常） | 捕获并回落默认 `zh`，不抛错 |
| zh / en 字典结构不一致 | TS 编译期拦截（`satisfies Translation`）+ 运行时遍历测试双保险 |
| `useI18n()` 在 Provider 外调用 | 抛出明确错误（Context 默认值用 `throw` 的 dummy） |

## 6. 测试策略

对齐现有 `vitest` + `@testing-library/react`（jsdom、globals）。新增：

- **`translator.test.ts`**（纯函数，无 React）：
  - `get()` 正常嵌套取值、中间节点非对象、路径不存在。
  - `t()` 正常 key、`{{var}}` 插值、缺失 key 返回 key 本身、插值变量缺失保留占位符、dev warn 触发。
- **`locales.test.ts`**：
  - 递归遍历断言 `zh` 与 `en` 的 key 集合**完全一致**（每条 key 值均为字符串、非空）。
- **`context.test.tsx`**：
  - 默认 `lang === "zh"`；`localStorage` 已存 `"en"` 时初始化为 en。
  - `setLang("en")` 后 `t()` 返回英文、`localStorage` 写入、`document.documentElement.lang` 同步。
  - Provider 外调用 `useI18n()` 抛错。
- 回归：现有测试文件（`stores` / `lib` / `components` 各 `__tests__`）全部保持通过。

## 7. 验收标准

- [ ] 应用默认以简体中文展示所有页面与组件的可见文案。
- [ ] 点击切换器可在中 / 英间切换并即时生效，刷新后保持选择。
- [ ] `<html lang>` 随语言同步。
- [ ] `npm run build`（`tsc -b && vite build`）通过；`npx vitest run` 全绿（含新增 i18n 测试）。
- [ ] 字典 zh / en 结构一致（编译期 + 测试期双保证）。
- [ ] 全部页面与组件的可见文案均已切换为 `t()` 调用，无遗漏的硬编码英文（`WelcomeScreen` 等含专有名词 / 股票代码处除外）。

## 8. 开放问题（实现阶段再定，不阻塞）

- 切换器收起态的最终视觉（纯文字缩写 vs 图标）——实现时按现有 dark mode 按钮风格对齐即可。
- 各页面字典命名空间细分粒度——实现时按模块约定（建议每页一个命名空间，复用项放 `common`）。
