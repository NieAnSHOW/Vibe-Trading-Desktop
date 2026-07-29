# Low-Frequency VIP Credential Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store provider keys as Vault Transit envelope ciphertext and silently issue a current-device credential without proxying model traffic.

**Architecture:** The Midway service owns envelope encryption/decryption through a narrowly scoped Vault Transit client. It decrypts a key only while serving `/app/ai/member/credentials`, then wraps it with the current Tauri X25519 public key. The desktop process holds the resulting key only in memory and calls the provider directly.

**Tech Stack:** Midway 3, TypeORM, Node `crypto`, Axios, HashiCorp Vault Transit HTTP API, Vue 3, Vitest, Rust, Tauri v2, X25519, HKDF-SHA256, AES-256-GCM.

## Global Constraints

- Database rows, ordinary logs, and API responses must never contain provider Key plaintext.
- `AI_VAULT_ADDR`, `AI_VAULT_TOKEN`, `AI_VAULT_TRANSIT_MOUNT`, and `AI_VAULT_TRANSIT_KEY` are runtime secrets; never add them to repository configuration.
- Vault failure, malformed Transit output, missing envelope fields, and AES-GCM authentication failure must fail closed.
- The service must not proxy model inference requests; Tauri calls the provider URL directly.
- New write and credential paths must not depend on `apiKey`, `apiKeyCipherAdmin`, or `apiKeyCipherMember`.
- Preserve legacy columns only for dual-read migration; do not remove columns in this change.
- Tests must use a fake injected Transit port, never a real Vault server or a real provider Key.

---

### Task 1: Add the tested Vault Transit and envelope boundary

**Files:**
- Create: `/Users/niean/Documents/project/cool-admin-midway/src/modules/ai/service/keyEnvelope.ts`
- Test: `/Users/niean/Documents/project/cool-admin-midway/test/ai-key-envelope.test.ts`

**Interfaces:**
- Produces `AiKeyEnvelopeService.seal(apiKey: string): Promise<SealedKeyEnvelope>`.
- Produces `AiKeyEnvelopeService.open(envelope: KeyEnvelopeRecord): Promise<Buffer>`.
- `SealedKeyEnvelope` is `{ apiKeyCiphertext: string; apiKeyWrappedDek: string; apiKeyKekRef: string; apiKeyFingerprint: string }`.
- `KeyEnvelopeRecord` accepts the first three fields above.
- `VaultTransitPort.encrypt(plaintext: Buffer): Promise<string>` and `.decrypt(ciphertext: string): Promise<Buffer>` are injected into the envelope service so tests avoid network access.

- [ ] **Step 1: Write the failing envelope tests**

```ts
it('stores a Key only as ciphertext, wrapped DEK, KEK reference and fingerprint', async () => {
  const vault = new FakeVaultTransitPort();
  const service = new AiKeyEnvelopeService(vault);
  const sealed = await service.seal('provider-test-key');

  expect(sealed.apiKeyCiphertext).not.toContain('provider-test-key');
  expect(sealed.apiKeyWrappedDek).toBe('vault:v1:wrapped-dek');
  expect(sealed.apiKeyKekRef).toBe('transit/keys/ai-provider');
  expect(sealed.apiKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);
  await expect(service.open(sealed)).resolves.toEqual(Buffer.from('provider-test-key'));
});

it('fails closed when Transit returns an invalid DEK or ciphertext authentication fails', async () => {
  await expect(service.open({ ...sealed, apiKeyWrappedDek: 'broken' })).rejects.toThrow('Key信封解密失败');
  await expect(service.open({ ...sealed, apiKeyCiphertext: '{"version":1,"iv":"bad"}' })).rejects.toThrow('Key信封格式错误');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `cd /Users/niean/Documents/project/cool-admin-midway && npm test -- ai-key-envelope.test.ts --runInBand`

Expected: FAIL because `AiKeyEnvelopeService` and `FakeVaultTransitPort` do not exist.

- [ ] **Step 3: Implement the minimal Vault adapter and envelope service**

```ts
export type VaultTransitPort = {
  encrypt(plaintext: Buffer): Promise<string>;
  decrypt(ciphertext: string): Promise<Buffer>;
  keyReference(): string;
};

