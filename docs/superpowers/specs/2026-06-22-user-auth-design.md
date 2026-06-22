# 用户功能设计文档（登录/注册 + 个人信息管理）

- 日期：2026-06-22
- 范围：`Vibe-Trading-Desktop/frontend` 新增 C 端用户体系；后端 `cool-admin-midway` 配套打通短信
- 状态：已通过 brainstorming 澄清，待 writing-plans 细化

## 1. 概述

为 `frontend` 新增面向 C 端用户的：

1. 登录 / 注册（手机号 + 短信验证码，首次验证码登录自动注册，二合一页面）
2. 个人信息管理（MVP：查看 + 编辑昵称/头像/性别 + 退出登录）

采用**最小侵入式**架构：独立的 auth store、独立的 API 层、独立页面、只保护 `/profile` 的路由守卫。与现有 trading 功能（`agent.ts` / `api.ts` / 各业务页面）**零耦合**，trading 保持免登录可用（宽松访问控制）。

后端使用 `cool-admin-midway`（`:8001`）的 C 端 `/app/user/*` 接口；短信通过**新增**的阿里云 DYPNS 逻辑打通，**不修改**原有 `src/modules/user/service/sms.ts`。

## 2. 背景与现状

### 2.1 前端现状（Vibe-Trading-Desktop/frontend）

- 框架：React 19 + Vite + TypeScript（strict）+ Tailwind（darkMode class）+ zustand + react-router v7（lazy + Suspense）
- 现有鉴权：`src/lib/apiAuth.ts` + `src/lib/api.ts` 面向 trading Python 后端（`:8899`），用 `Bearer <api_key>` 的 API Key，存 `localStorage` key `vibe_trading_api_auth_key`。**与用户体系无关、不复用**。
- 状态：单一 `src/stores/agent.ts`（聊天/会话/工具调用），**无 persist**，无 user/auth slice。
- 路由：`src/router.tsx`，全部公开，无路由守卫。
- HTTP：原生 `fetch`，`BASE=""` 走 vite proxy（`vite.config.ts` proxy 列表指向 `:8899`）。
- i18n：`react-i18next`，`zh-CN`（默认）/ `en`。
- 表单样式：`src/pages/Settings.tsx` 定义 `fieldClass` / `labelClass` / `hintClass`。
- 通知：`sonner`。图标：`lucide-react`。

### 2.2 后端现状（cool-admin-midway，`:8001`）

- 框架：Midway.js + cool-admin；两套认证体系（后台管理员 `/admin/base/*` 与 C 端 `/app/user/*`），本次用 C 端。
- C 端 token：访问 token 24h，刷新 token 30 天；放在 `Authorization` header，**不带 Bearer 前缀**。
- 统一响应：`BaseController.ok(data)` → `{ code: 1000, data, message }`。
- 短信：`src/modules/user/service/sms.ts` 依赖插件市场 `sms-ali`/`sms-tx`，当前**未安装**，调用直接抛 `"未配置短信插件"`，**无开发 fallback**。本次不碰它，另起 DYPNS 逻辑。

## 3. 需求与范围

### 3.1 本次交付（前端，核心）

- 登录/注册二合一页（`/login`）
- 个人信息 MVP 页（`/profile`）
- auth 状态管理（`src/stores/auth.ts`，zustand + persist）
- 用户后端 API 层（`src/lib/apiUser.ts`）
- 路由守卫（`src/components/auth/RequireAuth.tsx`，仅保护 `/profile`）
- Header 用户入口（`src/components/layout/UserMenu.tsx`）
- vite proxy `/user-api` + env 配置
- i18n（zh-CN / en）补全
- vitest 单测

### 3.2 非目标（后续工作，不在本次实现）

