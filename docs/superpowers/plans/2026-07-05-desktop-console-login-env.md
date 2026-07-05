# 桌面 Console 登录迁移 + .env 写入 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把用户登录从 React WebUI 迁到桌面 Vue console，登录全链路在 Rust 完成（reqwest 调 cool-admin），登录成功写入 `~/.vibe-trading/.env` 的 LLM/USER_* key，启动服务前自动 refresh token，WebUI 登录入口完全移除。

**Architecture:** 登录发生在服务启动前（仅 Rust 进程在跑），故登录请求、.env 写入、token 缓存、刷新逻辑全部由 Rust 承担；Vue 只拿 `userInfo` 显示登录态，token 永不进浏览器。`.env` 的 LLM 段被 Rust「读全文→替换指定 key→原子写回」复刻 agent 侧 `_rewrite_env_values` 语义。

**Tech Stack:** Rust（reqwest blocking、serde、std::fs atomic rename）；Vue 3 + Pinia + vue-router + vitest；WebUI（React）清理。

## Global Constraints

- Rust 依赖**不加新 crate**：`reqwest` 已有 `features=["blocking","rustls-tls"]`、`dirs`/`serde`/`serde_json` 已有；错误类型手写 enum + `#[serde(tag="variant")]`，不用 `thiserror`。
- Rust 命令全部**同步 `#[tauri::command]` + `reqwest::blocking`**（与 `console_start_channels` 一致），不用 async/tokio。
- token 永远不返回给 Vue：`LoginResultView` 只含 `{userInfo, hasPassword, expireAt}`。
- `.env` 路径 = `Layout.user_env`（`~/.vibe-trading/.env`），不要写成 `agent/.env`。
- `.env` 写入 atomic：tmp → fsync → rename（unix 下权限 0600）；只动 7 个 key，其余行原样保留。
- 配置项可被 env var 覆盖：`VIBE_USER_API_URL`（默认 `https://maas.nieanshow.cn`）、`VIBE_DEFAULT_MODEL`（默认 `deepseek-v4-flash`）。
- cool-admin 响应包装 `{code, data, message}`，`code==1000` 为成功；鉴权 header 是 `Authorization: <token>`（不带 Bearer）。
- commit 风格：`<emoji> <type>(<scope>): <中文描述>`，如 `✨ feat(console): ...`、`🧹 chore(webui): ...`。

---

## File Structure

**新增**
- `src-tauri/src/auth.rs` — Rust 登录核心：类型、cool-admin 客户端、.env token 段、ensure_session_valid、AuthState
- `src-tauri/console-app/src/stores/auth.ts` — Pinia auth store（只存 userInfo/authenticated/expireAt）
- `src-tauri/console-app/src/pages/LoginPage.vue` — 登录页（1:1 迁移 Login.tsx）
- `src-tauri/console-app/src/components/SetPasswordModal.vue` — 首登设密码弹窗
- `src-tauri/console-app/src/pages/__tests__/LoginPage.test.ts` — 登录页测试

**修改**
- `src-tauri/src/main.rs` — `mod auth;`、注册命令、`.manage(AuthState(...))`
- `src-tauri/src/console.rs` — 新增 6 个 `console_login_*` / `console_auth_status` 命令；`console_start_service` 改返 `ServiceStartError` 并接入 `ensure_session_valid`
- `src-tauri/console-app/src/ipc/commands.ts` — 追加 6 个 invoke
- `src-tauri/console-app/src/ipc/types.ts` — 追加 UserInfo/LoginResultView/AuthStatusView/AuthError/ServiceStartError 类型
- `src-tauri/console-app/src/router.ts` — 加 `/login` 路由 + beforeEach 守卫
- `src-tauri/console-app/src/pages/ConsolePage.vue` — onMounted 调 console_auth_status；onStart catch LoginExpired

**删除（WebUI 清理）**
- `frontend/src/pages/auth/Login.tsx`、`frontend/src/pages/auth/__tests__/Login.test.tsx`
- `frontend/src/components/auth/SetPasswordModal.tsx`
- `frontend/src/components/auth/RequireAuth.tsx`
- `frontend/src/stores/auth.ts`
- `frontend/src/lib/apiUser.ts`
- `frontend/src/types/user.ts`
- `frontend/src/pages/profile/Profile.tsx`
- `frontend/src/components/layout/UserMenu.tsx`

**修改（WebUI 清理）**
- `frontend/src/router.tsx`、`frontend/src/main.tsx`、`frontend/src/pages/Settings.tsx`、`frontend/vite.config.ts`

---

### Task 1: Rust `auth.rs` — 类型与 .env key 替换纯函数

**Files:**
- Create: `src-tauri/src/auth.rs`
- Modify: `src-tauri/src/main.rs:2`（加 `mod auth;`）

**Interfaces:**
- Produces: `UserInfo` / `LoginRaw` / `Captcha` / `AuthError` 类型；纯函数 `rewrite_env_keys(content, updates) -> String`、`parse_env_to_map(content) -> HashMap`；常量 `ENV_KEY_*`

- [ ] **Step 1: 写 `auth.rs` 的类型、常量、纯函数（先于测试）**

创建 `src-tauri/src/auth.rs`：

```rust
//! 桌面 console 用户登录：cool-admin 客户端 + ~/.vibe-trading/.env token 段读写。
//! 设计见 docs/superpowers/specs/2026-07-05-desktop-console-login-env-design.md
//! 全部同步 + reqwest::blocking，与 console.rs 现有命令风格一致。

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::runtime_dir::Layout;

// ── 可覆盖配置（默认值与 frontend/src/pages/auth/Login.tsx 对齐）──

pub fn user_api_url() -> String {
    std::env::var("VIBE_USER_API_URL").unwrap_or_else(|_| "https://maas.nieanshow.cn".into())
}
pub fn default_model() -> String {
    std::env::var("VIBE_DEFAULT_MODEL").unwrap_or_else(|_| "deepseek-v4-flash".into())
}
/// maas 的 OpenAI 兼容端点 = {USER_API_URL}/v1
pub fn maas_base_url() -> String {
    format!("{}/v1", user_api_url())
}

// ── .env 中由本模块管辖的 key（其余 key 不动）──
pub const ENV_KEY_PROVIDER: &str = "LANGCHAIN_PROVIDER";
pub const ENV_KEY_MODEL: &str = "LANGCHAIN_MODEL_NAME";
pub const ENV_KEY_BASE_URL: &str = "OPENAI_BASE_URL";
pub const ENV_KEY_API_KEY: &str = "OPENAI_API_KEY";
pub const ENV_KEY_REFRESH: &str = "USER_REFRESH_TOKEN";
pub const ENV_KEY_EXPIRE: &str = "USER_TOKEN_EXPIRE";
pub const ENV_KEY_REFRESH_EXPIRE: &str = "USER_REFRESH_EXPIRE";

// ── 错误类型：serde 序列化后由 Tauri 透传给 Vue，按 variant 分流 ──
#[derive(Debug, serde::Serialize)]
#[serde(tag = "variant")]
pub enum AuthError {
    Network { message: String },
    Api { code: i64, message: String },
    LoginExpired,
    EnvWrite { message: String },
    NotAuthenticated,
}

// ── 类型：与 cool-admin JSON 对齐（camelCase）──
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub id: i64,
    #[serde(default)]
    pub unionid: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub nick_name: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub gender: i64,
    #[serde(default)]
    pub status: i64,
    #[serde(default)]
    pub login_type: i64,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRaw {
    pub token: String,
    pub refresh_token: String,
    pub expire: i64,          // 相对秒
    pub refresh_expire: i64,  // 相对秒
    pub has_password: bool,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Captcha {
    pub captcha_id: String,
    pub data: String,
}

/// 内存缓存的完整 session（不序列化给前端；user_info 在重启恢复时为 None）
#[derive(Debug, Clone)]
pub struct UserSession {
    pub token: String,
    pub refresh_token: String,
    pub expire_at: i64,         // 绝对 epoch 秒
    pub refresh_expire_at: i64, // 绝对 epoch 秒
    pub user_info: Option<UserInfo>,
}

pub struct AuthState(pub Mutex<Option<UserSession>>);

// ── 纯函数：.env key 替换 ──

/// 把 `updates` 的每个 (key, value) 替换进 `content`：
/// 已存在 `key=` 行则替换该行；不存在则在末尾追加。其余行原样保留。
pub fn rewrite_env_keys(content: &str, updates: &[(String, String)]) -> String {
    let mut lines: Vec<String> = content.split('\n').map(str::to_string).collect();
    for (key, value) in updates {
        let prefix = format!("{key}=");
        let mut found = false;
        for line in lines.iter_mut() {
            // 仅匹配行首（允许前导空白），避免误匹配 KEY_OTHER= 之类
            let trimmed = line.trim_start();
            if trimmed.starts_with(&prefix) {
                *line = format!("{key}={value}");
                found = true;
                break;
            }
        }
        if !found {
            // 追加：若末行非空，先补一个空行分隔
            let need_sep = lines
                .last()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            if need_sep {
                lines.push(String::new());
            }
            lines.push(format!("{key}={value}"));
        }
    }
    lines.join("\n")
}

/// 把 .env 文本解析成 key->value map（取每个 `key=value` 行首匹配；忽略注释与空行）。
pub fn parse_env_to_map(content: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        if let Some(eq) = trimmed.find('=') {
            let key = trimmed[..eq].trim().to_string();
            let value = trimmed[eq + 1..].trim().to_string();
            if !key.is_empty() {
                map.insert(key, value);
            }
        }
    }
    map
}

/// 当前 epoch 秒（单独函数便于测试时不依赖系统时钟副作用）。
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
```