export class AiKeyEnvelopeService {
  constructor(private readonly vault: VaultTransitPort) {}

  async seal(apiKey: string): Promise<SealedKeyEnvelope> {
    const dek = randomBytes(32);
    const plaintext = Buffer.from(apiKey, 'utf8');
    try {
      return {
        apiKeyCiphertext: encryptAesGcm(dek, plaintext),
        apiKeyWrappedDek: await this.vault.encrypt(dek),
        apiKeyKekRef: this.vault.keyReference(),
        apiKeyFingerprint: createHash('sha256').update(plaintext).digest('hex')
      };
    } finally {
      dek.fill(0);
      plaintext.fill(0);
    }
  }
}
```

Implement `VaultTransitHttpClient` with Axios only after `AI_VAULT_*` values pass strict non-empty validation. It calls `/v1/${mount}/encrypt/${key}` and `/v1/${mount}/decrypt/${key}`, uses `X-Vault-Token`, base64 encodes request plaintext, validates only `data.data.ciphertext` / `data.data.plaintext`, and does not attach Axios error objects to logs or exceptions. The AES payload is JSON `{ version: 1, iv, ciphertext, tag }`; `open` validates exact IV/tag lengths and clears both DEK and plaintext buffers in `finally` after its caller has copied the required bytes.

- [ ] **Step 4: Run the envelope tests and type check**

Run: `cd /Users/niean/Documents/project/cool-admin-midway && npm test -- ai-key-envelope.test.ts --runInBand && npm run lint`

Expected: PASS; no test starts an HTTP server or contacts Vault.

- [ ] **Step 5: Commit the isolated envelope boundary**

```bash
git -C /Users/niean/Documents/project/cool-admin-midway add src/modules/ai/service/keyEnvelope.ts test/ai-key-envelope.test.ts
git -C /Users/niean/Documents/project/cool-admin-midway commit -m "feat(ai): add Vault key envelope service"
```

### Task 2: Persist Vault envelopes and accept server-side Key ingestion

**Files:**
- Modify: `/Users/niean/Documents/project/cool-admin-midway/src/modules/ai/entity/keyPool.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-midway/src/modules/ai/service/keyPool.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-midway/src/modules/ai/controller/admin/keyPool.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-midway/test/ai-member-credentials.test.ts`

**Interfaces:**
- Consumes `AiKeyEnvelopeService.seal` from Task 1.
- Changes `AiKeyPoolService.batchAdd(supplierId: number, keys: string[]): Promise<number>`.
- Adds `AiKeyPoolService.migrateLegacyKeys(keys: Array<{ id: number; apiKey: string }>): Promise<MigrationResult[]>`.
- Admin requests become `{ supplierId, keys: string[] }` and `{ keys: Array<{ id, apiKey }> }`; responses never return envelope columns.

- [ ] **Step 1: Write failing persistence and controller tests**

```ts
it('batchAdd seals each submitted Key and persists no plaintext field', async () => {
  service.aiKeyEnvelopeService = { seal: jest.fn(async key => sealed(key)) };
  await service.batchAdd(4, ['first-provider-key']);
  expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
    supplierId: 4,
    apiKeyCiphertext: expect.any(String),
    apiKeyWrappedDek: expect.any(String),
    apiKeyKekRef: expect.any(String),
    apiKeyFingerprint: expect.any(String)
  }));
  expect(repository.save.mock.calls[0][0]).not.toHaveProperty('apiKey');
});

it('key-pool page query excludes all ciphertext and legacy Key columns', () => {
  expect(pageQueryOp.select.join(',')).not.toMatch(/apiKeyCiphertext|apiKeyWrappedDek|apiKeyCipherAdmin|apiKeyCipherMember|a\.apiKey/);
});
```

- [ ] **Step 2: Run the focused Midway test and verify RED**

Run: `cd /Users/niean/Documents/project/cool-admin-midway && npm test -- ai-member-credentials.test.ts --runInBand`

Expected: FAIL because envelope fields and plaintext `keys: string[]` ingestion are not implemented.

- [ ] **Step 3: Implement entity, service, and controller changes**

```ts
@Column({ type: 'text', comment: 'Vault信封密文', nullable: true })
apiKeyCiphertext: string;

