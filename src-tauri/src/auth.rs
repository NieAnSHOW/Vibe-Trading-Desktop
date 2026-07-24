//! 桌面 console 用户登录：cool-admin 客户端 + ~/.vibe-trading/.env token 段读写。
//! 设计见 docs/superpowers/specs/2026-07-05-desktop-console-login-env-design.md
//! 全部同步 + reqwest::blocking，与 console.rs 现有命令风格一致。

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::runtime_dir::Layout;

// ── 可覆盖配置 ──
// 业务接口（captcha/sms/login/person...），独立于大模型 MaaS 接口。
// 默认值与 frontend/src/pages/auth/Login.tsx 对齐。 https://trading-server.nieanshow.cn
pub fn user_api_url() -> String {
    std::env::var("VIBE_USER_API_URL").unwrap_or_else(|_| "http://127.0.0.1:8001".into())
}
// ── .env 中由本模块管辖的 key（其余 key 不动）──
pub const ENV_KEY_PROVIDER: &str = "LANGCHAIN_PROVIDER";
pub const ENV_KEY_MODEL: &str = "LANGCHAIN_MODEL_NAME";
pub const ENV_KEY_BASE_URL: &str = "OPENAI_BASE_URL";
pub const ENV_KEY_API_KEY: &str = "OPENAI_API_KEY";
pub const ENV_KEY_ACCESS: &str = "USER_ACCESS_TOKEN";
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

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network { message } => write!(f, "网络错误: {message}"),
            Self::Api { code, message } => write!(f, "API 错误({code}): {message}"),
            Self::LoginExpired => write!(f, "登录已过期"),
            Self::EnvWrite { message } => write!(f, "写入 .env 失败: {message}"),
            Self::NotAuthenticated => write!(f, "未登录"),
        }
    }
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
    pub expire: i64,         // 相对秒
    pub refresh_expire: i64, // 相对秒
    pub has_password: bool,
    pub member: MemberLoginRaw,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberLoginRaw {
    pub level_code: String,
    pub provider: MemberProviderRaw,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberProviderRaw {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub api_key: String,
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
    pub member: MemberLoginRaw,
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
            let need_sep = lines.last().map(|s| !s.trim().is_empty()).unwrap_or(false);
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

// ── .env 原子写（tmp→fsync→rename；unix 权限 0600）──

pub fn write_env_atomic(path: &Path, content: &str) -> Result<(), AuthError> {
    let parent = path.parent().ok_or_else(|| AuthError::EnvWrite {
        message: "no parent dir".into(),
    })?;
    fs::create_dir_all(parent).map_err(|e| AuthError::EnvWrite {
        message: format!("mkdir {:?}: {e}", parent),
    })?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "env".into());
    let tmp = parent.join(format!(".{file_name}.tmp"));

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| AuthError::EnvWrite {
                message: format!("open tmp: {e}"),
            })?;
        f.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| AuthError::EnvWrite {
                message: format!("chmod tmp: {e}"),
            })?;
        f.write_all(content.as_bytes())
            .map_err(|e| AuthError::EnvWrite {
                message: format!("write tmp: {e}"),
            })?;
        f.sync_all().map_err(|e| AuthError::EnvWrite {
            message: format!("fsync tmp: {e}"),
        })?;
    }
    #[cfg(not(unix))]
    {
        fs::write(&tmp, content).map_err(|e| AuthError::EnvWrite {
            message: format!("write tmp: {e}"),
        })?;
    }

    fs::rename(&tmp, path).map_err(|e| AuthError::EnvWrite {
        message: format!("rename tmp: {e}"),
    })?;
    Ok(())
}