- 密码登录（`/app/user/login/password`）
- 修改密码（`/app/user/info/updatePassword`）
- 注销账号（`/app/user/info/logoff`）
- 绑定手机号（`/app/user/info/bindPhone`）
- 桌面端（Tauri）将 cool-admin 打包进桌面分发
- 对 trading 功能做登录 gating（已确认为宽松模式，登录可选）
- 微信系登录（mini/mp/wxApp/uniPhone）

### 3.3 后端配套（独立任务）

新增阿里云 DYPNS 短信 service 并接入 `/app/user/login/smsCode` 与 `/app/user/login/phone`，使端到端可跑通。前端只依赖接口契约，可先行开发与单测。

## 4. 后端接口契约（已核对源码）

所有路径经前端 `/user-api` 前缀代理后到达后端原路径。统一响应 `{ code, data, message }`，`code === 1000` 视为成功，否则 `message` 为错误文案。

| 方法 | 路径 | 入参 | 返回 `data` | 鉴权 |
|---|---|---|---|---|
| GET | `/app/user/login/captcha` | query: `width?, height?, color?` | `{ captchaId: string, data: string /* base64 svg */ }` | 否 |
| POST | `/app/user/login/smsCode` | body: `{ phone, captchaId, code }`（`code` = 图形验证码） | `void` | 否 |
| POST | `/app/user/login/phone` | body: `{ phone, smsCode }` | `{ token, refreshToken, expire, refreshExpire }` | 否 |
| POST | `/app/user/login/refreshToken` | body: `{ refreshToken }` | `{ token, refreshToken, expire, refreshExpire }` | 否 |
| GET | `/app/user/info/person` | — | `UserInfo` | 是 |
| POST | `/app/user/info/updatePerson` | body: `{ nickName?, avatarUrl?, gender?, description? }` | `UserInfo` | 是 |
| POST | `/app/base/comm/upload` | multipart: `file` | `{ url: string, ... }`（cool-admin 通用上传返回） | 是 |

`UserInfo`（实体 `user_info`，`src/modules/user/entity/info.ts`）：

```ts
interface UserInfo {
  id: number;
  unionid?: string | null;
  avatarUrl?: string | null;
  nickName?: string | null;
  phone?: string | null;
  gender: number;       // 0 未知 / 1 男 / 2 女
  status: number;       // 0 禁用 / 1 正常 / 2 已注销
  loginType: number;    // 0 小程序 / 1 公众号 / 2 H5
  description?: string | null;
  createTime?: string;
  updateTime?: string;
}
```

**登录流程为双验证码**：图形验证码（防刷）+ 短信验证码。

## 5. 架构设计

```
┌─ React App ──────────────────────────────────────────────┐
│  Header [ UserMenu：登录 / 头像+昵称+退出 ]              │
│  ┌─ Router ───────────────────────────────────────────┐  │
│  │ /login              (公开)  Login.tsx              │  │
│  │ /profile  ◄─ RequireAuth ──  Profile.tsx           │  │
│  │ /  /agent /runs ... (公开，trading 不受影响)       │  │
│  └────────────────────────────────────────────────────┘  │
│  useAuthStore (zustand+persist) ──读 token──► apiUser.ts │
└──────────────────────────────────────────────────────────┘
                          ▼
          vite proxy /user-api → http://127.0.0.1:8001 (cool-admin-midway)
          (trading api.ts → :8899 保持不变)
```

**隔离原则**：auth store / apiUser / 用户页面全部为独立新增文件，不修改 `agent.ts` / `api.ts` / `apiAuth.ts` / 各 trading 页面。删除新增文件后 trading 原样可跑。

## 6. 前端模块设计

### 6.1 类型 `src/types/user.ts`

```ts
export interface UserInfo {
  id: number;
  unionid?: string | null;
  avatarUrl?: string | null;
  nickName?: string | null;
  phone?: string | null;
  gender: number; // 0 未知 / 1 男 / 2 女
  status: number;
  loginType: number;
  description?: string | null;
  createTime?: string;
  updateTime?: string;
}

export interface LoginResult {
  token: string;
  refreshToken: string;
  expire: number;       // 秒
  refreshExpire: number;// 秒
}

export interface Captcha {
  captchaId: string;
  data: string; // base64 svg
}

export type Gender = 0 | 1 | 2;
```