@Column({ type: 'text', comment: 'Vault包装的数据密钥', nullable: true })
apiKeyWrappedDek: string;

@Column({ comment: 'Vault KEK 引用', nullable: true })
apiKeyKekRef: string;
```

Validate `supplierId` and nonempty trimmed Key input before sealing. De-duplicate request keys by their envelope fingerprint, map database unique conflicts to the existing duplicate result, and clear the copied `Buffer`/string array in `finally`. Make `batchAdd` and legacy migration reject when Vault is unavailable. The migration update must include `WHERE id = :id AND apiKeyCiphertext IS NULL` and return `migrated`, `alreadyMigrated`, or `notPending`; it must never update or select plaintext in the normal list endpoint.

- [ ] **Step 4: Run Midway regression tests**

Run: `cd /Users/niean/Documents/project/cool-admin-midway && npm test -- ai-member-credentials.test.ts ai-key-envelope.test.ts --runInBand`

Expected: PASS; serialized controller list/page results contain neither provider Key plaintext nor any ciphertext field.

- [ ] **Step 5: Commit persistence and ingestion**

```bash
git -C /Users/niean/Documents/project/cool-admin-midway add src/modules/ai/entity/keyPool.ts src/modules/ai/service/keyPool.ts src/modules/ai/controller/admin/keyPool.ts test/ai-member-credentials.test.ts
git -C /Users/niean/Documents/project/cool-admin-midway commit -m "feat(ai): store Key pool entries as Vault envelopes"
```

### Task 3: Issue a v2 credential from the current device public key

**Files:**
- Modify: `/Users/niean/Documents/project/cool-admin-midway/src/modules/ai/service/userMember.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-midway/src/modules/ai/controller/app/memberCredentials.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-midway/src/modules/ai/service/keyPool.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-midway/test/ai-member-credentials.test.ts`

**Interfaces:**
- Consumes `AiKeyEnvelopeService.open(record)` from Task 1.
- `createEncryptedLoginMember(userId: number, clientPublicKey: string): Promise<MemberCipherCredentials>` always returns `{ version: 2, baseURL, models, apiKeySeal: MemberApiKeySeal }` for an envelope record.
- `MemberApiKeySeal` is an object, not a JSON string: `{ version: 2; ephemeralPublicKey: string; salt: string; iv: string; ciphertext: string; tag: string }`.
- `AiUserMemberService.assign(userId, levelId, expireTime?)` chooses a free Vault-envelope Key transactionally; no admin-supplied Key or member ciphertext is accepted.

- [ ] **Step 1: Write failing signing and automatic assignment tests**

```ts
it('binds the requesting device key then returns an object v2 seal created from a Vault envelope', async () => {
  service.aiKeyEnvelopeService = { open: jest.fn(async () => Buffer.from('provider-test-key')) };
  const result = await service.createEncryptedLoginMember(7, client.publicKey);
  expect(memberRepository.update).toHaveBeenCalledWith(12, { desktopPublicKey: client.publicKey });
  expect(result).toMatchObject({ version: 2, baseURL: 'https://api.example/v1', models: ['model-a'] });
  expect(typeof result.apiKeySeal).toBe('object');
  expect(JSON.stringify(result)).not.toContain('provider-test-key');
});