修改 `src-tauri/src/main.rs` 第 2 行，在模块声明里加 `auth`：

```rust
mod resources; mod version; mod runtime_dir; mod port; mod sidecar; mod console; mod auth;
```

- [ ] **Step 2: 写单元测试（同文件 `#[cfg(test)] mod tests`）**

在 `auth.rs` 末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_replaces_existing_key() {
        let content = "OPENAI_API_KEY=old\nOTHER=keep\n";
        let out = rewrite_env_keys(content, &[("OPENAI_API_KEY".into(), "new".into())]);
        assert!(out.contains("OPENAI_API_KEY=new"));
        assert!(out.contains("OTHER=keep"));
        assert!(!out.contains("=old"));
    }

    #[test]
    fn rewrite_appends_missing_key_with_separator() {
        let content = "EXISTING=1";
        let out = rewrite_env_keys(content, &[("OPENAI_API_KEY".into(), "tok".into())]);
        // 原行保留，新行在空行之后追加
        assert!(out.starts_with("EXISTING=1\n\nOPENAI_API_KEY=tok"));
    }

    #[test]
    fn rewrite_preserves_unrelated_lines_and_comments() {
        let content = "# comment\nLANGCHAIN_PROVIDER=openrouter\nOPENROUTER_API_KEY=xxx\n";
        let updates = vec![
            ("LANGCHAIN_PROVIDER".into(), "openai".into()),
            ("OPENAI_API_KEY".into(), "tok".into()),
        ];
        let out = rewrite_env_keys(content, &updates);
        assert!(out.contains("# comment"));
        assert!(out.contains("OPENROUTER_API_KEY=xxx")); // 其他 provider 不破坏
        assert!(out.contains("LANGCHAIN_PROVIDER=openai"));
        assert!(out.contains("OPENAI_API_KEY=tok"));
    }

    #[test]
    fn rewrite_does_not_match_prefixed_key_names() {
        // OPENAI_API_KEY 不应误匹配 OPENAI_API_KEY_EXTRA=
        let content = "OPENAI_API_KEY_EXTRA=x\n";
        let out = rewrite_env_keys(content, &[("OPENAI_API_KEY".into(), "tok".into())]);
        assert!(out.contains("OPENAI_API_KEY_EXTRA=x")); // 原行保留
        assert!(out.contains("OPENAI_API_KEY=tok"));     // 新行追加
    }

    #[test]
    fn parse_env_to_map_skips_comments_and_blanks() {
        let content = "# header\n\nA=1\n  B = 2 \nC=\n";
        let map = parse_env_to_map(content);
        assert_eq!(map.get("A").map(String::as_str), Some("1"));
        assert_eq!(map.get("B").map(String::as_str), Some("2"));
        assert_eq!(map.get("C").map(String::as_str), Some(""));
        assert!(!map.contains_key("# header"));
    }

    #[test]
    fn maas_base_url_appends_v1() {
        // 默认值
        std::env::remove_var("VIBE_USER_API_URL");
        assert_eq!(maas_base_url(), "https://maas.nieanshow.cn/v1");
        // 覆盖
        std::env::set_var("VIBE_USER_API_URL", "https://example.com");
        assert_eq!(maas_base_url(), "https://example.com/v1");
        std::env::remove_var("VIBE_USER_API_URL");
    }

    #[test]
    fn default_model_falls_back_to_deepseek() {
        std::env::remove_var("VIBE_DEFAULT_MODEL");
        assert_eq!(default_model(), "deepseek-v4-flash");
    }
}
```

- [ ] **Step 3: 跑测试，确认通过**

Run: `cd src-tauri && cargo test auth::tests -- --nocapture`
Expected: PASS，`rewrite_*` / `parse_env_to_map` / `maas_base_url` / `default_model` 全绿。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/auth.rs src-tauri/src/main.rs
git commit -m "✨ feat(console): auth.rs 类型 + .env key 替换纯函数"
```

---

### Task 2: Rust `auth.rs` — .env 原子读写 + cool-admin 响应解析

**Files:**
- Modify: `src-tauri/src/auth.rs`（追加 IO 与解析函数）

**Interfaces:**
- Consumes: Task 1 的类型/常量/`rewrite_env_keys`/`parse_env_to_map`/`now_secs`
- Produces: `write_env_atomic(path, content)`、`write_env_token_section(layout, session)`、`read_env_token_section(layout) -> Option<UserSession>`、`parse_cool_response<T>(text) -> Result<T, AuthError>`

- [ ] **Step 1: 追加 atomic write + token 段读写函数**

在 `auth.rs` 的 `now_secs` 之后追加：

```rust
// ── .env 原子写（tmp→fsync→rename；unix 权限 0600）──

pub fn write_env_atomic(path: &Path, content: &str) -> Result<(), AuthError> {
    let parent = path
        .parent()
        .ok_or_else(|| AuthError::EnvWrite { message: "no parent dir".into() })?;
    fs::create_dir_all(parent)
        .map_err(|e| AuthError::EnvWrite { message: format!("mkdir {:?}: {e}", parent) })?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "env".into());
    let tmp = parent.join(format!(".{file_name}.tmp"));

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| AuthError::EnvWrite { message: format!("open tmp: {e}") })?;
        f.write_all(content.as_bytes())
            .map_err(|e| AuthError::EnvWrite { message: format!("write tmp: {e}") })?;
        f.sync_all()
            .map_err(|e| AuthError::EnvWrite { message: format!("fsync tmp: {e}") })?;
    }
    #[cfg(not(unix))]
    {
        fs::write(&tmp, content)
            .map_err(|e| AuthError::EnvWrite { message: format!("write tmp: {e}") })?;
    }

    fs::rename(&tmp, path)
        .map_err(|e| AuthError::EnvWrite { message: format!("rename tmp: {e}") })?;
    Ok(())
}

/// 把登录 session 写进 layout.user_env 的 7 个 key，其余 key 不动。
pub fn write_env_token_section(layout: &Layout, sess: &UserSession) -> Result<(), AuthError> {
    let path = &layout.user_env;
    let content = fs::read_to_string(path).unwrap_or_default();
    let updates = vec![
        (ENV_KEY_PROVIDER.to_string(), "openai".to_string()),
        (ENV_KEY_MODEL.to_string(), default_model()),
        (ENV_KEY_BASE_URL.to_string(), maas_base_url()),
        (ENV_KEY_API_KEY.to_string(), sess.token.clone()),
        (ENV_KEY_REFRESH.to_string(), sess.refresh_token.clone()),
        (ENV_KEY_EXPIRE.to_string(), sess.expire_at.to_string()),
        (
            ENV_KEY_REFRESH_EXPIRE.to_string(),
            sess.refresh_expire_at.to_string(),
        ),
    ];
    let new_content = rewrite_env_keys(&content, &updates);
    write_env_atomic(path, &new_content)
}

/// 从 layout.user_env 读回 session（重启恢复用）。userInfo 读不到，留 None。
pub fn read_env_token_section(layout: &Layout) -> Option<UserSession> {
    let content = fs::read_to_string(&layout.user_env).ok()?;
    let map = parse_env_to_map(&content);
    let token = map.get(ENV_KEY_API_KEY)?.trim();
    if token.is_empty() {
        return None;
    }
    let refresh_token = map.get(ENV_KEY_REFRESH)?.trim().to_string();
    let expire_at = map.get(ENV_KEY_EXPIRE)?.trim().parse::<i64>().ok()?;
    let refresh_expire_at = map
        .get(ENV_KEY_REFRESH_EXPIRE)
        ?.trim()
        .parse::<i64>()
        .ok()?;
    Some(UserSession {
        token: token.to_string(),
        refresh_token,
        expire_at,
        refresh_expire_at,
        user_info: None,
    })
}

// ── cool-admin 响应解析 ──
/// cool-admin 统一包装 {code, data, message}，code==1000 成功。
#[derive(Debug, serde::Deserialize)]
struct CoolResponse<T> {
    pub code: i64,
    #[serde(default)]
    pub data: Option<T>,
    #[serde(default)]
    pub message: Option<String>,
}

/// 把 cool-admin 响应体解析为 data；code!=1000 或解析失败转 AuthError。
pub fn parse_cool_response<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, AuthError> {
    let resp: CoolResponse<T> = serde_json::from_str(text).map_err(|e| {
        AuthError::Network {
            message: format!("解析响应失败: {e}"),
        }
    })?;
    if resp.code != 1000 {
        return Err(AuthError::Api {
            code: resp.code,
            message: resp
                .message
                .unwrap_or_else(|| format!("code={}", resp.code)),
        });
    }
    resp.data.ok_or_else(|| AuthError::Network {
        message: "响应缺 data 字段".into(),
    })
}
```

