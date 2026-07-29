# 低频会员凭据签发设计

**状态：已获方案确认，待实现前复核**

## 目标

恢复新注册用户、换设备和会员自动升级后的无感可用性，同时保留桌面端到供应商的直连。供应商 API Key 不得以明文保存于数据库、普通业务日志或 HTTP 响应中；模型请求不得经过本服务端转发。

本设计取代当前依赖管理员浏览器 KEK 和会员公钥密文的零知识分配链路。该链路无法在用户首次登录或公钥轮换时自动为设备生成新密文，因而会使已绑定但未人工分配的用户收到 `1001`。

## 结论与取舍

选择“低频服务端签发 + Vault Transit”方案。

- 不选择让管理员浏览器在每次注册、升级、换设备时重加密：需要人工介入，无法支持自动升级。
- 不选择网关代理所有供应商请求：会把推理流量、延迟和供应商故障集中到服务端。
- 接受签发服务在一小段受控内存中接触 Key 明文：拥有 Vault 解密权限且攻破签发服务的攻击者理论上可取得 Key。因此 Vault token 只授予签发服务，必须开启审计、限流和密钥轮换。

## 数据模型

`ai_key_pool` 以一个信封加密记录保存每个供应商 Key：

| 字段 | 含义 |
| --- | --- |
| `apiKeyCiphertext` | 随机 32-byte DEK 用 AES-256-GCM 加密 Key 后的密文包（包含 `version`、`iv`、`ciphertext`、`tag`）。 |
| `apiKeyWrappedDek` | 同一 DEK 经 Vault Transit 的指定 KEK 包装后的密文。 |
| `apiKeyKekRef` | Vault Transit 密钥名/版本引用，用于轮换和审计。 |
| `apiKeyFingerprint` | SHA-256(Key)，用于唯一性检查和不暴露明文的定位。 |

`apiKey`、`apiKeyCipherAdmin` 和 `apiKeyCipherMember` 是旧链路字段：新写入和新签发不得依赖它们。迁移完成并经过备份恢复演练后再删除旧列，不能和本次功能改造合并执行。

数据库只保存密文包和 Key 指纹，不能从数据库备份单独恢复供应商 Key。DEK 不写日志、不返回 API、不缓存到进程全局状态；在 Node 的限制下只能在函数作用域内尽快清零 Buffer，不能声称绝对内存擦除。

## Vault 集成

新增 `AiKeyEnvelopeService`，仅负责如下边界：

1. 写入：生成 DEK、加密 API Key、调用 Vault Transit `/v1/<mount>/encrypt/<key>` 包装 DEK，持久化三段信封字段。
2. 读取：调用 Transit decrypt 解开 DEK、认证解密 API Key，并在调用结束时清零二进制缓冲区。

使用现有 `axios` 调用 Vault HTTP API，不在应用配置中保存主密钥。运行配置从环境变量读取：`AI_VAULT_ADDR`、`AI_VAULT_TOKEN`、`AI_VAULT_TRANSIT_MOUNT`、`AI_VAULT_TRANSIT_KEY`；生产环境应通过运行平台的 secret 注入 token。配置缺失、Vault 非 2xx、响应格式异常或 AES-GCM 认证失败时，签发必须失败关闭，并只记录操作阶段、Key pool ID、用户 ID、trace ID，绝不记录 Key、DEK、密文包或 Vault token。

Vault policy 仅允许此应用身份调用所需 Transit key 的 `encrypt` 与 `decrypt`；启用 Vault audit device。部署时为签发端点限制用户频率和并发，并为异常签发量添加告警。

## 低频签发流程

```text
桌面端登录 / 换设备 / 会员等级变化
  -> 上报当前设备持久 X25519 公钥
  -> POST /app/ai/member/credentials
  -> 服务端验证登录、会员、等级和供应商
  -> Vault 解封 DEK，内存中解密 Key
  -> 用当前设备公钥生成 v2 密封包
  -> 返回 provider 元数据和 apiKeySeal 对象
  -> Tauri 解密到运行时内存
  -> Tauri 直连供应商
```

会员凭据不再持久保存为每设备 `apiKeyCipherMember`。每次请求 `/credentials` 都根据当前已经绑定的设备公钥重新生成 v2 密封包；这使公钥轮换和会员升级不需要管理员动作。它是低频控制面调用，绝非每次模型请求调用。

