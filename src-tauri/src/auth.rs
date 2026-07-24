//! 桌面 console 用户登录：cool-admin 客户端 + ~/.vibe-trading/.env token 段读写。
//! 设计见 docs/superpowers/specs/2026-07-05-desktop-console-login-env-design.md
//! 全部同步 + reqwest::blocking，与 console.rs 现有命令风格一致。

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::Engine;
use hkdf::Hkdf;
use rand_core::OsRng;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::runtime_dir::Layout;

// ── 可覆盖配置 ──
// 业务接口（captcha/sms/login/person...），独立于大模型 MaaS 接口。
// 默认值与 frontend/src/pages/auth/Login.tsx 对齐。 https://trading-server.nieanshow.cn
pub fn user_api_url() -> String {
    std::env::var("VIBE_USER_API_URL").unwrap_or_else(|_| "http://127.0.0.1:8001".into())
}
// ── .env 中由本模块管辖的 key（其余 key 不动）──
pub const ENV_KEY_ACCESS: &str = "USER_ACCESS_TOKEN";
pub const ENV_KEY_REFRESH: &str = "USER_REFRESH_TOKEN";
pub const ENV_KEY_EXPIRE: &str = "USER_TOKEN_EXPIRE";
pub const ENV_KEY_REFRESH_EXPIRE: &str = "USER_REFRESH_EXPIRE";
pub const ENV_KEY_LLM_MODE: &str = "DESKTOP_LLM_MODE";

const MEMBER_CREDENTIAL_INFO: &[u8] = b"vibe-trading/member-credential/v1";
const X25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
];