- [ ] **Step 2: 追加单元测试**

在 `auth.rs` 的 `mod tests` 内追加：

```rust
    #[test]
    fn write_env_atomic_roundtrips_content() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(".env");
        write_env_atomic(&path, "A=1\nB=2\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "A=1\nB=2\n");
    }

    #[test]
    fn write_env_atomic_creates_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nested/deep/.env");
        write_env_atomic(&path, "X=1\n").unwrap();
        assert!(path.exists());
    }

    #[test]
    fn write_token_section_preserves_other_keys() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        fs::create_dir_all(&home).unwrap();
        let layout = Layout::new(&home);
        // 预置其他 provider 配置
        fs::write(&layout.user_env, "OPENROUTER_API_KEY=xxx\nTUSHARE_TOKEN=t\n").unwrap();

        let sess = UserSession {
            token: "tok".into(),
            refresh_token: "rt".into(),
            expire_at: 1700000000,
            refresh_expire_at: 1700000100,
            user_info: None,
        };
        write_env_token_section(&layout, &sess).unwrap();

        let after = fs::read_to_string(&layout.user_env).unwrap();
        assert!(after.contains("OPENROUTER_API_KEY=xxx"), "其他 provider 须保留");
        assert!(after.contains("TUSHARE_TOKEN=t"));
        assert!(after.contains("OPENAI_API_KEY=tok"));
        assert!(after.contains("OPENAI_BASE_URL=https://maas.nieanshow.cn/v1"));
        assert!(after.contains("LANGCHAIN_MODEL_NAME=deepseek-v4-flash"));
        assert!(after.contains("USER_REFRESH_TOKEN=rt"));
        assert!(after.contains("USER_TOKEN_EXPIRE=1700000000"));
    }

    #[test]
    fn read_token_section_roundtrips_after_write() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        fs::create_dir_all(&home).unwrap();
        let layout = Layout::new(&home);
        let sess = UserSession {
            token: "tok".into(),
            refresh_token: "rt".into(),
            expire_at: 1700000000,
            refresh_expire_at: 1700000100,
            user_info: None,
        };
        write_env_token_section(&layout, &sess).unwrap();

        let got = read_env_token_section(&layout).expect("应读到 session");
        assert_eq!(got.token, "tok");
        assert_eq!(got.refresh_token, "rt");
        assert_eq!(got.expire_at, 1700000000);
        assert_eq!(got.refresh_expire_at, 1700000100);
        assert!(got.user_info.is_none(), "恢复时不带 userInfo");
    }

    #[test]
    fn read_token_section_returns_none_when_no_token() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        fs::create_dir_all(&home).unwrap();
        let layout = Layout::new(&home);
        // 无任何 LLM key
        fs::write(&layout.user_env, "OTHER=1\n").unwrap();
        assert!(read_env_token_section(&layout).is_none());
    }

    #[test]
    fn read_token_section_returns_none_when_file_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(&tmp.path().join(".vibe-trading"));
        assert!(read_env_token_section(&layout).is_none());
    }

    #[test]
    fn parse_cool_response_unwraps_data_on_success() {
        let text = r#"{"code":1000,"data":{"captchaId":"c1","data":"svg"}}"#;
        let c: Captcha = parse_cool_response(text).unwrap();
        assert_eq!(c.captcha_id, "c1");
        assert_eq!(c.data, "svg");
    }

    #[test]
    fn parse_cool_response_maps_non_1000_to_api_error() {
        let text = r#"{"code":1001,"message":"验证码错误"}"#;
        let err = parse_cool_response::<Captcha>(text).unwrap_err();
        match err {
            AuthError::Api { code, message } => {
                assert_eq!(code, 1001);
                assert_eq!(message, "验证码错误");
            }
            other => panic!("期望 Api，得到 {other:?}"),
        }
    }

    #[test]
    fn parse_cool_response_maps_bad_json_to_network_error() {
        let err = parse_cool_response::<Captcha>("not json").unwrap_err();
        assert!(matches!(err, AuthError::Network { .. }));
    }
```

- [ ] **Step 3: 跑测试**

Run: `cd src-tauri && cargo test auth::tests -- --nocapture`
Expected: PASS（含 round-trip、其他 key 保留、原子写、cool-admin 解析全部用例）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/auth.rs
git commit -m "✨ feat(console): auth.rs .env 原子读写 + cool-admin 响应解析"
```

---

### Task 3: Rust `auth.rs` — cool-admin 客户端 + ensure_session_valid

**Files:**
- Modify: `src-tauri/src/auth.rs`（追加客户端函数与会话校验）

**Interfaces:**
- Consumes: Task 1/2 的类型、`parse_cool_response`、`write_env_token_section`、`read_env_token_section`、`now_secs`
- Produces: `fetch_captcha` / `send_sms` / `login_by_phone` / `login_by_password` / `refresh_token` / `set_password` / `fetch_user_info`；`decide_session_action(now, sess) -> Action` 纯函数；`ensure_session_valid(state, layout) -> Result<UserSession, AuthError>`

- [ ] **Step 1: 追加 cool-admin 客户端函数**

在 `auth.rs` 的 `parse_cool_response` 之后追加：

```rust
// ── cool-admin 客户端（同步 reqwest::blocking）──
// 端点与 frontend/src/lib/apiUser.ts 完全对齐；Authorization 裸 token（无 Bearer）。

const HTTP_TIMEOUT_SECS: u64 = 30;

fn http_client() -> Result<reqwest::blocking::Client, AuthError> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| AuthError::Network { message: format!("build client: {e}") })
}

fn endpoint(path: &str) -> String {
    format!("{}{}", user_api_url(), path)
}

pub fn fetch_captcha() -> Result<Captcha, AuthError> {
    let url = endpoint("/app/user/login/captcha?width=120&height=40");
    let text = http_client()?
        .get(&url)
        .send()
        .map_err(|e| AuthError::Network { message: format!("captcha: {e}") })?
        .text()
        .map_err(|e| AuthError::Network { message: format!("captcha body: {e}") })?;
    parse_cool_response(&text)
}

pub fn send_sms(phone: &str, captcha_id: &str, code: &str) -> Result<(), AuthError> {
    let url = endpoint("/app/user/login/smsCode");
    let body = serde_json::json!({ "phone": phone, "captchaId": captcha_id, "code": code });
    let text = http_client()?
        .post(&url)
        .json(&body)
        .send()
        .map_err(|e| AuthError::Network { message: format!("sms: {e}") })?
        .text()
        .map_err(|e| AuthError::Network { message: format!("sms body: {e}") })?;
    parse_cool_response::<serde_json::Value>(&text).map(|_| ())
}

/// 把 cool-admin 返回的相对秒 expire 转成绝对 epoch 秒。
pub fn session_from_login(raw: LoginRaw, user_info: Option<UserInfo>) -> UserSession {
    let now = now_secs();
    UserSession {
        token: raw.token,
        refresh_token: raw.refresh_token,
        expire_at: now + raw.expire,
        refresh_expire_at: now + raw.refresh_expire,
        user_info,
    }
}

pub fn login_by_phone(phone: &str, sms_code: &str) -> Result<LoginRaw, AuthError> {
    let url = endpoint("/app/user/login/phone");
    let body = serde_json::json!({ "phone": phone, "smsCode": sms_code });
    let text = http_client()?
        .post(&url)
        .json(&body)
        .send()
        .map_err(|e| AuthError::Network { message: format!("login phone: {e}") })?
        .text()
        .map_err(|e| AuthError::Network { message: format!("login phone body: {e}") })?;
    parse_cool_response(&text)
}

pub fn login_by_password(phone: &str, password: &str) -> Result<LoginRaw, AuthError> {
    let url = endpoint("/app/user/login/password");
    let body = serde_json::json!({ "phone": phone, "password": password });
    let text = http_client()?
        .post(&url)
        .json(&body)
        .send()
        .map_err(|e| AuthError::Network { message: format!("login pwd: {e}") })?
        .text()
        .map_err(|e| AuthError::Network { message: format!("login pwd body: {e}") })?;
    parse_cool_response(&text)
}

pub fn refresh_token(rt: &str) -> Result<LoginRaw, AuthError> {
    let url = endpoint("/app/user/login/refreshToken");
    let body = serde_json::json!({ "refreshToken": rt });
    let text = http_client()?
        .post(&url)
        .json(&body)
        .send()
        .map_err(|e| AuthError::Network { message: format!("refresh: {e}") })?
        .text()
        .map_err(|e| AuthError::Network { message: format!("refresh body: {e}") })?;
    parse_cool_response(&text)
}

pub fn set_password(token: &str, password: &str) -> Result<(), AuthError> {
    let url = endpoint("/app/user/info/setPassword");
    let body = serde_json::json!({ "password": password });
    let text = http_client()?
        .post(&url)
        .header("Authorization", token)
        .json(&body)
        .send()
        .map_err(|e| AuthError::Network { message: format!("set pwd: {e}") })?
        .text()
        .map_err(|e| AuthError::Network { message: format!("set pwd body: {e}") })?;
    parse_cool_response::<serde_json::Value>(&text).map(|_| ())
}

