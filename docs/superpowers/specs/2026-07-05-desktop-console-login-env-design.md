# 桌面 Console 登录迁移 + .env 写入设计

- 日期：2026-07-05
- 状态：待审查
- 作者：brainstorming 产出
- 关联代码区：`src-tauri/`（Rust shell + Vue console-app）、`frontend/`（React WebUI）

## 1. 背景与动机

现有登录页 `frontend/src/pages/auth/Login.tsx`（React）跑在浏览器 WebUI 里，登录成功后：

1. 把 JWT `token` 存浏览器 `useAuthStore`（localStorage）
2. 调 `autoConfigLLM(token)` → `PUT /settings/llm`，把 maas 地址 + token 推给 agent backend 当作 LLM provider 凭证（vip 模型网关把 JWT 当 `api_key`）

桌面分发场景下这条链路有一个**关键断层**：

- `agent/api_server.py` 的 `update_llm_settings` 实际写入的是项目相对路径的 `agent/.env`（函数注释原话："persisted to agent/.env"）
- 但桌面运行时 agent 真正加载的是 `~/.vibe-trading/.env`（见 `agent/cli/main.py:114`：`_ENV_PATH = Path.home() / ".vibe-trading" / ".env"`，以及 `agent/cli/onboard.py` 整个向导都围绕该路径）
- 所以 `autoConfigLLM` 在桌面分发版里**根本不生效**——用户登录后 vip 模型网关仍然没有 token

与此同时，桌面 console-app（Vue，4 页面：Console / Settings / Monitor / Channels）目前完全没有登录入口，用户必须打开浏览器 WebUI 才能登录，体验割裂。

## 2. 目标

- **登录入口迁移到桌面 console**：在 Vue console-app 里 1:1 重建 Login.tsx 的全部交互（短信 tab + 密码 tab + 图形验证码 + 60s 倒计时 + 首登设密码弹窗）
- **登录成功写入 `~/.vibe-trading/.env`**：把 maas 大模型请求地址 + JWT token（作为 `OPENAI_API_KEY`）+ refreshToken + expire 落盘，让桌面运行时 agent backend 自动读到、vip 请求自动携带
- **token 不入浏览器**：console webview 永远不持有 token，只持有 `userInfo` 用于显示
- **token 自动刷新**：保留 refreshToken 机制，启动服务前校验，过期自动 refresh 并重写 .env
- **WebUI 登录完全移除**：删掉 frontend 的登录页、auth store、apiUser 客户端、Profile 页、RequireAuth 守卫

## 3. 非目标

- 不做"登出"功能（YAGNI，重登会覆盖旧 token）
- 不改 agent backend 的 LLM 加载逻辑、不改 `_rewrite_env_values` 的语义（仅由 Rust 侧复刻其"读全文 → 替换指定 key → 原子写回"的行为）
- 不动 `lib/apiAuth.ts` 的 `API_AUTH_KEY` 机制（那是 agent backend 自身鉴权，与 user JWT 无关）
- 不处理 `.env` 并发写入（实测场景里 .env 几乎只读，保留 atomic write 仅用于防 SIGKILL/崩溃导致半写）

## 4. 架构总览

### 设计形态：登录全链路走 Rust

登录发生在服务启动**之前**（用户先登录再点"启动服务"），此时只有 Tauri/Rust 进程在跑，agent backend 尚未 spawn。因此登录请求、.env 写入、token 缓存、刷新逻辑**全部由 Rust 承担**。Vue 只负责表单 UI 与展示态。

```
┌─────────────────────────────────────────────────────────────┐
│  Vue console-app (webview)                                  │
│    LoginPage.vue ──invoke──► Tauri commands                 │
│    stores/auth.ts (只存 userInfo / authenticated)           │
└──────────────────────┬──────────────────────────────────────┘
                       │ invoke (camelCase)
┌──────────────────────▼──────────────────────────────────────┐
│  Rust (src-tauri/src)                                       │
│    console.rs  ── #[tauri::command] ──►  auth.rs            │
│      console_login_captcha / send_sms / by_phone / ...      │
│                                           │                  │
│    auth.rs:                                │                  │
│      ┌─────────────┐    ┌─────────────────▼──────────┐      │
│      │ reqwest     │    │ .env token 段读写          │      │
│      │ cool-admin  │    │ write/read ~/.vibe-trading │      │
│      │ 客户端      │    │ /.env 的 LLM/USER_* key   │      │
│      └─────────────┘    └────────────────────────────┘      │
│      + UserSession 内存缓存（Mutex<Option<UserSession>>）   │
│      + ensure_session_valid()                                │
└──────────────────────┬──────────────────────────────────────┘
                       │ spawn (env from ~/.vibe-trading/.env)
┌──────────────────────▼──────────────────────────────────────┐
│  agent sidecar (venv python)                                │
│    读 OPENAI_API_KEY / OPENAI_BASE_URL → LLM 调用自动带 token│
└─────────────────────────────────────────────────────────────┘
```