/// 把登录 session 与 member provider 写进 layout.user_env，其余 key 不动。
pub fn write_env_token_section(layout: &Layout, sess: &UserSession) -> Result<(), AuthError> {
    let model = sess
        .member
        .models
        .first()
        .ok_or_else(|| AuthError::EnvWrite {
            message: "member models 为空".into(),
        })?;
    if sess.member.provider.base_url.trim().is_empty()
        || sess.member.provider.api_key.trim().is_empty()
        || model.trim().is_empty()
    {
        return Err(AuthError::EnvWrite {
            message: "member provider baseURL、apiKey 和首个 model 均不能为空".into(),
        });
    }
    let path = &layout.user_env;
    let content = fs::read_to_string(path).unwrap_or_default();
    let updates = vec![
        (ENV_KEY_PROVIDER.to_string(), "openai".to_string()),
        (ENV_KEY_MODEL.to_string(), model.clone()),
        (
            ENV_KEY_BASE_URL.to_string(),
            sess.member.provider.base_url.clone(),
        ),
        (
            ENV_KEY_API_KEY.to_string(),
            sess.member.provider.api_key.clone(),
        ),
        (ENV_KEY_ACCESS.to_string(), sess.token.clone()),
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

/// 清掉登录写入 .env 的 key（置空，复用 rewrite_env_keys）；其余 key 不动。
/// token 为空后 read_env_token_section 返回 None，等价于未登录。
pub fn clear_env_token_section(layout: &Layout) -> Result<(), AuthError> {
    let path = &layout.user_env;
    let content = fs::read_to_string(path).unwrap_or_default();
    let keys = [
        ENV_KEY_PROVIDER,
        ENV_KEY_MODEL,
        ENV_KEY_BASE_URL,
        ENV_KEY_API_KEY,
        ENV_KEY_ACCESS,
        ENV_KEY_REFRESH,
        ENV_KEY_EXPIRE,
        ENV_KEY_REFRESH_EXPIRE,
    ];
    let updates: Vec<(String, String)> = keys
        .iter()
        .map(|k| (k.to_string(), String::new()))
        .collect();
    let new_content = rewrite_env_keys(&content, &updates);
    write_env_atomic(path, &new_content)
}

/// 从 layout.user_env 读回 session（重启恢复用）。userInfo 读不到，留 None。
pub fn read_env_token_section(layout: &Layout) -> Option<UserSession> {
    let content = fs::read_to_string(&layout.user_env).ok()?;
    let map = parse_env_to_map(&content);
    let provider_api_key = map.get(ENV_KEY_API_KEY)?.trim();
    let access_token = map.get(ENV_KEY_ACCESS)?.trim();
    if provider_api_key.is_empty() || access_token.is_empty() {
        return None;
    }
    let refresh_token = map.get(ENV_KEY_REFRESH)?.trim().to_string();
    let expire_at = map.get(ENV_KEY_EXPIRE)?.trim().parse::<i64>().ok()?;
    let refresh_expire_at = map
        .get(ENV_KEY_REFRESH_EXPIRE)?
        .trim()
        .parse::<i64>()
        .ok()?;
    Some(UserSession {
        token: access_token.to_string(),
        refresh_token,
        expire_at,
        refresh_expire_at,
        user_info: None,
        member: MemberLoginRaw {
            level_code: String::new(),
            provider: MemberProviderRaw {
                base_url: map.get(ENV_KEY_BASE_URL)?.clone(),
                api_key: provider_api_key.to_string(),
            },
            models: vec![map.get(ENV_KEY_MODEL)?.clone()],
        },
    })
}

// ── cool-admin 响应解析 ──
/// cool-admin 统一包装 {code, data, message}，code==1000 成功。
#[derive(Debug, serde::Deserialize)]
struct CoolResponse {
    pub code: i64,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    #[serde(default)]
    pub message: Option<String>,
}

/// 把 cool-admin 响应体解析为 data；code!=1000 或解析失败转 AuthError。
pub fn parse_cool_response<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, AuthError> {
    let resp: CoolResponse = serde_json::from_str(text).map_err(|e| AuthError::Network {
        message: format!("解析响应失败: {e}"),
    })?;
    if resp.code != 1000 {
        return Err(AuthError::Api {
            code: resp.code,
            message: resp
                .message
                .unwrap_or_else(|| format!("code={}", resp.code)),
        });
    }
    let data = resp.data.ok_or_else(|| AuthError::Network {
        message: "响应缺 data 字段".into(),
    })?;
    serde_json::from_value(data).map_err(|e| AuthError::Network {
        message: format!("解析 data 字段失败: {e}"),
    })
}

// ── cool-admin 客户端（同步 reqwest::blocking）──
// 端点与 frontend/src/lib/apiUser.ts 完全对齐；Authorization 裸 token（无 Bearer）。

const HTTP_TIMEOUT_SECS: u64 = 30;

fn http_client() -> Result<reqwest::blocking::Client, AuthError> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| AuthError::Network {
            message: format!("build client: {e}"),
        })
}