// ── 错误类型：serde 序列化后由 Tauri 透传给 Vue，按 variant 分流 ──
#[derive(Debug, serde::Serialize)]
#[serde(tag = "variant")]
pub enum AuthError {
    Network { message: String },
    Api { code: i64, message: String },
    LoginExpired,
    EnvWrite { message: String },
    NotAuthenticated,
    Credential { message: String },
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network { message } => write!(f, "网络错误: {message}"),
            Self::Api { code, message } => write!(f, "API 错误({code}): {message}"),
            Self::LoginExpired => write!(f, "登录已过期"),
            Self::EnvWrite { message } => write!(f, "写入 .env 失败: {message}"),
            Self::NotAuthenticated => write!(f, "未登录"),
            Self::Credential { message } => write!(f, "会员凭据错误: {message}"),
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
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VipRuntimeCredential {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedMemberEnvelope {
    pub version: u8,
    pub server_public_key: String,
    pub salt: String,
    pub iv: String,
    pub ciphertext: String,
    pub tag: String,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Captcha {
    pub captcha_id: String,
    pub data: String,
}

/// 内存缓存的完整 session（不序列化给前端；vip 和 user_info 都不落盘）。
#[derive(Debug, Clone)]
pub struct UserSession {
    pub token: String,
    pub refresh_token: String,
    pub expire_at: i64,         // 绝对 epoch 秒
    pub refresh_expire_at: i64, // 绝对 epoch 秒
    pub user_info: Option<UserInfo>,
    pub vip: Option<VipRuntimeCredential>,
}

#[derive(Clone)]
pub struct AuthState(pub Arc<Mutex<Option<UserSession>>>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopLlmMode {
    Vip,
    Custom,
}

impl DesktopLlmMode {
    fn as_env_value(self) -> &'static str {
        match self {
            Self::Vip => "vip",
            Self::Custom => "custom",
        }
    }
}

fn normalize_llm_mode(value: Option<&str>) -> DesktopLlmMode {
    match value.map(str::trim) {
        Some("custom") => DesktopLlmMode::Custom,
        Some("vip") | None | Some(_) => DesktopLlmMode::Vip,
    }
}

pub fn read_llm_mode(layout: &Layout) -> DesktopLlmMode {
    let content = fs::read_to_string(&layout.user_env).unwrap_or_default();
    let values = parse_env_to_map(&content);
    normalize_llm_mode(values.get(ENV_KEY_LLM_MODE).map(String::as_str))
}

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

/// 把登录 token 和规范化的 LLM 模式写进 layout.user_env，其余 key 不动。
pub fn write_env_token_section(layout: &Layout, sess: &UserSession) -> Result<(), AuthError> {
    let path = &layout.user_env;
    let content = fs::read_to_string(path).unwrap_or_default();
    let values = parse_env_to_map(&content);
    let mode = normalize_llm_mode(values.get(ENV_KEY_LLM_MODE).map(String::as_str));
    let updates = vec![
        (ENV_KEY_ACCESS.to_string(), sess.token.clone()),
        (ENV_KEY_REFRESH.to_string(), sess.refresh_token.clone()),
        (ENV_KEY_EXPIRE.to_string(), sess.expire_at.to_string()),
        (
            ENV_KEY_REFRESH_EXPIRE.to_string(),
            sess.refresh_expire_at.to_string(),
        ),
        (
            ENV_KEY_LLM_MODE.to_string(),
            mode.as_env_value().to_string(),
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
    let values = parse_env_to_map(&content);
    let keys = [
        ENV_KEY_ACCESS,
        ENV_KEY_REFRESH,
        ENV_KEY_EXPIRE,
        ENV_KEY_REFRESH_EXPIRE,
    ];
    let updates: Vec<(String, String)> = keys
        .iter()
        .map(|k| (k.to_string(), String::new()))
        .collect();
    let mut updates = updates;
    updates.push((
        ENV_KEY_LLM_MODE.to_string(),
        normalize_llm_mode(values.get(ENV_KEY_LLM_MODE).map(String::as_str))
            .as_env_value()
            .to_string(),
    ));
    let new_content = rewrite_env_keys(&content, &updates);
    write_env_atomic(path, &new_content)
}

/// 从 layout.user_env 读回 session（重启恢复用）。机密 VIP 凭据绝不从磁盘读取。
pub fn read_env_token_section(layout: &Layout) -> Option<UserSession> {
    let content = fs::read_to_string(&layout.user_env).ok()?;
    let map = parse_env_to_map(&content);
    let access_token = map.get(ENV_KEY_ACCESS)?.trim();
    if access_token.is_empty() {
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
        vip: None,
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

/// cool-admin 成功响应：保留 data 和服务端的用户可见消息。
pub struct CoolSuccess<T> {
    pub data: T,
    pub message: String,
}

/// 把 cool-admin 响应体解析为 data 和 message；code!=1000 或解析失败转 AuthError。
pub fn parse_cool_response_with_message<T: serde::de::DeserializeOwned>(
    text: &str,
) -> Result<CoolSuccess<T>, AuthError> {
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
    let data =
        serde_json::from_value(resp.data.unwrap_or(serde_json::Value::Null)).map_err(|e| {
            AuthError::Network {
                message: format!("解析 data 字段失败: {e}"),
            }
        })?;
    Ok(CoolSuccess {
        data,
        message: resp.message.unwrap_or_default(),
    })
}

/// 仅需要业务数据的调用保持原有接口；需要显示服务端消息时使用上面的解析器。
pub fn parse_cool_response<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, AuthError> {
    parse_cool_response_with_message(text).map(|response| response.data)
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

fn credential_error(message: impl Into<String>) -> AuthError {
    AuthError::Credential {
        message: message.into(),
    }
}

pub fn public_key_base64(private_key: &StaticSecret) -> String {
    let public_key = PublicKey::from(private_key);
    let mut der = X25519_SPKI_PREFIX.to_vec();
    der.extend_from_slice(public_key.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(der)
}

fn decode_server_public_key(value: &str) -> Result<PublicKey, AuthError> {
    let der = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| credential_error("serverPublicKey 不是有效 Base64"))?;
    if der.len() != X25519_SPKI_PREFIX.len() + 32 || !der.starts_with(&X25519_SPKI_PREFIX) {
        return Err(credential_error(
            "serverPublicKey 不是 X25519 DER-SPKI 密钥",
        ));
    }
    let bytes: [u8; 32] = der[X25519_SPKI_PREFIX.len()..]
        .try_into()
        .map_err(|_| credential_error("serverPublicKey 长度无效"))?;
    Ok(PublicKey::from(bytes))
}

fn decode_member_field(value: &str, name: &str) -> Result<Vec<u8>, AuthError> {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| credential_error(format!("{name} 不是有效 Base64")))
}

pub fn decrypt_member_envelope(
    client_private_key: &StaticSecret,
    envelope: &EncryptedMemberEnvelope,
) -> Result<VipRuntimeCredential, AuthError> {
    if envelope.version != 1 {
        return Err(credential_error("不支持的凭据版本"));
    }
    let server_public_key = decode_server_public_key(&envelope.server_public_key)?;
    let salt = decode_member_field(&envelope.salt, "salt")?;
    let iv = decode_member_field(&envelope.iv, "iv")?;
    let mut ciphertext = decode_member_field(&envelope.ciphertext, "ciphertext")?;
    let tag = decode_member_field(&envelope.tag, "tag")?;
    if salt.len() != 32 || iv.len() != 12 || tag.len() != 16 {
        return Err(credential_error("凭据加密字段长度无效"));
    }

    let shared_secret = client_private_key.diffie_hellman(&server_public_key);
    let mut key = [0_u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared_secret.as_bytes())
        .expand(MEMBER_CREDENTIAL_INFO, &mut key)
        .map_err(|_| credential_error("凭据密钥派生失败"))?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| credential_error("凭据密钥无效"))?;
    cipher
        .decrypt_in_place_detached(
            Nonce::from_slice(&iv),
            b"",
            &mut ciphertext,
            Tag::from_slice(&tag),
        )
        .map_err(|_| credential_error("凭据认证失败"))?;
    let credential: VipRuntimeCredential =
        serde_json::from_slice(&ciphertext).map_err(|_| credential_error("凭据内容无效"))?;
    if credential.base_url.trim().is_empty()
        || credential.api_key.trim().is_empty()
        || credential.models.is_empty()
        || credential
            .models
            .iter()
            .any(|model| model.trim().is_empty())
    {
        return Err(credential_error("凭据内容不完整"));
    }
    Ok(credential)
}

pub fn fetch_vip_credential(token: &str) -> Result<VipRuntimeCredential, AuthError> {
    let client_private_key = StaticSecret::random_from_rng(OsRng);
    let text = http_client()?
        .post(endpoint("/app/ai/member/credentials"))
        .header("Authorization", token)
        .json(&serde_json::json!({
            "clientPublicKey": public_key_base64(&client_private_key),
        }))
        .send()
        .map_err(|e| AuthError::Network {
            message: format!("member credentials: {e}"),
        })?
        .text()
        .map_err(|e| AuthError::Network {
            message: format!("member credentials body: {e}"),
        })?;
    let envelope: EncryptedMemberEnvelope = parse_cool_response(&text)?;
    decrypt_member_envelope(&client_private_key, &envelope)
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

pub fn send_sms(phone: &str, captcha_id: &str, code: &str) -> Result<String, AuthError> {
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
    parse_cool_response_with_message::<serde_json::Value>(&text).map(|response| response.message)
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
        vip: None,
    }
}

/// refresh 后的 token 必须重新获取会员凭据，不能复用旧 token 的内存缓存。
fn session_from_refresh(raw: LoginRaw, previous: &UserSession) -> UserSession {
    session_from_login(raw, previous.user_info.clone())
}

fn post_login(path: &str, body: serde_json::Value) -> Result<CoolSuccess<LoginRaw>, AuthError> {
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
    parse_cool_response_with_message(&text)
}

pub fn login_by_phone(phone: &str, sms_code: &str) -> Result<CoolSuccess<LoginRaw>, AuthError> {
    post_login(
        "/app/user/login/phone",
        serde_json::json!({ "phone": phone, "smsCode": sms_code }),
    )
}

pub fn login_by_password(phone: &str, password: &str) -> Result<CoolSuccess<LoginRaw>, AuthError> {
    post_login(
        "/app/user/login/password",
        serde_json::json!({ "phone": phone, "password": password }),
    )
}

pub fn register(
    phone: &str,
    sms_code: &str,
    password: &str,
) -> Result<CoolSuccess<LoginRaw>, AuthError> {
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
    .map(|response| response.data)
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
            let mut new_sess = session_from_refresh(raw, &sess);
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

/// 获取内存中已解密的会员凭据；进程重启后按需重新获取，但绝不写进 .env。
pub fn ensure_vip_credential(state: &AuthState, layout: &Layout) -> Result<UserSession, AuthError> {
    let mut sess = ensure_session_valid(state, layout)?;
    if sess.vip.is_none() {
        sess.vip = Some(fetch_vip_credential(&sess.token)?);
    }
    *state.0.lock().unwrap() = Some(sess.clone());
    Ok(sess)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client_keypair() -> (x25519_dalek::StaticSecret, x25519_dalek::PublicKey) {
        let private_key = x25519_dalek::StaticSecret::from([7_u8; 32]);
        let public_key = x25519_dalek::PublicKey::from(&private_key);
        (private_key, public_key)
    }

    fn der_spki_base64(public_key: &x25519_dalek::PublicKey) -> String {
        use base64::Engine;

        const X25519_SPKI_PREFIX: [u8; 12] = [
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
        ];
        let mut der = X25519_SPKI_PREFIX.to_vec();
        der.extend_from_slice(public_key.as_bytes());
        base64::engine::general_purpose::STANDARD.encode(der)
    }

    fn encrypted_fixture_for(
        client_public_key: &x25519_dalek::PublicKey,
    ) -> EncryptedMemberEnvelope {
        use aes_gcm::aead::{AeadInPlace, KeyInit};
        use aes_gcm::Aes256Gcm;
        use base64::Engine;
        use hkdf::Hkdf;
        use sha2::Sha256;

        let server_private_key = x25519_dalek::StaticSecret::from([8_u8; 32]);
        let server_public_key = x25519_dalek::PublicKey::from(&server_private_key);
        let shared_secret = server_private_key.diffie_hellman(client_public_key);
        let salt = [9_u8; 32];
        let iv = [10_u8; 12];
        let mut key = [0_u8; 32];
        Hkdf::<Sha256>::new(Some(&salt), shared_secret.as_bytes())
            .expand(b"vibe-trading/member-credential/v1", &mut key)
            .unwrap();
        let mut plaintext =
            br#"{"baseURL":"https://api.example/v1","apiKey":"member-key","models":["model-a"]}"#
                .to_vec();
        let tag = Aes256Gcm::new_from_slice(&key)
            .unwrap()
            .encrypt_in_place_detached((&iv).into(), b"", &mut plaintext)
            .unwrap();
        EncryptedMemberEnvelope {
            version: 1,
            server_public_key: der_spki_base64(&server_public_key),
            salt: base64::engine::general_purpose::STANDARD.encode(salt),
            iv: base64::engine::general_purpose::STANDARD.encode(iv),
            ciphertext: base64::engine::general_purpose::STANDARD.encode(plaintext),
            tag: base64::engine::general_purpose::STANDARD.encode(tag),
        }
    }

    #[test]
    fn decrypt_member_envelope_decodes_server_format_fixture() {
        let (client_private_key, client_public_key) = client_keypair();
        let credential = decrypt_member_envelope(
            &client_private_key,
            &encrypted_fixture_for(&client_public_key),
        )
        .unwrap();
        assert_eq!(credential.base_url, "https://api.example/v1");
        assert_eq!(credential.api_key, "member-key");
        assert_eq!(credential.models, vec!["model-a"]);
    }

    #[test]
    fn decrypt_member_envelope_rejects_modified_ciphertext() {
        let (client_private_key, client_public_key) = client_keypair();
        let mut envelope = encrypted_fixture_for(&client_public_key);
        envelope.ciphertext.push('A');
        assert!(decrypt_member_envelope(&client_private_key, &envelope).is_err());
    }

    #[test]
    fn token_env_persistence_excludes_vip_credentials() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(&tmp.path().join(".vibe-trading"));
        let session = UserSession {
            token: "token".into(),
            refresh_token: "refresh".into(),
            expire_at: 1_700_000_000,
            refresh_expire_at: 1_700_000_100,
            user_info: None,
            vip: None,
        };
        write_env_token_section(&layout, &session).unwrap();
        let text = fs::read_to_string(&layout.user_env).unwrap();
        assert!(!text.contains("VIP_API_KEY"));
        assert!(!text.contains("VIP_BASE_URL"));
        assert!(!text.contains("member-key"));
        assert!(!text.contains("https://api.example/v1"));
    }

    #[test]
    fn login_and_logout_preserve_legacy_openai_configuration_without_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(&tmp.path().join(".vibe-trading"));
        fs::create_dir_all(&layout.root).unwrap();
        fs::write(
            &layout.user_env,
            "LANGCHAIN_PROVIDER=openai\nLANGCHAIN_MODEL_NAME=model-a\nOPENAI_BASE_URL=https://api.example/v1\nOPENAI_API_KEY=member-key\nUSER_ACCESS_TOKEN=legacy-token\nCUSTOM_KEEP=1\n",
        )
        .unwrap();
        let session = UserSession {
            token: "token".into(),
            refresh_token: "refresh".into(),
            expire_at: 1_700_000_000,
            refresh_expire_at: 1_700_000_100,
            user_info: None,
            vip: None,
        };

        write_env_token_section(&layout, &session).unwrap();
        let after_login = fs::read_to_string(&layout.user_env).unwrap();
        assert!(after_login.contains("member-key"));
        assert!(after_login.contains("https://api.example/v1"));
        assert!(after_login.contains("LANGCHAIN_PROVIDER=openai"));
        assert!(after_login.contains("OPENAI_API_KEY=member-key"));
        assert!(after_login.contains("DESKTOP_LLM_MODE=vip"));
        assert!(after_login.contains("CUSTOM_KEEP=1"));

        clear_env_token_section(&layout).unwrap();
        let after_logout = fs::read_to_string(&layout.user_env).unwrap();
        assert!(after_logout.contains("member-key"));
        assert!(after_logout.contains("OPENAI_API_KEY=member-key"));
        assert!(after_logout.contains("CUSTOM_KEEP=1"));
    }

    #[test]
    fn token_updates_preserve_current_custom_provider_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(&tmp.path().join(".vibe-trading"));
        fs::create_dir_all(&layout.root).unwrap();
        fs::write(
            &layout.user_env,
            "DESKTOP_LLM_MODE=custom\nLANGCHAIN_PROVIDER=openai\nLANGCHAIN_MODEL_NAME=custom-model\nOPENAI_BASE_URL=https://custom.example/v1\nOPENAI_API_KEY=custom-key\n",
        )
        .unwrap();
        let session = UserSession {
            token: "token".into(),
            refresh_token: "refresh".into(),
            expire_at: 1_700_000_000,
            refresh_expire_at: 1_700_000_100,
            user_info: None,
            vip: None,
        };

        write_env_token_section(&layout, &session).unwrap();
        let after_login = fs::read_to_string(&layout.user_env).unwrap();
        assert!(after_login.contains("DESKTOP_LLM_MODE=custom"));
        assert!(after_login.contains("OPENAI_API_KEY=custom-key"));
        clear_env_token_section(&layout).unwrap();
        let text = fs::read_to_string(&layout.user_env).unwrap();
        assert!(text.contains("DESKTOP_LLM_MODE=custom"));
        assert!(text.contains("OPENAI_API_KEY=custom-key"));
        assert!(text.contains("OPENAI_BASE_URL=https://custom.example/v1"));
        assert!(text.contains("LANGCHAIN_MODEL_NAME=custom-model"));
    }

    #[test]
    fn token_write_normalizes_invalid_llm_mode_to_vip() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(&tmp.path().join(".vibe-trading"));
        fs::create_dir_all(&layout.root).unwrap();
        fs::write(&layout.user_env, "DESKTOP_LLM_MODE=unsupported\n").unwrap();
        let session = sample_session(1_700_000_000, 1_700_000_100);

        write_env_token_section(&layout, &session).unwrap();

        assert!(fs::read_to_string(&layout.user_env)
            .unwrap()
            .contains("DESKTOP_LLM_MODE=vip"));
    }

    #[test]
    fn read_llm_mode_allows_only_custom_or_vip() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(&tmp.path().join(".vibe-trading"));
        fs::create_dir_all(&layout.root).unwrap();

        fs::write(&layout.user_env, "DESKTOP_LLM_MODE=custom\n").unwrap();
        assert_eq!(read_llm_mode(&layout), DesktopLlmMode::Custom);

        fs::write(&layout.user_env, "DESKTOP_LLM_MODE=anything-else\n").unwrap();
        assert_eq!(read_llm_mode(&layout), DesktopLlmMode::Vip);
    }

    #[test]
    fn refreshed_session_drops_cached_vip_credential() {
        let previous = UserSession {
            token: "old-token".into(),
            refresh_token: "old-refresh".into(),
            expire_at: 0,
            refresh_expire_at: 1,
            user_info: Some(UserInfo {
                id: 1,
                unionid: None,
                avatar_url: None,
                nick_name: None,
                phone: None,
                gender: 0,
                status: 1,
                login_type: 0,
                description: None,
            }),
            vip: Some(VipRuntimeCredential {
                base_url: "https://old.example/v1".into(),
                api_key: "old-key".into(),
                models: vec!["old-model".into()],
            }),
        };
        let refreshed = session_from_refresh(
            LoginRaw {
                token: "new-token".into(),
                refresh_token: "new-refresh".into(),
                expire: 60,
                refresh_expire: 120,
                has_password: true,
            },
            &previous,
        );

        assert_eq!(refreshed.token, "new-token");
        assert_eq!(refreshed.user_info.as_ref().unwrap().id, 1);
        assert!(refreshed.vip.is_none());
    }

    #[test]
    fn login_payload_ignores_legacy_member_field_and_persists_only_tokens() {
        let raw: LoginRaw = parse_cool_response(r#"{"code":1000,"data":{"token":"t","refreshToken":"r","expire":1,"refreshExpire":2,"hasPassword":true,"member":{"levelCode":"normal","provider":{"baseURL":"https://api.example/v1","apiKey":"member-key"},"models":["model-a"]}}}"#).unwrap();
        assert_eq!(raw.token, "t");
        assert!(raw.has_password);

        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(&tmp.path().join(".vibe-trading"));
        let sess = session_from_login(raw, None);
        write_env_token_section(&layout, &sess).unwrap();
        let text = fs::read_to_string(&layout.user_env).unwrap();
        assert!(text.contains("USER_ACCESS_TOKEN=t"));
        assert!(text.contains("DESKTOP_LLM_MODE=vip"));
        assert!(!text.contains("member-key"));
        assert!(!text.contains("https://api.example/v1"));
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
            vip: None,
        };
        write_env_token_section(&layout, &sess).unwrap();

        let after = fs::read_to_string(&layout.user_env).unwrap();
        assert!(
            after.contains("OPENROUTER_API_KEY=xxx"),
            "其他 provider 须保留"
        );
        assert!(after.contains("TUSHARE_TOKEN=t"));
        assert!(!after.contains("member-key"));
        assert!(after.contains("DESKTOP_LLM_MODE=vip"));
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
            vip: None,
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
            vip: None,
        };
        write_env_token_section(&layout, &sess).unwrap();

        let got = read_env_token_section(&layout).expect("应读到 session");
        assert_eq!(got.token, "tok");
        assert!(got.vip.is_none(), "恢复时不能带 VIP 凭据");
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
    fn parse_cool_response_accepts_success_without_data() {
        let text = r#"{"code":1000,"message":"验证码已发送"}"#;
        let response = parse_cool_response_with_message::<()>(&text).unwrap();
        assert_eq!(response.message, "验证码已发送");
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
            vip: None,
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
        use std::sync::{Arc, Mutex};
        let state = AuthState(Arc::new(Mutex::new(None)));
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout::new(&tmp.path().join(".vibe-trading"));
        let err = ensure_session_valid(&state, &layout).unwrap_err();
        assert!(matches!(err, AuthError::NotAuthenticated));
    }
}