### 配置项（可覆盖，预留可配置）

Rust 常量 + 运行时 env var 覆盖（默认值与现 Login.tsx 对齐）：

| 常量 | env var 覆盖 | 默认值 |
|---|---|---|
| `MAAS_BASE` | `VIBE_USER_API_URL` | `https://maas.nieanshow.cn` |
| `DEFAULT_MODEL` | `VIBE_DEFAULT_MODEL` | `deepseek-v4-flash` |

## 5. 数据流

### 5.1 登录（console 启动后、服务启动前）

```
Vue LoginPage
  → invoke console_login_captcha
        → Rust reqwest GET cool-admin /app/user/login/captcha
        ← {captchaId, data}
  → invoke console_login_send_sms {phone, captchaId, code}
        → Rust reqwest POST /app/user/login/smsCode
  → invoke console_login_by_phone {phone, smsCode}
        → Rust reqwest POST /app/user/login/phone
        ← {token, refreshToken, expire, refreshExpire, hasPassword}
        → Rust 写 ~/.vibe-trading/.env（见 §6）
        → Rust 内存缓存 UserSession
        → Rust fetch_user_info(token) ← UserInfo
  ← 返回 Vue 的只有 {userInfo, hasPassword, expireAt}（token 不出 Rust）
```

密码登录 (`console_login_by_password`) 同构。首登无密码时返回 `hasPassword=false`，Vue 弹 `SetPasswordModal` → `console_login_set_password`（用当前 token 鉴权调 `/app/user/info/setPassword`）。

### 5.2 启动服务（点"启动服务"）

```
Vue → invoke console_start_service（现有命令，不变）
  → Rust spawn sidecar 前调用 ensure_session_valid()：
        比对 本地时钟 vs 缓存的 expire
        ├─ expire 未到         → 直接 spawn
        ├─ expire 到、refreshExpire 未到
        │                       → reqwest refresh → 重写 .env → spawn
        └─ refresh 失败/refreshExpire 到
                                → 返回 LoginExpired 错误 → Vue 跳 /login
  → spawn venv python（进程继承/读取 ~/.vibe-trading/.env）
```

`ConsolePage.vue` 现有 `onStart` 不变；catch 到 `LoginExpired` 时 `router.push('/login')` + toast。

### 5.3 vip 请求携带（零新增逻辑）

agent backend 现有机制：读 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 作为 LLM provider 凭证。`.env` 写入了 token + maas 地址后**自动生效**，backend 无需改动。

### 5.4 console 重启恢复

Rust 进程重启后内存缓存丢失。`console_auth_status` 命令从 `.env` 的 token 段（`OPENAI_API_KEY` + `USER_REFRESH_TOKEN` + `USER_TOKEN_EXPIRE` + `USER_REFRESH_EXPIRE`）读回 UserSession 到内存，并返回 `{authenticated: true, userInfo, expireAt}` 给 Vue。**恢复时不调网络**，直到下次"启动服务"才真正校验。

## 6. `.env` 写入格式

### 写入的 key

| Key | 值 | 说明 |
|---|---|---|
| `LANGCHAIN_PROVIDER` | `openai` | 与 autoConfigLLM 一致 |
| `LANGCHAIN_MODEL_NAME` | `{DEFAULT_MODEL}`（默认 `deepseek-v4-flash`） | 可被 `VIBE_DEFAULT_MODEL` 覆盖 |
| `OPENAI_BASE_URL` | `{MAAS_BASE}/v1` | 默认 `https://maas.nieanshow.cn/v1` |
| `OPENAI_API_KEY` | `{token}` | JWT 当作 LLM api_key |
| `USER_REFRESH_TOKEN` | `{refreshToken}` | 跨进程重启续命用 |
| `USER_TOKEN_EXPIRE` | `{expire}`（epoch 秒） | 不解码 JWT，直接用返回值 |
| `USER_REFRESH_EXPIRE` | `{refreshExpire}`（epoch 秒） | |