it('registration and level replacement occupy an envelope Key without a member-specific stored ciphertext', async () => {
  await service.assignNormalForRegistration(42, transaction);
  expect(occupyBuilder.where).toHaveBeenCalledWith(expect.stringContaining('apiKeyCiphertext IS NOT NULL'), expect.any(Object));
  expect(occupyBuilder.set).toHaveBeenCalledWith({ status: 1, userId: 42 });
});
```

- [ ] **Step 2: Run the signing test and verify RED**

Run: `cd /Users/niean/Documents/project/cool-admin-midway && npm test -- ai-member-credentials.test.ts --runInBand`

Expected: FAIL because the service still returns string `apiKeySeal` or legacy v1 data.

- [ ] **Step 3: Implement current-device signing and envelope-only allocation**

```ts
async createEncryptedLoginMember(userId: number, clientPublicKey: string) {
  await this.bindDesktopPublicKey(userId, clientPublicKey);
  const member = await this.getLoginMember(userId);
  const apiKey = await this.aiKeyEnvelopeService.open(member.key);
  try {
    return {
      version: 2,
      baseURL: member.provider.baseURL,
      models: member.models,
      apiKeySeal: encryptApiKeyForX25519(clientPublicKey, apiKey.toString('utf8'))
    };
  } finally {
    apiKey.fill(0);
  }
}
```

Replace `getLoginMember`'s `apiKeyCipherMember || apiKey` test with mandatory envelope-field validation. `getFreeKey` and every allocation update must include non-null envelope fields; old records remain readable only through the existing explicit migration route. Retain the standalone bind endpoint but make `/credentials` bind first so old two-request login ordering cannot race. Log only outcome, trace ID, model count, Key pool ID and user ID; do not log error objects, envelope data or public-key bytes.

- [ ] **Step 4: Run Midway credential and registration regressions**

Run: `cd /Users/niean/Documents/project/cool-admin-midway && npm test -- ai-member-credentials.test.ts --runInBand`

Expected: PASS; first login, device rotation, normal registration, upgrade replacement, inactive membership, invalid envelope, and Vault failure all have deterministic outcomes.

- [ ] **Step 5: Commit signing and allocation**

```bash
git -C /Users/niean/Documents/project/cool-admin-midway add src/modules/ai/service/userMember.ts src/modules/ai/service/keyPool.ts src/modules/ai/controller/app/memberCredentials.ts test/ai-member-credentials.test.ts
git -C /Users/niean/Documents/project/cool-admin-midway commit -m "feat(ai): sign member credentials from Vault envelopes"
```

### Task 4: Replace the admin KEK main workflow and preserve one-time migration

**Files:**
- Modify: `/Users/niean/Documents/project/cool-admin-vue/src/modules/ai/views/keyPool.vue`
- Modify: `/Users/niean/Documents/project/cool-admin-vue/src/modules/ai/views/keyPool-submit.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-vue/src/modules/ai/views/keyPool-display.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-vue/src/modules/ai/views/keyPool-migration.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-vue/src/modules/ai/views/userMember.vue`
- Modify: `/Users/niean/Documents/project/cool-admin-vue/src/modules/ai/views/userMember-assign.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-vue/src/modules/ai/views/__tests__/keyPool-submit.test.ts`
- Test: `/Users/niean/Documents/project/cool-admin-vue/src/modules/ai/views/__tests__/keyPool-display.test.ts`
- Test: `/Users/niean/Documents/project/cool-admin-vue/src/modules/ai/views/__tests__/userMember-assign.test.ts`

**Interfaces:**
- `submitKeyPoolBatch({ service, batch, warning, success, refresh })` sends `{ supplierId, keys: string[] }`; it has no KEK argument.
- `prepareKeyPoolRows(rows)` returns `apiKeyDisplay: '********'` and strips all ciphertext fields.
- `submitMemberAssignment({ service, userId, levelId, expireTime, warning })` calls server assignment without reading a Key or public key.
- `runVaultKeyPoolMigration({ service, hkdfKek })` is the one-time only legacy KEK path; it decrypts one old record, sends `{ id, apiKey }`, and clears local plaintext in `finally`.

- [ ] **Step 1: Write failing Vue helper tests**

```ts
it('submits plaintext keys only to the Vault ingestion endpoint and always clears the form', async () => {
  const batch = { supplierId: 3, keys: 'key-a\nkey-b', loading: false };
  await submitKeyPoolBatch({ service, batch, warning, success, refresh });
  expect(service.ai.keyPool.batchAdd).toHaveBeenCalledWith({ supplierId: 3, keys: ['key-a', 'key-b'] });
  expect(batch.keys).toBe('');
});

it('never retains ciphertext fields in a Key-pool display row', async () => {
  const [row] = await prepareKeyPoolRows([{ id: 8, apiKeyCiphertext: 'cipher', apiKeyWrappedDek: 'wrapped' }]);
  expect(row).toEqual({ id: 8, apiKeyDisplay: '********' });
});