pub fn fetch_user_info(token: &str) -> Result<UserInfo, AuthError> {
    let url = endpoint("/app/user/info/person");
    let text = http_client()?
        .get(&url)
        .header("Authorization", token)
        .send()
        .map_err(|e| AuthError::Network { message: format!("userinfo: {e}") })?
        .text()
        .map_err(|e| AuthError::Network { message: format!("userinfo body: {e}") })?;
    parse_cool_response(&text)
}
```

- [ ] **Step 2: 追加 `decide_session_action` 纯函数与 `ensure_session_valid`**

在 `fetch_user_info` 之后追加：

```rust
// ── 会话校验：纯决策 + IO 包装 ──

pub enum SessionAction {
    Valid,
    NeedsRefresh,
    Expired,
}

/// 纯函数：依据当前时间戳决定动作（便于单测，不依赖系统时钟副作用）。
pub fn decide_session_action(now: i64, sess: &UserSession) -> SessionAction {
    if now < sess.expire_at {
        SessionAction::Valid
    } else if now < sess.refresh_expire_at {
        SessionAction::NeedsRefresh
    } else {
        SessionAction::Expired
    }
}

/// 启动服务前调：校验内存 session；过期则尝试 refresh（成功后重写 .env）。
/// refresh 失败或 refreshExpire 已到则返回 LoginExpired。
pub fn ensure_session_valid(
    state: &AuthState,
    layout: &Layout,
) -> Result<UserSession, AuthError> {
    let sess = state
        .0
        .lock()
        .unwrap()
        .clone()
        .or_else(|| read_env_token_section(layout))
        .ok_or(AuthError::NotAuthenticated)?;
    match decide_session_action(now_secs(), &sess) {
        SessionAction::Valid => Ok(sess),
        SessionAction::NeedsRefresh => {
            let raw = refresh_token(&sess.refresh_token)?;
            // refresh 未必返回新 userInfo，沿用旧 session 的 userInfo（若有）
            let mut new_sess = session_from_login(raw, sess.user_info.clone());
            // userInfo 缺失则尝试补全（旧 session 恢复时 user_info 为 None 时仍可工作）
            if new_sess.user_info.is_none() {
                if let Ok(info) = fetch_user_info(&new_sess.token) {
                    new_sess.user_info = Some(info);
                }
            }
            write_env_token_section(layout, &new_sess)?;
            *state.0.lock().unwrap() = Some(new_sess.clone());
            Ok(new_sess)
        }
        SessionAction::Expired => Err(AuthError::LoginExpired),
    }
}
```

- [ ] **Step 3: 追加 `decide_session_action` 单元测试**

在 `auth.rs` 的 `mod tests` 内追加（HTTP 函数不测——reqwest 已测过，端到端在 Task 10 覆盖）：

```rust
    fn sample_session(expire_at: i64, refresh_expire_at: i64) -> UserSession {
        UserSession {
            token: "t".into(),
            refresh_token: "r".into(),
            expire_at,
            refresh_expire_at,
            user_info: None,
        }
    }

    #[test]
    fn decide_action_valid_before_expire() {
        let sess = sample_session(1000, 2000);
        assert!(matches!(decide_session_action(999, &sess), SessionAction::Valid));
        assert!(matches!(decide_session_action(0, &sess), SessionAction::Valid));
    }

    #[test]
    fn decide_action_needs_refresh_between_expire_and_refresh_expire() {
        let sess = sample_session(1000, 2000);
        assert!(matches!(decide_session_action(1000, &sess), SessionAction::NeedsRefresh));
        assert!(matches!(decide_session_action(1999, &sess), SessionAction::NeedsRefresh));
    }

    #[test]
    fn decide_action_expired_after_refresh_expire() {
        let sess = sample_session(1000, 2000);
        assert!(matches!(decide_session_action(2000, &sess), SessionAction::Expired));
        assert!(matches!(decide_session_action(5000, &sess), SessionAction::Expired));
    }

    #[test]
    fn ensure_session_valid_returns_not_authenticated_when_empty() {
        use std::sync::Mutex;
        let state = AuthState(Mutex::new(None));
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(&tmp.path().join(".vibe-trading"));
        let err = ensure_session_valid(&state, &layout).unwrap_err();
        assert!(matches!(err, AuthError::NotAuthenticated));
    }
```

- [ ] **Step 4: 跑测试 + 编译**

Run: `cd src-tauri && cargo test auth::tests -- --nocapture && cargo build 2>&1 | tail -5`
Expected: 测试全 PASS；`cargo build` 编译通过（reqwest blocking 调用合法）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/auth.rs
git commit -m "✨ feat(console): auth.rs cool-admin 客户端 + ensure_session_valid"
```

---

### Task 4: Rust `console.rs` — 暴露 6 个登录命令 + 接入 start_service

**Files:**
- Modify: `src-tauri/src/console.rs`（追加命令、改 `console_start_service` 签名）
- Modify: `src-tauri/src/main.rs:25-39`（注册命令、`.manage(AuthState)`）

**Interfaces:**
- Consumes: Task 1-3 的全部 auth 函数与类型
- Produces: Tauri 命令 `console_login_captcha` / `console_login_send_sms` / `console_login_by_phone` / `console_login_by_password` / `console_login_set_password` / `console_auth_status`；`console_start_service` 现返 `Result<u16, ServiceStartError>`

- [ ] **Step 1: 在 `console.rs` 顶部 import 与新增 view 类型**

修改 `src-tauri/src/console.rs` 第 11-13 行的 use 区，追加：

```rust
use tauri::{AppHandle, Emitter, State};

use crate::auth::{
    self, AuthError, AuthState, Captcha, LoginRaw, UserInfo, UserSession,
};
use crate::runtime_dir::Layout;
```

在 `StatusReport` 定义之后（约第 159 行附近）追加两个返回给前端的 view 类型：

```rust
/// 登录命令返回给前端的结构（不含 token）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResultView {
    pub user_info: UserInfo,
    pub has_password: bool,
    pub expire_at: i64, // epoch 秒
}

/// console_auth_status 返回。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusView {
    pub authenticated: bool,
    pub user_info: Option<UserInfo>,
    pub expire_at: Option<i64>,
}

/// console_start_service 的错误（LoginExpired 让前端跳登录页）。
#[derive(Debug, serde::Serialize)]
#[serde(tag = "variant")]
pub enum ServiceStartError {
    EnvNotReady,
    AlreadyRunning,
    LoginExpired,
    SpawnFailed { message: String },
    HealthTimeout,
    ProcessExited { code: Option<i32> },
    Other { message: String },
}

impl std::fmt::Display for ServiceStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EnvNotReady => write!(f, "环境未就绪，请先完成依赖安装"),
            Self::AlreadyRunning => write!(f, "服务已在运行"),
            Self::LoginExpired => write!(f, "登录已过期，请重新登录"),
            Self::SpawnFailed { message } => write!(f, "启动失败: {message}"),
            Self::HealthTimeout => write!(f, "后端 120 秒内未就绪"),
            Self::ProcessExited { code } => write!(f, "后端提前退出（退出码 {code:?}）"),
            Self::Other { message } => write!(f, "{message}"),
        }
    }
}
```

- [ ] **Step 2: 改造 `console_start_service` 接入 `ensure_session_valid`**

把现有 `console_start_service`（src-tauri/src/console.rs:229-260）整段替换为：

```rust
/// 启动服务：先校验登录态（过期则尝试 refresh，失败返 LoginExpired），
/// 再 spawn serve + 健康门控。
#[tauri::command]
pub fn console_start_service(
    app: AppHandle,
    state: State<'_, SharedChild>,
    auth_state: State<'_, AuthState>,
) -> Result<u16, ServiceStartError> {
    let layout = Layout::from_home().map_err(|e| ServiceStartError::Other { message: e })?;
    if compute_env_status(&layout) != EnvStatus::Ready {
        return Err(ServiceStartError::EnvNotReady);
    }
    if state.lock().unwrap().is_some() {
        return Err(ServiceStartError::AlreadyRunning);
    }
    // 启动前校验 token：过期则 ensure_session_valid 内部尝试 refresh；失败返 LoginExpired
    let _session = auth::ensure_session_valid(&auth_state, &layout)
        .map_err(|_| ServiceStartError::LoginExpired)?;

    let port = crate::port::pick_free_port()
        .map_err(|e| ServiceStartError::Other { message: e })?;
    let mut child = crate::sidecar::spawn(
        &layout.venv_python,
        &layout.runtime_agent,
        port,
        &layout.runtime_libs,
        &layout.sessions_dir,
    )
    .map_err(|e| ServiceStartError::SpawnFailed { message: e })?;
    match crate::sidecar::await_health(&mut child, port) {
        crate::sidecar::Ready::Ok => {
            state.lock().unwrap().replace(child);
            let _ = app.emit("service://started", port);
            Ok(port)
        }
        crate::sidecar::Ready::ProcessExited(c) => Err(ServiceStartError::ProcessExited { code: c }),
        crate::sidecar::Ready::Timeout => Err(ServiceStartError::HealthTimeout),
    }
}
```

- [ ] **Step 3: 追加 6 个登录/auth 命令**

