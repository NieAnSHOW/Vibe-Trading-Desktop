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
struct CoolResponse {
    pub code: i64,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    #[serde(default)]
    pub message: Option<String>,
}

/// 把 cool-admin 响应体解析为 data；code!=1000 或解析失败转 AuthError。
pub fn parse_cool_response<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, AuthError> {
    let resp: CoolResponse = serde_json::from_str(text).map_err(|e| {
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
    let data = resp.data.ok_or_else(|| AuthError::Network {
        message: "响应缺 data 字段".into(),
    })?;
    serde_json::from_value(data).map_err(|e| AuthError::Network {
        message: format!("解析 data 字段失败: {e}"),
    })
}

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
}