### 6.2 API 层 `src/lib/apiUser.ts`

- `BASE = import.meta.env.VITE_USER_API_BASE || "/user-api"`
- `request<T>(path, options)`：
  - 合并 `Content-Type: application/json`
  - 若 store 有 token → 注入 `Authorization: ${token}`（**不带 Bearer**）
  - `res.ok` 且 `body.code === 1000` → 返回 `body.data as T`
  - `body.code !== 1000` → 抛 `UserApiError(body.message)`
  - HTTP 401 → 触发 token 刷新（见下），刷新成功重试一次，失败抛错并触发 logout
- `upload(file: File)`：multipart，单独处理（不设 JSON content-type）
- `UserApiError`：`{ message, code?, status }`
- **token 刷新**：模块级 `refreshPromise` 锁 + 等待队列，避免并发多次刷新

导出方法（路径对齐第 4 节契约）：

```ts
export const apiUser = {
  getCaptcha: (opts?: { width?: number; height?: number }) => …,
  sendSmsCode: (phone: string, captchaId: string, code: string) => …,
  loginByPhone: (phone: string, smsCode: string) => …,
  refreshToken: (refreshToken: string) => …,
  getPerson: () => …,
  updatePerson: (body: { nickName?: string; avatarUrl?: string; gender?: number; description?: string }) => …,
  upload: (file: File) => Promise<{ url: string }>,
};
```

**注意**：`apiUser` 不复用 `src/lib/api.ts` 的 `ApiError`/`authHeaders`/`AUTH_REQUIRED_MESSAGE`（trading 专用，语义不同），独立实现。

### 6.3 auth store `src/stores/auth.ts`

zustand + `persist`（localStorage key `vibe_trading_auth`，仅持久化 `token/refreshToken/expiresAt/userInfo`）。

```ts
interface AuthState {
  status: "loading" | "authenticated" | "guest";
  token: string | null;
  refreshToken: string | null;
  expiresAt: number | null;     // 毫秒时间戳
  userInfo: UserInfo | null;
  // actions
  bootstrap: () => Promise<void>;                 // 启动时若有 token 则拉取 person
  setSession: (r: LoginResult) => void;
  fetchUserInfo: () => Promise<void>;
  updateUser: (patch: Partial<UserInfo>) => void; // 本地合并
  logout: (opts?: { silent?: boolean }) => void;
}
```

- `logout`：清空 state（persist 同步清除）、可选 toast。
- `bootstrap`：app 启动调用一次；有 token 且未过期 → `fetchUserInfo` → `authenticated`；否则 `guest`。拉取失败（401 且刷新失败）→ `logout({silent:true})` + `guest`。
- 不把 trading 的状态纳入此 store。

### 6.4 路由与守卫

`src/router.tsx` 新增（不改动现有路由项）：

- `/login` → `Login.tsx`（公开）
- `/profile` → 包裹 `<RequireAuth>` → `Profile.tsx`

`src/components/auth/RequireAuth.tsx`：

```tsx
// status === "loading" → 居中 loading
// status === "guest"  → <Navigate to="/login" state={{ from: location }} replace />
// 否则                → <Outlet />
```

**宽松访问控制**：不包裹 trading 路由。trading 页面任何人可访问，登录仅为可选增强。

### 6.5 页面 `src/pages/auth/Login.tsx`

布局（居中卡片，复用 Settings 页样式类）：

```
┌──────────────── Vibe Trading ────────────────┐
│  手机号   [____________________]             │
│  图形验证  [______] [svg图片，点击换一张]     │
│  短信验证  [______] [获取验证码(60s倒计时)]   │
│  [        登录 / 注册        ]               │
│  首次验证码登录将自动注册                    │
└──────────────────────────────────────────────┘
```