在 `console_start_service` 之后（停止服务之前）追加：

```rust
fn into_view(sess: UserSession) -> LoginResultView {
    LoginResultView {
        user_info: sess.user_info.expect("登录后必有 userInfo"),
        has_password: true, // 占位；真实 hasPassword 见下方命令
        expire_at: sess.expire_at,
    }
}

#[tauri::command]
pub fn console_login_captcha() -> Result<Captcha, AuthError> {
    auth::fetch_captcha()
}

#[tauri::command]
pub fn console_login_send_sms(phone: String, captcha_id: String, code: String) -> Result<(), AuthError> {
    auth::send_sms(&phone, &captcha_id, &code)
}

/// 登录通用收尾：调 cool-admin 拿 raw → 写 .env → fetch userInfo → 缓存 → 返 view。
fn finalize_login(
    raw: LoginRaw,
    has_password: bool,
    layout: &Layout,
    auth_state: &AuthState,
) -> Result<LoginResultView, AuthError> {
    let info = fetch_user_info_or_default(&raw.token);
    let mut sess = auth::session_from_login(raw, Some(info.clone()));
    auth::write_env_token_section(layout, &sess)?;
    sess.user_info = Some(info.clone());
    *auth_state.0.lock().unwrap() = Some(sess.clone());
    Ok(LoginResultView {
        user_info: info,
        has_password,
        expire_at: sess.expire_at,
    })
}

/// userInfo 拉取失败时用占位（不阻塞登录主流程，与原 Login.tsx 容错一致）。
fn fetch_user_info_or_default(token: &str) -> UserInfo {
    auth::fetch_user_info(token).unwrap_or(UserInfo {
        id: 0,
        unionid: None,
        avatar_url: None,
        nick_name: None,
        phone: None,
        gender: 0,
        status: 1,
        login_type: 2,
        description: None,
    })
}

#[tauri::command]
pub fn console_login_by_phone(
    phone: String,
    sms_code: String,
    auth_state: State<'_, AuthState>,
) -> Result<LoginResultView, AuthError> {
    let layout = Layout::from_home()
        .map_err(|e| AuthError::EnvWrite { message: e })?;
    let raw = auth::login_by_phone(&phone, &sms_code)?;
    let has_password = raw.has_password;
    finalize_login(raw, has_password, &layout, &auth_state)
}

#[tauri::command]
pub fn console_login_by_password(
    phone: String,
    password: String,
    auth_state: State<'_, AuthState>,
) -> Result<LoginResultView, AuthError> {
    let layout = Layout::from_home()
        .map_err(|e| AuthError::EnvWrite { message: e })?;
    let raw = auth::login_by_password(&phone, &password)?;
    let has_password = raw.has_password;
    finalize_login(raw, has_password, &layout, &auth_state)
}

#[tauri::command]
pub fn console_login_set_password(
    password: String,
    auth_state: State<'_, AuthState>,
) -> Result<(), AuthError> {
    let token = auth_state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.token.clone())
        .ok_or(AuthError::NotAuthenticated)?;
    auth::set_password(&token, &password)
}

#[tauri::command]
pub fn console_auth_status(
    auth_state: State<'_, AuthState>,
) -> Result<AuthStatusView, AuthError> {
    let layout = Layout::from_home()
        .map_err(|e| AuthError::EnvWrite { message: e })?;
    // 内存空则从 .env 恢复（不调网络）
    let mut guard = auth_state.0.lock().unwrap();
    if guard.is_none() {
        *guard = auth::read_env_token_section(&layout);
    }
    match guard.clone() {
        Some(sess) => Ok(AuthStatusView {
            authenticated: true,
            user_info: sess.user_info,
            expire_at: Some(sess.expire_at),
        }),
        None => Ok(AuthStatusView {
            authenticated: false,
            user_info: None,
            expire_at: None,
        }),
    }
}
```

- [ ] **Step 4: 在 `main.rs` 注册命令并 manage AuthState**

修改 `src-tauri/src/main.rs`：

把 `let shared: SharedChild = Arc::new(Mutex::new(None));` 之后追加：

```rust
let auth_state = console::AuthState(std::sync::Mutex::new(None));
```

把 `invoke_handler` 块替换为（追加 6 个命令）：

```rust
        .invoke_handler(tauri::generate_handler![
            open_external_url,
            console::console_status,
            console::console_bootstrap,
            console::console_start_service,
            console::console_stop_service,
            console::console_open_webui,
            console::console_start_channels,
            console::console_channels_status,
            console::console_install_channel_dep,
            console::console_confirm_close,
            console::console_open_logs,
            console::console_login_captcha,
            console::console_login_send_sms,
            console::console_login_by_phone,
            console::console_login_by_password,
            console::console_login_set_password,
            console::console_auth_status
        ])
```

在 `.manage(console::CloseConfirmed(close_confirmed))` 之后追加一行：

```rust
        .manage(auth_state)
```

- [ ] **Step 5: 编译 + 现有 console 测试不受影响**

Run: `cd src-tauri && cargo build 2>&1 | tail -10`
Expected: 编译通过（无类型错误；`ServiceStartError` 已实现 `Display` 满足 Tauri 要求）。

Run: `cd src-tauri && cargo test console::tests -- --nocapture | tail -20`
Expected: 现有 console 单测全 PASS（命令改造不影响纯函数测试）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/console.rs src-tauri/src/main.rs
git commit -m "✨ feat(console): 6 个登录 IPC 命令 + start_service 接入 ensure_session_valid"
```

---

### Task 5: Vue console-app — `stores/auth.ts` + ipc 类型与命令

**Files:**
- Create: `src-tauri/console-app/src/stores/auth.ts`
- Modify: `src-tauri/console-app/src/ipc/types.ts`
- Modify: `src-tauri/console-app/src/ipc/commands.ts`

**Interfaces:**
- Consumes: Rust 端（Task 4）的命令名与返回结构
- Produces: TS 类型 `UserInfo` / `LoginResultView` / `AuthStatusView` / `AuthError` / `ServiceStartError`；invoke 函数 6 个；Pinia `useAuthStore`

- [ ] **Step 1: 在 `ipc/types.ts` 追加类型**

在 `src-tauri/console-app/src/ipc/types.ts` 末尾追加：

```ts
// === Auth / Login（镜像 src-tauri/src/console.rs 与 auth.rs）===

export interface UserInfo {
  id: number;
  unionid?: string | null;
  avatarUrl?: string | null;
  nickName?: string | null;
  phone?: string | null;
  gender: number;
  status: number;
  loginType: number;
  description?: string | null;
}

export interface LoginResultView {
  userInfo: UserInfo;
  hasPassword: boolean;
  expireAt: number; // epoch 秒
}

export interface AuthStatusView {
  authenticated: boolean;
  userInfo?: UserInfo | null;
  expireAt?: number | null;
}

export interface Captcha {
  captchaId: string;
  data: string; // base64 svg（可能含 data: 前缀）
}

// Rust 端 #[serde(tag="variant")] 错误，前端按 e.variant 分流
export interface AuthError {
  variant:
    | "Network"
    | "Api"
    | "LoginExpired"
    | "EnvWrite"
    | "NotAuthenticated";
  message?: string;
  code?: number;
}

export interface ServiceStartError {
  variant:
    | "EnvNotReady"
    | "AlreadyRunning"
    | "LoginExpired"
    | "SpawnFailed"
    | "HealthTimeout"
    | "ProcessExited"
    | "Other";
  message?: string;
  code?: number | null;
}
```

- [ ] **Step 2: 在 `ipc/commands.ts` 追加 invoke 函数**

在 `src-tauri/console-app/src/ipc/commands.ts` 末尾追加：

```ts
import type {
  AuthStatusView,
  Captcha,
  LoginResultView,
} from "./types";

// 与 src-tauri/src/console.rs 的 #[tauri::command] 一一对应。
export const consoleLoginCaptcha = (): Promise<Captcha> =>
  invoke<Captcha>("console_login_captcha");

export const consoleLoginSendSms = (
  phone: string,
  captchaId: string,
  code: string,
): Promise<void> =>
  invoke<void>("console_login_send_sms", { phone, captchaId, code });

export const consoleLoginByPhone = (
  phone: string,
  smsCode: string,
): Promise<LoginResultView> =>
  invoke<LoginResultView>("console_login_by_phone", { phone, smsCode });

export const consoleLoginByPassword = (
  phone: string,
  password: string,
): Promise<LoginResultView> =>
  invoke<LoginResultView>("console_login_by_password", { phone, password });

export const consoleLoginSetPassword = (password: string): Promise<void> =>
  invoke<void>("console_login_set_password", { password });

export const consoleAuthStatus = (): Promise<AuthStatusView> =>
  invoke<AuthStatusView>("console_auth_status");
```

- [ ] **Step 3: 创建 `stores/auth.ts`**

创建 `src-tauri/console-app/src/stores/auth.ts`：

```ts
import { defineStore } from "pinia";
import { ref } from "vue";
import type { AuthStatusView, UserInfo } from "../ipc/types";
import { consoleAuthStatus } from "../ipc/commands";