it('delegates membership assignment to the server without locally decrypting a Key', async () => {
  await submitMemberAssignment({ service, userId: 7, levelId: 2, warning });
  expect(service.assign).toHaveBeenCalledWith({ userId: 7, levelId: 2 });
});
```

- [ ] **Step 2: Run the Vue helper tests and verify RED**

Run: `cd /Users/niean/Documents/project/cool-admin-vue && pnpm vitest run src/modules/ai/views/__tests__/keyPool-submit.test.ts src/modules/ai/views/__tests__/keyPool-display.test.ts src/modules/ai/views/__tests__/userMember-assign.test.ts`

Expected: FAIL because the helpers still demand an unlocked KEK and encrypted DTOs.

- [ ] **Step 3: Implement the new main workflow**

```ts
const plaintextKeys = batch.keys.split(/[\n,]/).map(key => key.trim()).filter(Boolean);
try {
  await service.ai.keyPool.batchAdd({ supplierId: batch.supplierId, keys: plaintextKeys });
} finally {
  plaintextKeys.fill('');
  batch.keys = '';
}
```

Remove the KEK unlock/recovery/member-cipher migration controls from `keyPool.vue`; use the raw CRUD service with a page adapter that drops `apiKeyCiphertext`, `apiKeyWrappedDek`, `apiKeyKekRef`, legacy cipher fields and `apiKey` before creating the masked row. Change member assignment UI to select only user, level and expiry; the backend chooses the Key. Keep an explicit, warning-gated `迁移存量 Key 到 Vault` dialog that asks for the legacy KEK once, processes one record at a time, and never renders the plaintext or ciphertext in the table.

- [ ] **Step 4: Run Vue tests and build**

Run: `cd /Users/niean/Documents/project/cool-admin-vue && pnpm vitest run src/modules/ai/views/__tests__/keyPool-submit.test.ts src/modules/ai/views/__tests__/keyPool-display.test.ts src/modules/ai/views/__tests__/userMember-assign.test.ts && pnpm build`

Expected: PASS; the Key-pool list displays a fixed mask and main workflow has no local key decryption.

- [ ] **Step 5: Commit the admin workflow**

```bash
git -C /Users/niean/Documents/project/cool-admin-vue add src/modules/ai/views/keyPool.vue src/modules/ai/views/keyPool-submit.ts src/modules/ai/views/keyPool-display.ts src/modules/ai/views/keyPool-migration.ts src/modules/ai/views/userMember.vue src/modules/ai/views/userMember-assign.ts src/modules/ai/views/__tests__
git -C /Users/niean/Documents/project/cool-admin-vue commit -m "feat(ai): ingest Key pool entries through Vault"
```

### Task 5: Make the desktop parse and silently use the v2 object seal

**Files:**
- Modify: `/Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri/src/auth.rs`
- Modify: `/Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri/src/console.rs`
- Test: `/Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri/src/auth.rs` (existing unit-test module)

**Interfaces:**
- `MemberCipherCredentials.api_key_seal` deserializes as `MemberApiKeySeal`, not a string.
- `decrypt_v2_member_credential` accepts internal `version == 2`.
- `ensure_vip_credential` refreshes only when no in-memory credential exists; normal login and usage calls do not display refresh errors until the final fetch failure.

- [ ] **Step 1: Write failing Rust protocol tests**

```rust
#[test]
fn decrypts_v2_object_member_credentials() {
    let response = json!({
        "version": 2,
        "baseURL": "https://api.example/v1",
        "models": ["model-a"],
        "apiKeySeal": valid_v2_seal(&private_key, "provider-test-key")
    });
    let credential = decrypt_member_credential_response(&private_key, response).unwrap();
    assert_eq!(credential.api_key, "provider-test-key");
}

#[test]
fn rejects_string_api_key_seal_and_non_v2_internal_version() {
    assert!(decrypt_member_credential_response(&private_key, string_seal_response()).is_err());
    assert!(decrypt_member_credential_response(&private_key, wrong_version_response()).is_err());
}
```

- [ ] **Step 2: Run the Rust tests and verify RED**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri && cargo test decrypts_v2_object_member_credentials && cargo test rejects_string_api_key_seal_and_non_v2_internal_version`