设备首次登录的顺序固定为：桌面端保证本地持久 X25519 密钥存在，提交 `clientPublicKey` 绑定，然后请求凭据。为避免旧客户端的两次请求竞态，`/credentials` 仍接受 `clientPublicKey`：服务端先规范化并原子更新会员公钥，再签发。单独的公钥绑定接口保留给预注册和诊断用途。

注册阶段仍可先分配普通等级和 Key；因为不再要求预先生成用户特有密文，首次成功登录即可按上述顺序获取凭据。升级/兑换码兑现只需在同一事务内替换用户的 `levelId`/`keyPoolId` 并释放旧 Key；下一次凭据获取自然签发新 Key。桌面端在登录完成、窗口恢复以及拿到认证失败的过期凭据时静默刷新，不能把正常的刷新过程展示为错误。

## 对外协议与客户端兼容

`POST /app/ai/member/credentials` 的成功响应统一为：

```json
{
  "version": 2,
  "baseURL": "https://provider.example/v1",
  "models": ["model-a"],
  "apiKeySeal": {
    "version": 2,
    "ephemeralPublicKey": "base64 DER-SPKI",
    "salt": "base64",
    "iv": "base64",
    "ciphertext": "base64",
    "tag": "base64"
  }
}
```

服务端不得把 `apiKeySeal` 再序列化成 JSON 字符串。Tauri 的解析器必须接受对象、校验内部版本为 `2`，并使用既有 X25519 + HKDF-SHA256 + AES-256-GCM 参数解密。旧 `version: 1` 明文兼容响应仅在已存在旧数据的过渡分支中保留，不能作为新写入或新签发路径。

`1001` 的含义调整为“签发材料缺失或迁移未完成”，仅适用于旧记录尚未迁入信封密文；Vault 不可用、公钥无效、凭据认证失败和会员过期使用可区分的失败代码。桌面端将可重试的签发失败记录为诊断事件，初次登录仅在最终重试失败后显示可操作的错误。

## 管理端改造

`cool-admin-vue/src/modules/ai/views/keyPool.vue` 的批量录入改为提交短暂明文 Key 到仅限管理员的 HTTPS 接口；服务端在请求内马上信封加密，客户端立即清空输入值。管理员 KEK 解锁、展示解密、存量会员密文迁移、手动按用户公钥重加密以及 C4 清理申请全部从主流程移除。

列表只显示固定脱敏值、指纹、供应商、状态、占用用户和时间，不返回任何密文列。管理员不提供“查看真实 Key”能力；需替换时录入新 Key 并完成会员换绑。

此变化扩大了服务端短暂接触明文的范围，必须由 HTTPS、管理员权限、请求体脱敏、禁用 request-body 日志及 Vault 审计共同约束。它仍满足本项目的核心要求：数据库不保存明文 Key。

## 迁移与回滚

1. 先部署 Vault Transit key、最小权限 token 和运行配置；用健康检查验证 Vault 不可用时签发失败关闭。
2. 增加信封字段和双读逻辑，保持旧字段只读兼容。
3. 管理端增加“迁移存量 Key 到 Vault 信封”的受控任务：它只能处理仍保留原始 `apiKey` 的记录；纯管理员 KEK 密文无法在服务端恢复，需在管理员解锁会话中一次性提交给专门迁移接口，服务端立即写入信封密文。
4. 迁移成功后，新注册、升级和换设备统一使用低频签发；不再写会员专属持久密文。
5. 监控 `1001`、Vault 失败、签发延迟和签发次数，确认无旧客户端依赖后再制定旧列删除迁移。

回滚只允许回到双读版本。不得把已迁移 Key 写回数据库明文；Vault 故障时保持失败关闭并保留供应商请求的直连，不降级为网关转发。

## 验证

- Midway 单元/集成测试：信封写入无明文、Vault 请求/响应错误失败关闭、注册后首次凭据签发、换公钥签发、升级换 Key、事务冲突、日志脱敏。
- 协议测试：服务端 v2 `apiKeySeal` 为对象，Tauri 接受并成功解密；字符串和错误版本被拒绝。
- 桌面端测试：登录后用量 IPC 可获取凭据并直连；凭据更新和可重试 Vault 故障不打扰用户；最终失败提供明确错误。
- 管理端测试：批量录入调用新信封接口、列表不保留/展示密文、输入提交后清空。
- 人工安全验证：数据库、API 响应和日志均不含测试 Key 明文；Vault 审计只出现 Transit 操作元数据。