状态机与行为：

- 进入页面 → 拉取图形验证码（`getCaptcha`）。
- "获取短信验证码"按钮：点击 → `sendSmsCode(phone, captchaId, 图形码)` → 成功后启动 60s 倒计时；失败（图形码错/手机号无效）→ toast 并刷新图形验证码。
- "登录/注册"按钮：`loginByPhone(phone, 短信码)` → 成功 → `setSession` + `fetchUserInfo` → 跳 `from ?? "/profile"`。
- 字段校验：手机号 11 位数字、图形码与短信码各 4 位；不满足禁用对应按钮。
- 已登录用户访问 `/login` → 自动跳 `/profile`。

### 6.6 页面 `src/pages/profile/Profile.tsx`

布局（左右栏）：

```
┌─ 头像（点击上传） ─┐  ┌─ 昵称  [______]   [保存] ┐
│                   │  │ 性别   ○未知 ○男 ○女     │
│  手机号 138****   │  │ 介绍   [______]（可选）   │
│  [退出登录]       │  └──────────────────────────┘
└───────────────────┘
```

行为：

- 进入 → `fetchUserInfo`（若 store 已有则直接用，可下拉刷新）。
- 头像点击 → 选图 → `upload(file)` → `updatePerson({ avatarUrl })` → 更新 store。
- 昵称/性别/介绍 → 编辑后点保存 → `updatePerson` → toast 成功。
- 手机号脱敏显示（中间 4 位 `*`）。
- "退出登录" → 二次确认 → `logout` → 跳 `/login`。

### 6.7 Header 入口 `src/components/layout/UserMenu.tsx`

嵌入现有 `Layout` 顶部右侧：

- `status === "guest"` → 显示"登录"按钮（`<Link to="/login">`）。
- `status === "authenticated"` → 头像 + 昵称下拉：`个人信息`（跳 `/profile`）、`退出登录`。
- `status === "loading"` → 占位骨架。

## 7. 关键数据流

### 7.1 登录

```
GET captcha → 输手机号+图形码 → sendSmsCode → 输短信码
  → loginByPhone → {token,refreshToken,...}
  → setSession + getPerson → store.authenticated
  → Navigate(from ?? "/profile")
```

### 7.2 请求鉴权与刷新

```
apiUser.request → 注入 Authorization
  → 200 code=1000 : 返回 data
  → 401           : refreshToken()
                       ├ 成功: setSession(新) → 重试原请求
                       └ 失败: logout + 跳 /login
```

并发场景：多个请求同时 401，`refreshPromise` 共享，仅刷新一次，其余等待同一 promise 完成后用新 token 重试。

### 7.3 启动 bootstrap

```
App mount → auth.bootstrap()
  → 有 token 且未过期 → getPerson → authenticated
  → 无 token / 过期    → guest
  → getPerson 401     → refreshToken → 成功则 authenticated / 失败 guest
```

### 7.4 退出

```
logout → 清 store(persist) → Navigate("/login")
```

## 8. 错误处理

- `code !== 1000`：抛 `UserApiError(message)`，调用方用 `sonner` toast 中文文案。
- 网络错/超时：统一提示"网络异常，请稍后重试"。
- 字段校验：手机号非 11 位、验证码非 4 位 → 禁用按钮 + 输入框下方红字。
- 401 静默刷新，仅刷新失败才 toast 并跳登录。
- 头像上传失败：toast，保留旧头像。

## 9. i18n

`src/i18n/locales/zh-CN.json` 与 `en.json` 新增命名空间：

- `auth.*`：标题、手机号、图形验证码、短信验证码、获取验证码、倒计时文案、登录/注册按钮、首次注册提示、各类校验与错误文案。
- `profile.*`：标题、头像、昵称、性别（未知/男/女）、介绍、保存、退出登录、确认退出、上传中等。
- `userMenu.*`：登录、个人信息、退出登录。

默认语言 `zh-CN`。