Expected: FAIL because the response struct already expects an object, but the internal seal-version check still only accepts `1`.

- [ ] **Step 3: Implement strict v2 parsing and silent refresh behavior**

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemberCipherCredentials {
    version: u8,
    base_url: String,
    models: Vec<String>,
    api_key_seal: MemberApiKeySeal,
}

fn decrypt_v2_member_credential(
    client_private_key: &StaticSecret,
    response: MemberCipherCredentials,
) -> Result<VipRuntimeCredential, AuthError> {
    if response.api_key_seal.version != 2 {
        return Err(credential_error("不支持的凭据版本"));
    }
    // Decode the object fields then reuse decrypt_member_ciphertext.
}
```

Do not serialize the plaintext credential, response or seal into logs. Preserve the current runtime-only `AuthState` cache and error propagation; remove only UI-visible logging/toasts for successful background fetches. A final `ensure_vip_credential` error remains visible at the action that actually needs the Key.

- [ ] **Step 4: Run Rust unit tests and formatting**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri && cargo fmt --check && cargo test auth::tests`

Expected: PASS; v2 object response decrypts and the key exists only in the returned in-memory `VipRuntimeCredential`.

- [ ] **Step 5: Commit desktop protocol compatibility**

```bash
git -C /Users/niean/Documents/project/Vibe-Trading-Desktop add src-tauri/src/auth.rs src-tauri/src/console.rs
git -C /Users/niean/Documents/project/Vibe-Trading-Desktop commit -m "fix(desktop): accept v2 member credential seals"
```

### Task 6: Cross-repository verification and rollout evidence

**Files:**
- Modify: `/Users/niean/Documents/project/Vibe-Trading-Desktop/docs/superpowers/specs/2026-07-29-low-frequency-vip-credential-signing-design.md` only if test evidence exposes a design inconsistency.

**Interfaces:**
- Consumes all production interfaces from Tasks 1-5.
- Produces release evidence, not a schema column removal.

- [ ] **Step 1: Add a failure-mode test matrix to the existing tests**

```text
Vault unavailable -> no credential response and no provider fallback
new registration -> current public key bound and v2 seal returned
device rotation -> replacement public key gets a new seal
membership replacement -> next credential resolves the newly assigned envelope
database/API/log serialization -> test provider key is absent
```

- [ ] **Step 2: Run all focused checks**

Run: `cd /Users/niean/Documents/project/cool-admin-midway && npm test -- ai-key-envelope.test.ts ai-member-credentials.test.ts --runInBand`

Run: `cd /Users/niean/Documents/project/cool-admin-vue && pnpm vitest run src/modules/ai/views/__tests__/keyPool-submit.test.ts src/modules/ai/views/__tests__/keyPool-display.test.ts src/modules/ai/views/__tests__/userMember-assign.test.ts`

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri && cargo test auth::tests`

Expected: PASS for all three repositories.

- [ ] **Step 3: Check source and test output for disclosure paths**

Run: `rg -n "console\.log\(|logger\.(info|warn|error).*apiKey|JSON\.stringify\(.*apiKey" /Users/niean/Documents/project/cool-admin-midway/src/modules/ai /Users/niean/Documents/project/cool-admin-vue/src/modules/ai /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri/src/auth.rs`

Expected: no runtime log includes Key plaintext, DEK, Transit token, or envelope payload.

- [ ] **Step 4: Record Vault operational prerequisites**

```hcl
path "transit/encrypt/ai-provider" { capabilities = ["update"] }
path "transit/decrypt/ai-provider" { capabilities = ["update"] }
```

Enable a Vault audit device, inject the four `AI_VAULT_*` settings through the deployment secret store, and run a staging login plus member-usage request with a nonproduction Key. Confirm provider calls originate from the desktop client network, not the Midway host.

- [ ] **Step 5: Commit verification-only documentation if changed**

```bash
git -C /Users/niean/Documents/project/Vibe-Trading-Desktop add docs/superpowers/specs/2026-07-29-low-frequency-vip-credential-signing-design.md
git -C /Users/niean/Documents/project/Vibe-Trading-Desktop commit -m "docs: record credential signing rollout evidence"
```