// 只存展示态：userInfo / authenticated / expireAt。token 永不进 store（保留在 Rust）。
export const useAuthStore = defineStore("auth", () => {
  const authenticated = ref(false);
  const userInfo = ref<UserInfo | null>(null);
  const expireAt = ref<number | null>(null);

  function setFromLogin(view: { userInfo: UserInfo; expireAt: number }) {
    authenticated.value = true;
    userInfo.value = view.userInfo;
    expireAt.value = view.expireAt;
  }

  function clear() {
    authenticated.value = false;
    userInfo.value = null;
    expireAt.value = null;
  }

  /** console 启动时从 Rust 恢复登录态（Rust 内存或 .env）。 */
  async function refresh() {
    try {
      const s: AuthStatusView = await consoleAuthStatus();
      authenticated.value = s.authenticated;
      userInfo.value = s.userInfo ?? null;
      expireAt.value = s.expireAt ?? null;
    } catch {
      clear();
    }
  }

  return { authenticated, userInfo, expireAt, setFromLogin, clear, refresh };
});
```

- [ ] **Step 4: 类型检查**

Run: `cd src-tauri/console-app && npm run build 2>&1 | tail -10`
Expected: `vue-tsc --noEmit` 通过（无类型错误）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/console-app/src/stores/auth.ts src-tauri/console-app/src/ipc/types.ts src-tauri/console-app/src/ipc/commands.ts
git commit -m "✨ feat(console): auth store + 登录 IPC 类型与 invoke"
```

---

### Task 6: Vue console-app — `SetPasswordModal.vue` + `LoginPage.vue`

**Files:**
- Create: `src-tauri/console-app/src/components/SetPasswordModal.vue`
- Create: `src-tauri/console-app/src/pages/LoginPage.vue`
- Create: `src-tauri/console-app/src/pages/__tests__/LoginPage.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `useAuthStore` 与 6 个 invoke；现有 `useBusy` 组合式
- Produces: `/login` 路由组件；`SetPasswordModal` 子组件

- [ ] **Step 1: 创建 `SetPasswordModal.vue`**

创建 `src-tauri/console-app/src/components/SetPasswordModal.vue`（迁移自 `frontend/src/components/auth/SetPasswordModal.tsx`，改用 IPC）：

```vue
<script setup lang="ts">
import { ref } from "vue";
import { consoleLoginSetPassword } from "../ipc/commands";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: "close"): void;
}>();

const pwd = ref("");
const confirm = ref("");
const submitting = ref(false);
const err = ref("");