## 10. 测试策略

vitest + jsdom，置于 `src/**/__tests__/`。

- `apiUser.test.ts`：响应解包（`code=1000` 返回 data）、`code≠1000` 抛错、`Authorization` 注入（裸 token）、401 → refresh → 重试一次成功、refresh 失败抛错（mock `fetch`）。
- `authStore.test.ts`：`setSession` 写入、`logout` 清空、`persist` 读写 localStorage、`bootstrap` 在有/无 token 下的分支。
- `RequireAuth.test.ts`：`guest` 跳 `/login` 并带 `from`、`authenticated` 放行、`loading` 显示骨架。
- `Login.test.ts`：字段校验决定按钮禁用、提交调用正确接口、成功后跳转。

## 11. 后端配套任务（DYPNS，独立文件，不碰 sms.ts）

阿里云 DYPNS（号码认证服务，SDK `@alicloud/dypnsapi20170525`）提供**发送 + 校验**两个配套接口。验证码由阿里云生成、通过短信下发，**阿里云在服务端维护"手机号 ↔ 验证码"映射**——后端不再自己生成、存储、比对验证码。这与原 `login.ts` 的"本地生成 + midwayCache 存 + 本地比对"逻辑根本不同，是该 service 的核心改造点。

### 11.1 两个 DYPNS 接口

| 接口 | 用途 | 关键入参 | 返回 |
|---|---|---|---|
| `SendSmsVerifyCode` | 发送短信验证码 | `PhoneNumber`、`SignName`、`TemplateCode`、`TemplateParam`（如 `{"code":"${code}","min":"5"}`，变量由阿里云填充）、`DuplicatePolicy?`、`SchemeName?` | `BizId` 等，**不返回验证码明文** |
| `CheckSmsVerifyCode` | 校验用户输入的验证码 | `PhoneNumber`、`VerifyCode`（用户输入）、`SchemeName?` | `VerifyResult`（`PASS` / `NOT_PASS` 等），`BizId` |

两者通过 `PhoneNumber` 关联；阿里云侧验证码有效期约 5 分钟。官方示例（JS）仅作参考，实现用 TypeScript import 写法（见 11.2）。

### 11.2 新增 `src/modules/user/service/dypnsSms.ts`（TypeScript）

依赖（后端 `package.json` 新增）：`@alicloud/dypnsapi20170525`、`@alicloud/openapi-client`、`@alicloud/tea-util`、`@alicloud/credentials`。

凭据（二选一，均不进仓库）：
- **默认链（推荐）**：`new Credential.default()` 走 `@alicloud/credentials` 默认链（env `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`，或 RAM Role / 实例元数据）。生产 ECS/容器友好。
- **显式 AK 兜底**：读 `DYPNS_ACCESS_KEY_ID` / `DYPNS_ACCESS_KEY_SECRET`，构造 `Credential` 注入。本地开发便捷。

配置：`DYPNS_SIGN_NAME`、`DYPNS_TEMPLATE_CODE`、`DYPNS_ENDPOINT`（默认 `dypnsapi.aliyuncs.com`）。

接口草稿：

```ts
export class DypnsSmsService {
  send(phone: string): Promise<void>;               // 调 SendSmsVerifyCode；失败抛 CoolCommException（含阿里云错误 message）
  check(phone: string, code: string): Promise<boolean>;  // 调 CheckSmsVerifyCode；返回 VerifyResult === PASS
}
```

错误处理：捕获阿里云异常，读取 `error.message` 与 `error.data.Recommend`（诊断地址），转换为 `CoolCommException` 抛出，避免吞异常。

### 11.3 改造 `src/modules/user/service/login.ts`（不碰 `sms.ts`）