fn endpoint(path: &str) -> String {
    format!("{}{}", user_api_url(), path)
}

pub fn fetch_captcha() -> Result<Captcha, AuthError> {
    let url = endpoint("/app/user/login/captcha?width=120&height=40");
    let text = http_client()?
        .get(&url)
        .send()
        .map_err(|e| AuthError::Network {
            message: format!("captcha: {e}"),
        })?
        .text()
        .map_err(|e| AuthError::Network {
            message: format!("captcha body: {e}"),
        })?;
    parse_cool_response(&text)
}

pub fn send_sms(phone: &str, captcha_id: &str, code: &str) -> Result<(), AuthError> {
    let url = endpoint("/app/user/login/smsCode");
    let body = serde_json::json!({ "phone": phone, "captchaId": captcha_id, "code": code });
    let text = http_client()?
        .post(&url)
        .json(&body)
        .send()
        .map_err(|e| AuthError::Network {
            message: format!("sms: {e}"),
        })?
        .text()
        .map_err(|e| AuthError::Network {
            message: format!("sms body: {e}"),
        })?;
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
        member: raw.member,
    }
}

fn post_login(path: &str, body: serde_json::Value) -> Result<LoginRaw, AuthError> {
    let text = http_client()?
        .post(endpoint(path))
        .json(&body)
        .send()
        .map_err(|e| AuthError::Network {
            message: format!("login: {e}"),
        })?
        .text()
        .map_err(|e| AuthError::Network {
            message: format!("login body: {e}"),
        })?;
    parse_cool_response(&text)
}

pub fn login_by_phone(phone: &str, sms_code: &str) -> Result<LoginRaw, AuthError> {
    post_login(
        "/app/user/login/phone",
        serde_json::json!({ "phone": phone, "smsCode": sms_code }),
    )
}

pub fn login_by_password(phone: &str, password: &str) -> Result<LoginRaw, AuthError> {
    post_login(
        "/app/user/login/password",
        serde_json::json!({ "phone": phone, "password": password }),
    )
}

pub fn register(phone: &str, sms_code: &str, password: &str) -> Result<LoginRaw, AuthError> {
    post_login(
        "/app/user/login/register",
        serde_json::json!({ "phone": phone, "smsCode": sms_code, "password": password }),
    )
}

pub fn refresh_token(rt: &str) -> Result<LoginRaw, AuthError> {
    post_login(
        "/app/user/login/refreshToken",
        serde_json::json!({ "refreshToken": rt }),
    )
}

pub fn set_password(token: &str, password: &str) -> Result<(), AuthError> {
    let url = endpoint("/app/user/info/setPassword");
    let body = serde_json::json!({ "password": password });
    let text = http_client()?
        .post(&url)
        .header("Authorization", token)
        .json(&body)
        .send()
        .map_err(|e| AuthError::Network {
            message: format!("set pwd: {e}"),
        })?
        .text()
        .map_err(|e| AuthError::Network {
            message: format!("set pwd body: {e}"),
        })?;
    parse_cool_response::<serde_json::Value>(&text).map(|_| ())
}