### 写入语义

复刻 agent 侧 `_rewrite_env_values` 的行为：

1. 读 `~/.vibe-trading/.env` 全文（不存在则视作空）
2. 按 key 替换/追加上述 7 个 key，**其余行原样保留**（其他 provider、数据源等配置不破坏）
3. 原子写回：写同目录 tmp 文件 → `fsync` → `os.replace` 覆盖目标 → fsync 父目录（与 `agent/cli/onboard.py` 的 `_atomic_write_env` 一致，防 SIGKILL 半写）

文件权限 `0600`（与 onboard.py 一致，token 属敏感凭证）。

## 7. 组件清单

### 7.1 Rust 新增 `src-tauri/src/auth.rs`

```rust
struct UserSession {
    token: String,           // 不返回给 Vue
    refresh_token: String,   // 不返回给 Vue
    expire: i64,             // epoch 秒
    refresh_expire: i64,
    user_info: UserInfo,
}

// cool-admin 客户端（reqwest），1:1 对应 apiUser.ts 端点
async fn fetch_captcha() -> Result<Captcha, AuthError>
async fn send_sms(phone, captcha_id, code) -> Result<(), AuthError>
async fn login_by_phone(phone, sms_code) -> Result<LoginRaw, AuthError>
async fn login_by_password(phone, password) -> Result<LoginRaw, AuthError>
async fn refresh_token(rt: &str) -> Result<LoginRaw, AuthError>
async fn set_password(token: &str, password: &str) -> Result<(), AuthError>
async fn fetch_user_info(token: &str) -> Result<UserInfo, AuthError>

// .env token 段
fn write_env_token_section(token, refresh_token, expire, refresh_expire) -> Result<(), AuthError>
fn read_env_token_section() -> Option<UserSession>   // 从 .env 恢复
// 不做 clear（无登出）

// 进程内状态（tauri::State 注入）
struct AuthState(Mutex<Option<UserSession>>);

// 启动服务前调
async fn ensure_session_valid(state: &State<AuthState>) -> Result<UserSession, AuthError>
```

`AuthError` 用 `thiserror` 派生，序列化为结构化错误（`{code, message}` 或 `LoginExpired` 变体），Vue 据此 toast / 跳登录。

### 7.2 `console.rs` 新增 `#[tauri::command]`（注册到 `main.rs`）

| 命令 | 入参 | 返回 | 副作用 |
|---|---|---|---|
| `console_login_captcha` | — | `{captchaId, data}` | — |
| `console_login_send_sms` | `{phone, captchaId, code}` | `void` | — |
| `console_login_by_phone` | `{phone, smsCode}` | `LoginResult` | 写 .env + 缓存 |
| `console_login_by_password` | `{phone, password}` | `LoginResult` | 写 .env + 缓存 |
| `console_login_set_password` | `{password}` | `void` | 调 cool-admin |
| `console_auth_status` | — | `{authenticated, userInfo?, expireAt?}` | 从 .env 恢复到内存 |

`LoginResult`（返回 Vue，**不含 token**）：`{ userInfo: UserInfo, hasPassword: bool, expireAt: i64 }`

`console_start_service` 内部在 spawn 前调 `ensure_session_valid`，过期且 refresh 失败时返回 `LoginExpired`。

### 7.3 Vue console-app（新增/改造）

| 文件 | 动作 |
|---|---|
| `pages/LoginPage.vue` | 新增，1:1 迁移 Login.tsx（短信+密码双 tab + 验证码 + 倒计时 + 调用新 IPC） |
| `components/SetPasswordModal.vue` | 新增，迁移自 React 版 |
| `stores/auth.ts` | 新增（Pinia），仅 `{ authenticated, userInfo, expireAt }` |
| `ipc/commands.ts` | 追加 6 个 invoke（上表） |
| `ipc/types.ts` | 追加 `LoginResult` / `UserInfo` / `AuthStatus` / `AuthError` |
| `router.ts` | 加 `/login` 路由 + 守卫（未登录跳 `/login`） |
| `pages/ConsolePage.vue` | `onMounted` 调 `console_auth_status`；未登录 `router.push('/login')`；`onStart` catch `LoginExpired` 跳登录 |

## 8. WebUI 清理清单（frontend/）

### 删除（整文件）