- `smsCode(phone, captchaId, code)`：**保留图形验证码校验**（captcha）→ 调用 `dypnsSms.send(phone)`。**删除**原"本地 `_.random` 生成验证码 + `midwayCache.set('sms:'+phone, code)`"逻辑。
- `phoneVerifyCode(phone, smsCode)`：调用 `dypnsSms.check(phone, smsCode)` → `true` 则签发 token、首次则建号；`false` 抛"验证码错误或已过期"。**删除**原"从 `midwayCache` 取验证码比对"逻辑。
- **`src/modules/user/service/sms.ts` 原样保留**，不被引用（留给原插件体系，不删不动）。

### 11.4 契约与边界

- 前端契约不变（路径/入参/返回同第 4 节）。
- `SendSmsVerifyCode` 不返回验证码明文，故后端**无法**做"开发模式打印验证码"——开发期端到端需用真实手机号接收（用户已购 DYPNS 服务）。
- 依赖安装、凭据配置、`@Module` 注册在 writing-plans 阶段展开；或后端单独处理。

> 备选：若希望完全不改 `login.ts`，可改为新增独立端点（如 `/app/user/login/dypns/*`），前端 `apiUser` 切到新路径。本设计默认采用"新增 service + 改造 login.ts 调用点"，因契约最稳、前端最简。

## 12. 配置

### 12.1 前端 env

- `VITE_USER_API_URL`：用户后端地址（vite proxy target），默认 `http://127.0.0.1:8001`
- `VITE_USER_API_BASE`：前端请求前缀，默认 `/user-api`

更新 `.env.example`（若存在）或 README 说明。

### 12.2 vite proxy（`frontend/vite.config.ts`）

```ts
const userApiTarget = env.VITE_USER_API_URL || "http://127.0.0.1:8001";
// proxy 表新增：
"/user-api": {
  target: userApiTarget,
  changeOrigin: true,
  rewrite: (p) => p.replace(/^\/user-api/, ""),
},
```

无跨域，与现有 trading proxy 模式一致。

### 12.3 后端 env（cool-admin-midway）

- 凭据（二选一）：默认链 `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`（推荐，走 `@alicloud/credentials`）；或显式 `DYPNS_ACCESS_KEY_ID` / `DYPNS_ACCESS_KEY_SECRET`。
- 业务：`DYPNS_SIGN_NAME`、`DYPNS_TEMPLATE_CODE`、`DYPNS_ENDPOINT`（默认 `dypnsapi.aliyuncs.com`）。
- 全部放后端 `.env`，**不进仓库**。

## 13. 实现顺序（建议）

1. 类型 `src/types/user.ts`
2. `apiUser.ts` + 单测
3. `auth.ts` store + 单测
4. `RequireAuth` + 单测
5. vite proxy + env
6. `Login.tsx` + 单测
7. `Profile.tsx`
8. `UserMenu` 接入 Header
9. router 接线 + App 启动 `bootstrap`
10. i18n 文案
11. 前端整体联调（依赖后端 DYPNS 打通后端到端）
12. 后端配套：`dypnsSms.ts` + `login.ts` 接入 + 凭据配置

## 14. 风险与待确认

- **DYPNS 验证码语义（已确认）**：发送用 `SendSmsVerifyCode`、校验用 `CheckSmsVerifyCode`，两者经 `PhoneNumber` 关联，验证码由阿里云生成与维护（后端不存）。剩余风险：SDK 版本的字段名（如 `VerifyResult` 取值、`TemplateParam` 占位符）与返回结构需在后端实现时对照实际响应核对。
- **upload 返回结构**：cool-admin 通用上传返回 `data` 内字段以实际为准（预期 `url`），实现时需对齐，必要时前端兼容 `{url}` 与 `{data:{url}}`。
- **CORS**：采用 vite proxy 后开发期无跨域；生产/独立部署若前端与后端不同源，需后端 CORS 放行。
- **手机号脱敏**：后端 `person` 返回完整手机号，前端展示时脱敏。
- **i18n 命名空间冲突**：新增 `auth`/`profile`/`userMenu`，需确认不与现有 key 冲突（实现时 grep 确认）。