pub fn fetch_user_info(token: &str) -> Result<UserInfo, AuthError> {
    let url = endpoint("/app/user/info/person");
    let text = http_client()?
        .get(&url)
        .header("Authorization", token)
        .send()
        .map_err(|e| AuthError::Network {
            message: format!("userinfo: {e}"),
        })?
        .text()
        .map_err(|e| AuthError::Network {
            message: format!("userinfo body: {e}"),
        })?;
    parse_cool_response(&text)
}

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
pub fn ensure_session_valid(state: &AuthState, layout: &Layout) -> Result<UserSession, AuthError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_member() -> MemberLoginRaw {
        MemberLoginRaw {
            level_code: "normal".into(),
            provider: MemberProviderRaw {
                base_url: "https://api.example/v1".into(),
                api_key: "member-key".into(),
            },
            models: vec!["model-a".into()],
        }
    }

    #[test]
    fn parse_member_login_and_persist_its_provider() {
        let raw: LoginRaw = parse_cool_response(r#"{"code":1000,"data":{"token":"t","refreshToken":"r","expire":1,"refreshExpire":2,"hasPassword":true,"member":{"levelCode":"normal","provider":{"baseURL":"https://api.example/v1","apiKey":"member-key"},"models":["model-a"]}}}"#).unwrap();
        assert_eq!(raw.member.level_code, "normal");
        assert_eq!(raw.member.provider.base_url, "https://api.example/v1");
        assert_eq!(raw.member.provider.api_key, "member-key");
        assert_eq!(raw.member.models, vec!["model-a"]);

        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(&tmp.path().join(".vibe-trading"));
        let sess = session_from_login(raw, None);
        write_env_token_section(&layout, &sess).unwrap();
        let env = parse_env_to_map(&fs::read_to_string(&layout.user_env).unwrap());
        assert_eq!(
            env.get(ENV_KEY_BASE_URL).map(String::as_str),
            Some("https://api.example/v1")
        );
        assert_eq!(
            env.get(ENV_KEY_API_KEY).map(String::as_str),
            Some("member-key")
        );
        assert_eq!(env.get(ENV_KEY_MODEL).map(String::as_str), Some("model-a"));
    }

    #[test]
    fn invalid_member_provider_does_not_mutate_env() {
        for member in [
            MemberLoginRaw {
                provider: MemberProviderRaw {
                    base_url: " ".into(),
                    api_key: "key".into(),
                },
                ..sample_member()
            },
            MemberLoginRaw {
                provider: MemberProviderRaw {
                    base_url: "https://api.example/v1".into(),
                    api_key: " ".into(),
                },
                ..sample_member()
            },
            MemberLoginRaw {
                models: vec![" ".into()],
                ..sample_member()
            },
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let home = tmp.path().join(".vibe-trading");
            fs::create_dir_all(&home).unwrap();
            let layout = Layout::new(&home);
            fs::write(&layout.user_env, "KEEP=unchanged\n").unwrap();
            let raw = LoginRaw {
                token: "t".into(),
                refresh_token: "r".into(),
                expire: 1,
                refresh_expire: 2,
                has_password: true,
                member,
            };
            let err = write_env_token_section(&layout, &session_from_login(raw, None)).unwrap_err();
            assert!(matches!(err, AuthError::EnvWrite { .. }));
            assert_eq!(
                fs::read_to_string(&layout.user_env).unwrap(),
                "KEEP=unchanged\n"
            );
        }
    }

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
        assert!(out.contains("OPENAI_API_KEY=tok")); // 新行追加
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
    fn user_api_url_defaults_to_local_server() {
        std::env::remove_var("VIBE_USER_API_URL");
        assert_eq!(user_api_url(), "http://127.0.0.1:8001");
    }

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

    #[cfg(unix)]
    #[test]
    fn write_env_atomic_forces_0600_when_temp_file_already_exists() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(".env");
        let stale_tmp = tmp.path().join("..env.tmp");
        fs::write(&stale_tmp, "stale").unwrap();
        fs::set_permissions(&stale_tmp, fs::Permissions::from_mode(0o644)).unwrap();

        write_env_atomic(&path, "SECRET=value\n").unwrap();

        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn write_token_section_preserves_other_keys() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        fs::create_dir_all(&home).unwrap();
        let layout = Layout::new(&home);
        // 预置其他 provider 配置
        fs::write(
            &layout.user_env,
            "OPENROUTER_API_KEY=xxx\nTUSHARE_TOKEN=t\n",
        )
        .unwrap();

        let sess = UserSession {
            token: "tok".into(),
            refresh_token: "rt".into(),
            expire_at: 1700000000,
            refresh_expire_at: 1700000100,
            user_info: None,
            member: sample_member(),
        };
        write_env_token_section(&layout, &sess).unwrap();

        let after = fs::read_to_string(&layout.user_env).unwrap();
        assert!(
            after.contains("OPENROUTER_API_KEY=xxx"),
            "其他 provider 须保留"
        );
        assert!(after.contains("TUSHARE_TOKEN=t"));
        assert!(after.contains("OPENAI_API_KEY=member-key"));
        assert!(after.contains("OPENAI_BASE_URL=https://api.example/v1"));
        assert!(after.contains("LANGCHAIN_MODEL_NAME=model-a"));
        assert!(after.contains("USER_REFRESH_TOKEN=rt"));
        assert!(after.contains("USER_TOKEN_EXPIRE=1700000000"));
    }

    #[test]
    fn clear_token_section_wipes_login_keys_but_keeps_others() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join(".vibe-trading");
        fs::create_dir_all(&home).unwrap();
        let layout = Layout::new(&home);
        fs::write(
            &layout.user_env,
            "OPENROUTER_API_KEY=xxx\nTUSHARE_TOKEN=t\n",
        )
        .unwrap();
        let sess = UserSession {
            token: "tok".into(),
            refresh_token: "rt".into(),
            expire_at: 1700000000,
            refresh_expire_at: 1700000100,
            user_info: None,
            member: sample_member(),
        };
        write_env_token_section(&layout, &sess).unwrap();
        clear_env_token_section(&layout).unwrap();

        let after = fs::read_to_string(&layout.user_env).unwrap();
        assert!(!after.contains("tok"), "token 不得残留");
        assert!(!after.contains("USER_REFRESH_TOKEN=rt"));
        assert!(
            after.contains("OPENROUTER_API_KEY=xxx"),
            "其他 provider 须保留"
        );
        assert!(after.contains("TUSHARE_TOKEN=t"));
        assert!(
            read_env_token_section(&layout).is_none(),
            "清理后读不到 session"
        );
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
            member: sample_member(),
        };
        write_env_token_section(&layout, &sess).unwrap();

        let got = read_env_token_section(&layout).expect("应读到 session");
        assert_eq!(got.token, "tok");
        assert_eq!(got.member.provider.api_key, "member-key");
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

    // ── decide_session_action + ensure_session_valid 测试 ──

    fn sample_session(expire_at: i64, refresh_expire_at: i64) -> UserSession {
        UserSession {
            token: "t".into(),
            refresh_token: "r".into(),
            expire_at,
            refresh_expire_at,
            user_info: None,
            member: sample_member(),
        }
    }

    #[test]
    fn decide_action_valid_before_expire() {
        let sess = sample_session(1000, 2000);
        assert!(matches!(
            decide_session_action(999, &sess),
            SessionAction::Valid
        ));
        assert!(matches!(
            decide_session_action(0, &sess),
            SessionAction::Valid
        ));
    }

    #[test]
    fn decide_action_needs_refresh_between_expire_and_refresh_expire() {
        let sess = sample_session(1000, 2000);
        assert!(matches!(
            decide_session_action(1000, &sess),
            SessionAction::NeedsRefresh
        ));
        assert!(matches!(
            decide_session_action(1999, &sess),
            SessionAction::NeedsRefresh
        ));
    }

    #[test]
    fn decide_action_expired_after_refresh_expire() {
        let sess = sample_session(1000, 2000);
        assert!(matches!(
            decide_session_action(2000, &sess),
            SessionAction::Expired
        ));
        assert!(matches!(
            decide_session_action(5000, &sess),
            SessionAction::Expired
        ));
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
}