- `pages/auth/Login.tsx` + `pages/auth/__tests__/Login.test.tsx`
- `components/auth/SetPasswordModal.tsx`
- `components/auth/RequireAuth.tsx`
- `stores/auth.ts`
- `lib/apiUser.ts`
- `types/user.ts`
- `pages/profile/Profile.tsx`（186 行，整页失去意义）

### 改造

- `router.tsx`：删 `/login`、`/profile` 路由与 `RequireAuth` 引入；移除 `wrap(Login)` / `wrap(Profile)` 的 lazy import
- `main.tsx`：删 `useAuthStore` import 与 `void useAuthStore.getState().bootstrap()` 调用
- `components/layout/UserMenu.tsx`：整个组件从顶栏移除（找到挂载点 layout，删引用）。`UserMenu` 自身文件删除
- `pages/Settings.tsx`：去掉第 94-95 行 `authStatus` / `userInfo` 依赖，删除依赖它的状态角 UI
- `vite.config.ts`：删 `/user-api` proxy 段

### 保留不动

- `lib/apiAuth.ts` + `lib/api.ts` 的 `API_AUTH_KEY` / `withAuthQuery`（agent backend 自身鉴权，与 user JWT 无关）
- `pages/Settings.tsx` 的 LLM/数据源设置 UI（见 §11 开放问题）

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| 登录网络失败 / cool-admin 返回 `code != 1000` | Rust 返回 `{code, message}` → Vue toast，刷新验证码 |
| `console_start_service` 时 token 过期、refresh 成功 | Rust 静默 refresh + 重写 .env → 继续 spawn（用户无感） |
| refresh 失败 / refreshExpire 到 | `console_start_service` 返回 `LoginExpired` → Vue `router.push('/login')` + toast |
| `.env` 写入失败（权限/磁盘） | 登录事务回滚：不缓存 session、返回 500 → Vue 提示"配置写入失败" |
| console 重启后 `.env` 有 token 但内存空 | `console_auth_status` 从 .env 恢复（不调网络） |

## 10. 测试策略

### Rust（`cargo test`，新加 `auth.rs` 单元测试）

- `.env` token 段 `write → read` round-trip：含其他 key 不被破坏（构造含 `TUSHARE_TOKEN` 等的 .env，写入后这些仍在）
- `ensure_session_valid` 三分支：未过期直通 / 过期 refresh 成功 / refresh 失败返 `LoginExpired`
- atomic write：写入后内容完整（mock fs 或 tmpdir）
- 文件权限 `0600`

### Vue（vitest）

- 迁移 `Login.test.tsx` → `LoginPage.test.ts`，覆盖：短信 tab 提交、密码 tab 提交、验证码刷新、倒计时、首登 hasPassword=false 弹 SetPasswordModal
- `auth` store：`console_auth_status` authenticated/未登录两态

### 不跑

- 不动 order/mandate/live，无需窄安全测试（`test_sdk_order_gate.py` / `test_mandate_enforcement.py`）

## 11. 风险与开放问题

- **WebUI Settings 的 LLM 设置 UI 语义重叠**：console 登录会写 `~/.vibe-trading/.env`，而 WebUI Settings 的 `PUT /settings/llm` 仍写 `agent/.env`（路径 bug 未修），两者可能让用户困惑。本次**不处理**，作为独立后续项评估（选项：修 backend 路径 / 砍 WebUI 的 LLM 设置 UI）。
- **cool-admin 的 CORS**：方案 A 下登录请求由 Rust `reqwest` 发起，不经 webview，**不存在 CORS 问题**。
- **`VITE_USER_API_URL` 在桌面分发版的可达性**：maas 域名需用户网络可达；离线场景登录直接失败（符合预期）。
- **token 时钟漂移**：用 cool-admin 返回的 `expire`/`refreshExpire` 时间戳比对本地时钟，若用户系统时钟偏差大可能误判。可接受（偏差大的桌面环境本就有更大问题）。

## 12. 实现顺序建议

1. Rust `auth.rs`：cool-admin 客户端 + .env token 段 + 单元测试
2. Tauri commands 注册 + `console_start_service` 接入 `ensure_session_valid`
3. Vue `LoginPage` + `SetPasswordModal` + auth store + 路由守卫
4. `ConsolePage` 接入 `console_auth_status` + `LoginExpired` 跳转
5. WebUI 清理（删 + 改，逐文件）
6. 端到端：console 登录 → 写 .env → 启动服务 → 验证 vip LLM 调用带 token