async function submit() {
  err.value = "";
  if (pwd.value.length < 6) {
    err.value = "密码至少 6 位";
    return;
  }
  if (pwd.value !== confirm.value) {
    err.value = "两次输入不一致";
    return;
  }
  if (submitting.value) return;
  submitting.value = true;
  try {
    await consoleLoginSetPassword(pwd.value);
    pwd.value = "";
    confirm.value = "";
    emit("close");
  } catch (e: any) {
    err.value = e?.message || String(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div v-if="props.open" class="modal-mask">
    <div class="modal-card">
      <h2>设置登录密码</h2>
      <p class="hint">首次登录请设置密码，之后可用密码登录。</p>
      <input
        class="field"
        type="password"
        v-model="pwd"
        placeholder="新密码"
        :disabled="submitting"
      />
      <input
        class="field"
        type="password"
        v-model="confirm"
        placeholder="确认密码"
        :disabled="submitting"
      />
      <div class="row">
        <button class="btn primary" :disabled="submitting" @click="submit">
          {{ submitting ? "提交中…" : "确认" }}
        </button>
        <button class="btn ghost" :disabled="submitting" @click="emit('close')">
          跳过
        </button>
      </div>
      <p v-if="err" class="err">{{ err }}</p>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
}
.modal-card {
  width: 100%;
  max-width: 360px;
  background: var(--bg-card, #fff);
  border-radius: 8px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.field {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #ccc;
  border-radius: 6px;
}
.row {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.btn {
  flex: 1;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid #ccc;
  cursor: pointer;
}
.btn.primary {
  background: #2563eb;
  color: #fff;
}
.btn.ghost {
  background: transparent;
}
.hint {
  font-size: 12px;
  color: #666;
}
.err {
  color: #dc2626;
  font-size: 12px;
}
</style>
```

- [ ] **Step 2: 创建 `LoginPage.vue`**

创建 `src-tauri/console-app/src/pages/LoginPage.vue`（1:1 迁移 `frontend/src/pages/auth/Login.tsx`，短信+密码双 tab + 图形验证码 + 60s 倒计时 + 首登设密码弹窗；所有请求走 IPC，错误用 `AuthError.variant`）：

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from "vue";
import { useRouter } from "vue-router";

import {
  consoleLoginCaptcha,
  consoleLoginSendSms,
  consoleLoginByPhone,
  consoleLoginByPassword,
} from "../ipc/commands";
import type { Captcha } from "../ipc/types";
import { useAuthStore } from "../stores/auth";
import { useBusy } from "../composables/useBusy";
import SetPasswordModal from "../components/SetPasswordModal.vue";

const router = useRouter();
const auth = useAuthStore();

const tab = ref<"sms" | "password">("sms");
const captcha = ref<Captcha | null>(null);
const phone = ref("");
const captchaCode = ref("");
const smsCode = ref("");
const password = ref("");
const countdown = ref(0);
const err = ref("");
const showSetPwd = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

const PHONE_RE = /^1\d{10}$/;
const isCode4 = (s: string) => /^\d{4}$/.test(s) || /^[0-9a-zA-Z]{4}$/.test(s);
const phoneValid = computed(() => PHONE_RE.test(phone.value));
const captchaValid = computed(() => isCode4(captchaCode.value));
const smsValid = computed(() => isCode4(smsCode.value));
const passwordValid = computed(() => password.value.length >= 6);

async function loadCaptcha() {
  err.value = "";
  try {
    captcha.value = await consoleLoginCaptcha();
  } catch (e: any) {
    err.value = e?.message || "验证码加载失败";
  }
}

function setErr(e: unknown, fallback: string) {
  const ae = e as { message?: string };
  err.value = ae?.message || fallback;
  void loadCaptcha();
}

async function sendCode() {
  if (!phoneValid.value || !captchaValid.value || countdown.value > 0) return;
  if (!captcha.value) return;
  try {
    await consoleLoginSendSms(phone.value, captcha.value.captchaId, captchaCode.value);
    countdown.value = 60;
    timer = setInterval(() => {
      countdown.value -= 1;
      if (countdown.value <= 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    }, 1000);
  } catch (e) {
    setErr(e, "短信发送失败");
  }
}

const sendBusy = useBusy();
const submitBusy = useBusy();

async function finishLogin(
  view: { userInfo: any; hasPassword: boolean; expireAt: number },
) {
  auth.setFromLogin(view);
  if (!view.hasPassword) {
    showSetPwd.value = true;
    return;
  }
  router.replace("/");
}

async function submitSms() {
  if (!phoneValid.value || !smsValid.value) return;
  await submitBusy.run("登录中", async () => {
    err.value = "";
    try {
      const view = await consoleLoginByPhone(phone.value, smsCode.value);
      await finishLogin(view);
    } catch (e) {
      setErr(e, "登录失败");
    }
  });
}

async function submitPassword() {
  if (!phoneValid.value || !passwordValid.value) return;
  await submitBusy.run("登录中", async () => {
    err.value = "";
    try {
      const view = await consoleLoginByPassword(phone.value, password.value);
      await finishLogin(view);
    } catch (e) {
      setErr(e, "密码登录失败");
    }
  });
}

function onPwdModalClose() {
  showSetPwd.value = false;
  router.replace("/");
}

onMounted(() => {
  void loadCaptcha();
  // 已登录直接跳走
  if (auth.authenticated) router.replace("/");
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <main class="login-wrap">
    <div class="card">
      <h1>Vibe Trading</h1>
      <p class="sub">登录后启动服务，自动配置 vip 大模型</p>

      <div class="tabs">
        <button :class="['tab', tab === 'sms' && 'active']" @click="tab = 'sms'">
          短信登录
        </button>
        <button :class="['tab', tab === 'password' && 'active']" @click="tab = 'password'">
          密码登录
        </button>
      </div>

      <div v-if="tab === 'sms'" class="form">
        <label>
          <span>手机号</span>
          <input
            class="field"
            v-model="phone"
            inputmode="numeric"
            placeholder="13800000000"
            @input="phone = phone.replace(/\D/g, '').slice(0, 11)"
          />
        </label>

        <label>
          <span>图形验证码</span>
          <div class="inline">
            <input
              class="field"
              v-model="captchaCode"
              placeholder="abcd"
              @input="captchaCode = captchaCode.trim().slice(0, 4)"
            />
            <button
              class="captcha-btn"
              title="刷新验证码"
              @click="loadCaptcha"
            >
              <img
                v-if="captcha"
                :src="
                  captcha.data.startsWith('data:')
                    ? captcha.data
                    : `data:image/svg+xml;base64,${captcha.data}`
                "
                alt="captcha"
              />
              <span v-else>…</span>
            </button>
          </div>
        </label>

        <label>
          <span>短信验证码</span>
          <div class="inline">
            <input
              class="field"
              v-model="smsCode"
              inputmode="numeric"
              placeholder="1234"
              @input="smsCode = smsCode.trim().slice(0, 4)"
            />
            <button
              class="code-btn"
              :disabled="!phoneValid || !captchaValid || countdown > 0"
              @click="sendCode"
            >
              {{ countdown > 0 ? `${countdown}s` : "获取" }}
            </button>
          </div>
        </label>

        <button
          class="submit"
          :disabled="!phoneValid || !smsValid || submitBusy.busy.value"
          @click="submitSms"
        >
          {{ submitBusy.busy.value ? "登录中…" : "登录" }}
        </button>
      </div>

      <div v-else class="form">
        <label>
          <span>手机号</span>
          <input
            class="field"
            v-model="phone"
            inputmode="numeric"
            placeholder="13800000000"
            @input="phone = phone.replace(/\D/g, '').slice(0, 11)"
          />
        </label>
        <label>
          <span>密码</span>
          <input
            class="field"
            type="password"
            v-model="password"
            placeholder="******"
          />
        </label>
        <button
          class="submit"
          :disabled="!phoneValid || !passwordValid || submitBusy.busy.value"
          @click="submitPassword"
        >
          {{ submitBusy.busy.value ? "登录中…" : "登录" }}
        </button>
      </div>

      <p v-if="err" class="err">{{ err }}</p>
    </div>

    <SetPasswordModal :open="showSetPwd" @close="onPwdModalClose" />
  </main>
</template>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.card {
  width: 100%;
  max-width: 360px;
  background: var(--bg-card, #fff);
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}
h1 {
  margin: 0 0 4px;
  font-size: 20px;
}
.sub {
  margin: 0 0 16px;
  font-size: 12px;
  color: #666;
}
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.tab {
  flex: 1;
  padding: 8px;
  border: none;
  background: transparent;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.tab.active {
  border-bottom-color: #2563eb;
  color: #2563eb;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.field {
  padding: 8px 10px;
  border: 1px solid #ccc;
  border-radius: 6px;
}
.inline {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.inline .field {
  flex: 1;
}
.captcha-btn {
  width: 100px;
  border: 1px solid #ccc;
  background: #70634e;
  border-radius: 6px;
  cursor: pointer;
  overflow: hidden;
  padding: 0;
}
.captcha-btn img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.code-btn {
  width: 100px;
  border: 1px solid #ccc;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.code-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.submit {
  width: 100%;
  padding: 10px;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.err {
  color: #dc2626;
  font-size: 12px;
  margin-top: 8px;
}
</style>
```

- [ ] **Step 3: 写 `LoginPage.test.ts`（先失败）**

创建 `src-tauri/console-app/src/pages/__tests__/LoginPage.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";

// mock IPC：记录调用 + 返回伪造 view
const mocks = vi.fn();
vi.mock("../../ipc/commands", () => ({
  consoleLoginCaptcha: vi.fn(async () => ({ captchaId: "c1", data: "data:image/svg+xml;base64,AA==" })),
  consoleLoginSendSms: vi.fn(async () => {}),
  consoleLoginByPhone: vi.fn(async (_phone: string, _code: string) => ({
    userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1, loginType: 2 },
    hasPassword: true,
    expireAt: 9999999999,
  })),
  consoleLoginByPassword: vi.fn(async () => ({
    userInfo: { id: 1, nickName: "Tester", gender: 0, status: 1, loginType: 2 },
    hasPassword: true,
    expireAt: 9999999999,
  })),
  consoleLoginSetPassword: vi.fn(async () => {}),
}));

import LoginPage from "../LoginPage.vue";
import { consoleLoginByPhone, consoleLoginByPassword } from "../../ipc/commands";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<div>home</div>" } },
    { path: "/login", component: LoginPage },
  ],
});

beforeEach(async () => {
  mocks.mockClear();
  await router.push("/login");
  await router.isReady();
});

describe("LoginPage", () => {
  it("渲染两个 tab 且默认短信", () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    expect(w.text()).toContain("短信登录");
    expect(w.text()).toContain("密码登录");
    // 默认 tab=sms：应有"获取"验证码按钮
    expect(w.text()).toContain("获取");
  });

  it("切换到密码 tab 后提交调 consoleLoginByPassword", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    await w.find(".tab.password, [class*='password']").trigger("click");
    // 让 tab 切换生效：直接点包含"密码登录"的按钮
    const tabs = w.findAll(".tab");
    const pwdTab = tabs.find((b) => b.text().includes("密码登录"))!;
    await pwdTab.trigger("click");

    const inputs = w.findAll("input");
    // 手机号 + 密码
    await inputs[0]!.setValue("13800000000");
    await inputs[1]!.setValue("secret1");

    const submit = w.findAll("button").find((b) => b.text().includes("登录"))!;
    await submit.trigger("click");
    await flushPromises();

    expect(consoleLoginByPassword).toHaveBeenCalledWith("13800000000", "secret1");
  });

  it("短信登录：手机号 11 位 + 4 位验证码后提交", async () => {
    const w = mount(LoginPage, { global: { plugins: [router] } });
    const inputs = w.findAll("input");
    await inputs[0]!.setValue("13800000000"); // phone
    await inputs[1]!.setValue("abcd");        // captchaCode
    await inputs[2]!.setValue("1234");        // smsCode
    const submit = w.findAll("button").find((b) => b.text() === "登录")!;
    await submit.trigger("click");
    await flushPromises();
    expect(consoleLoginByPhone).toHaveBeenCalledWith("13800000000", "1234");
  });
});
```

- [ ] **Step 4: 跑测试**

Run: `cd src-tauri/console-app && npm run test -- LoginPage 2>&1 | tail -20`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 类型检查 + build**

Run: `cd src-tauri/console-app && npm run build 2>&1 | tail -10`
Expected: `vue-tsc --noEmit && vite build` 通过。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/console-app/src/components/SetPasswordModal.vue src-tauri/console-app/src/pages/LoginPage.vue src-tauri/console-app/src/pages/__tests__/LoginPage.test.ts
git commit -m "✨ feat(console): LoginPage + SetPasswordModal（1:1 迁移自 React WebUI）"
```

---

### Task 7: Vue console-app — 路由守卫 + ConsolePage 接入 auth

**Files:**
- Modify: `src-tauri/console-app/src/router.ts`
- Modify: `src-tauri/console-app/src/pages/ConsolePage.vue`

**Interfaces:**
- Consumes: Task 5 `useAuthStore`；Task 6 `LoginPage`；`ServiceStartError.variant === "LoginExpired"`

- [ ] **Step 1: 改 `router.ts` 加 `/login` 路由 + 守卫**

替换 `src-tauri/console-app/src/router.ts` 全文：

```ts
import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";
import { useAuthStore } from "./stores/auth";

const routes: RouteRecordRaw[] = [
  { path: "/login", component: () => import("./pages/LoginPage.vue") },
  { path: "/", component: () => import("./pages/ConsolePage.vue") },
  { path: "/channels", component: () => import("./pages/ChannelsPage.vue") },
  { path: "/settings", component: () => import("./pages/SettingsPage.vue") },
  { path: "/monitor", component: () => import("./pages/MonitorPage.vue") },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// 未登录（auth.authenticated !== true）一律跳 /login；登录后 /login 跳回 /。
router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.path === "/login") {
    if (auth.authenticated) return "/";
    return true;
  }
  if (!auth.authenticated) return "/login";
  return true;
});
```

- [ ] **Step 2: 改 `ConsolePage.vue` 接入 auth**

在 `src-tauri/console-app/src/pages/ConsolePage.vue` 的 `<script setup>` 顶部 import 区追加：

```ts
import { useAuthStore } from "../stores/auth";
import { useRouter } from "vue-router";
```

在 `const channels = useChannelsStore();` 之后追加：

```ts
const authStore = useAuthStore();
const router = useRouter();
```

在现有 `onMounted` 的 `refresh();` **之前**追加恢复登录态 + 守门：

```ts
  // 恢复登录态：从 Rust 内存或 .env 读 token；未登录则跳 /login。
  await authStore.refresh();
  if (!authStore.authenticated) {
    router.replace("/login");
    return;
  }
```

把 `onStart` 函数改为捕获 `LoginExpired` 并跳登录页：

```ts
async function onStart() {
  await startBusy.run("启动中", async () => {
    setErr("");
    try {
      const p = await service.start();
      env.setPort(p);
      hintHidden.value = true;
    } catch (e: any) {
      if (e?.variant === "LoginExpired") {
        authStore.clear();
        router.replace("/login");
        return;
      }
      setErr(e?.message || String(e));
    }
  });
}
```

- [ ] **Step 3: 跑现有测试不回归 + 类型检查**

Run: `cd src-tauri/console-app && npm run test 2>&1 | tail -15`
Expected: 现有 bootstrap/events/commands 测试 + LoginPage 测试全 PASS。

Run: `cd src-tauri/console-app && npm run build 2>&1 | tail -10`
Expected: build 通过。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/console-app/src/router.ts src-tauri/console-app/src/pages/ConsolePage.vue
git commit -m "✨ feat(console): /login 路由 + 守卫 + start_service LoginExpired 跳转"
```

---

### Task 8: WebUI 清理（frontend/）— 删 9 文件 + 改 4 文件

**Files:**
- Delete: 见 File Structure
- Modify: `frontend/src/router.tsx`、`frontend/src/main.tsx`、`frontend/src/pages/Settings.tsx`、`frontend/vite.config.ts`

**Interfaces:**
- Consumes: spec §8 WebUI 清理清单

- [ ] **Step 1: 删除 9 个文件**

```bash
cd frontend
git rm src/pages/auth/Login.tsx \
       src/pages/auth/__tests__/Login.test.tsx \
       src/components/auth/SetPasswordModal.tsx \
       src/components/auth/RequireAuth.tsx \
       src/stores/auth.ts \
       src/lib/apiUser.ts \
       src/types/user.ts \
       src/pages/profile/Profile.tsx \
       src/components/layout/UserMenu.tsx
```

- [ ] **Step 2: 改 `router.tsx`**

打开 `frontend/src/router.tsx`，删除：
- 第 4 行 `import { RequireAuth } from "@/components/auth/RequireAuth";`
- 第 30 行 `const Profile = lazy(() => import("@/pages/profile/Profile")...);`
- 第 49 行 `{ path: "/login", element: wrap(Login) },`
- 第 66-67 行 `RequireAuth` 包裹与 `/profile` 子路由（保留其他受保护路由的话，把 `RequireAuth` 直接删掉，让那些路由变成无守卫的普通路由——它们调用的是 agent backend 的 `API_AUTH_KEY` 鉴权，与 user 登录无关）

具体：把原 `RequireAuth` 那段（约 64-68 行）整段删除，其下原本是 `RequireAuth` 的 children 路由（`/profile`）也删掉。其他路由保持不变。

- [ ] **Step 3: 改 `main.tsx`**

打开 `frontend/src/main.tsx`，删除：
- 第 8 行 `import { useAuthStore } from "@/stores/auth";`
- 第 15-16 行注释与 `void useAuthStore.getState().bootstrap();`

- [ ] **Step 4: 改 `Settings.tsx`**

打开 `frontend/src/pages/Settings.tsx`：
- 删第 10 行 `import { useAuthStore } from "@/stores/auth";`
- 删第 94-95 行 `const authStatus = useAuthStore((s) => s.status);` 与 `const userInfo = useAuthStore((s) => s.userInfo);`
- 在模板里搜索用到 `authStatus` / `userInfo` 的状态角 JSX（约在返回的 JSX 里），整段删除或替换为静态提示文案（如 `<div>账户管理已移至桌面控制台</div>`）

Run: `cd frontend && grep -n "authStatus\|userInfo\|useAuthStore" src/pages/Settings.tsx`
Expected: 无输出（确认清理干净）。

- [ ] **Step 5: 改 `vite.config.ts`**

打开 `frontend/vite.config.ts`，删除 `/user-api` 的 proxy 配置块（在 server.proxy 里，通常是 `"/user-api": { target: ..., rewrite: ... }`）。

Run: `cd frontend && grep -n "user-api" vite.config.ts`
Expected: 无输出。

- [ ] **Step 6: 全量搜索残留引用**

```bash
cd frontend
grep -rn "useAuthStore\|apiUser\|SetPasswordModal\|RequireAuth\|stores/auth\|lib/apiUser\|types/user" src --include="*.ts" --include="*.tsx" | grep -v "__tests__" | grep -v "node_modules"
```
Expected: 无输出（若有残留，逐一改为不依赖 auth 的写法或删除）。

- [ ] **Step 7: 类型检查 + WebUI 测试**

Run: `cd frontend && npx tsc -b 2>&1 | tail -15`
Expected: 无类型错误。

Run: `cd frontend && npx vitest run 2>&1 | tail -15`
Expected: 现有测试 PASS（Login.test.tsx 已删，不参与）。

- [ ] **Step 8: Commit**

```bash
git add -A frontend
git commit -m "🧹 chore(webui): 移除登录入口与 auth 基础设施（迁至桌面 console）"
```

---

### Task 9: 端到端验证

**Files:** 无（验证 Task 1-8 集成）

- [ ] **Step 1: Rust 全量测试**

Run: `cd src-tauri && cargo test 2>&1 | tail -20`
Expected: 全 PASS（含 auth::tests、console::tests、runtime_dir、sidecar 等）。

- [ ] **Step 2: console-app 全量测试 + build**

Run: `cd src-tauri/console-app && npm run test && npm run build 2>&1 | tail -15`
Expected: 测试全 PASS；`vue-tsc --noEmit && vite build` 通过。

- [ ] **Step 3: WebUI 测试 + build**

Run: `cd frontend && npx vitest run && npm run build 2>&1 | tail -15`
Expected: 测试 PASS；`tsc -b && vite build` 通过。

- [ ] **Step 4: 桌面应用冒烟（手动）**

Run: `cd src-tauri && cargo tauri dev 2>&1 | head -40`
Expected（手动验证）：
1. console 启动后跳 `/login`（未登录）
2. 输入手机号 + 图形验证码 → 点"获取"收到短信
3. 输入短信码 → 登录成功 → 跳回 `/`（console 主页）
4. 检查 `cat ~/.vibe-trading/.env`：应含 `OPENAI_API_KEY=<token>`、`OPENAI_BASE_URL=https://maas.nieanshow.cn/v1`、`USER_REFRESH_TOKEN=<rt>`、`USER_TOKEN_EXPIRE=<epoch>`
5. 点"启动服务" → 健康检查通过 → "在浏览器打开 WebUI"按钮激活
6. 浏览器 WebUI 不再有 `/login` 入口（直接进首页）

- [ ] **Step 5: token 刷新路径冒烟（可选，需等 token 过期或手动改 .env）**

把 `~/.vibe-trading/.env` 里 `USER_TOKEN_EXPIRE` 改成过去时间（`USER_TOKEN_EXPIRE=1`），保留 `USER_REFRESH_TOKEN` 有效，重启 console，点"启动服务"：
Expected: Rust 静默 refresh（看 `~/.vibe-trading/.env` 的 `OPENAI_API_KEY` 已更新为新 token），服务正常启动。

把 `USER_REFRESH_EXPIRE` 也改成过去时间，点"启动服务"：
Expected: console 跳 `/login`，toast "登录已过期"。

- [ ] **Step 6: 最终 commit（如有手动验证中修复）**

```bash
git status
# 若有改动：
git add -A
git commit -m "✅ test(console): 端到端验证通过"
```

---

## Self-Review

**1. Spec coverage**
- §2 目标：登录迁 console（Task 6）、写 .env（Task 2/4）、token 不入浏览器（Task 4 LoginResultView 不含 token）、自动刷新（Task 3 ensure_session_valid + Task 7 接入）、WebUI 移除（Task 8）✓
- §4 架构：Rust 全链路（Task 1-4）、配置项 env var 覆盖（Task 1 `user_api_url`/`default_model`）✓
- §5 数据流：登录（Task 4/6）、启动服务校验（Task 4/7）、vip 携带（自动，无需 task）、重启恢复（Task 4 console_auth_status + Task 3 read_env_token_section）✓
- §6 .env 格式：7 个 key（Task 2 write_env_token_section）+ atomic（Task 2 write_env_atomic）+ 0600（Task 2 unix 分支）✓
- §7 组件：Rust auth.rs（Task 1-3）、6 IPC 命令（Task 4）、Vue LoginPage/SetPasswordModal/store（Task 5-6）✓
- §8 WebUI 清理：9 删 + 4 改（Task 8）✓
- §9 错误处理：5 个场景映射到 AuthError/ServiceStartError（Task 1/4）✓
- §10 测试：Rust 单测（Task 1-3）、Vue 迁移测试（Task 6）、端到端（Task 9）✓
- §11 开放问题：WebUI Settings LLM UI 语义重叠 — 本次不处理（Task 8 step 4 注释提示）✓

**2. Placeholder scan** — 无 TBD/TODO；每个代码步骤含完整可运行代码；测试含完整断言。

**3. Type consistency**
- `LoginResultView { userInfo, hasPassword, expireAt }`：Task 4 Rust 定义 ↔ Task 5 TS 类型 ↔ Task 6 LoginPage 消费 ✓
- `AuthStatusView { authenticated, userInfo?, expireAt? }`：Task 4 ↔ Task 5 ↔ Task 7 ConsolePage ✓
- `ServiceStartError.variant === "LoginExpired"`：Task 4 Rust enum ↔ Task 5 TS ↔ Task 7 ConsolePage catch ✓
- `AuthError`：Task 1 Rust ↔ Task 5 TS（均 tag="variant"）✓
- `UserSession`：Task 1 定义、Task 2 read 返、Task 3 ensure 消费、Task 4 finalize 写 ✓
- cool-admin 端点：Task 3 Rust 与 `frontend/src/lib/apiUser.ts`（删除前）完全对齐 ✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-05-desktop-console-login-env.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 每个 task 派一个新 subagent，任务间 review，迭代快
**2. Inline Execution** - 在当前会话用 executing-plans 批量执行，带 checkpoint review

选哪种？
