# Console Registration And Membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver explicit password registration and normal-member-backed model configuration from cool-admin to the Vibe Trading desktop console.

**Architecture:** cool-admin owns account, SMS, membership, supplier, and Key-pool decisions. It returns one member-enriched login contract for registration and sign-in. Tauri stores credentials in its existing owner-only `.env`; Vue only receives the existing user-safe login view.

**Tech Stack:** Midway.js 3, TypeORM, Jest, Rust/serde/reqwest/Tauri 2, Vue 3, Pinia, Vitest.

## Global Constraints

- Both the enabled VIP level and its enabled supplier must have `code = "normal"` in every environment.
- Passwords are 6-10 characters and must include one ASCII uppercase letter, one decimal digit, and one non-alphanumeric special character.
- `apiKey` must not enter Vue, Pinia, templates, console logs, or an IPC result type exposed to Vue.
- Preserve the pre-existing dirty changes in `src-tauri/src/auth.rs` and `src-tauri/console-app/src/config/prod.ts`.
- Do not send live SMS or modify a real Key pool while verifying.

---

### Task 1: Server membership view and strict password validation

**Files:**
- Modify: `/Users/niean/Documents/project/cool-admin-midway/src/modules/user/service/login.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-midway/src/modules/user/service/info.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-midway/src/modules/ai/service/userMember.ts`
- Create: `/Users/niean/Documents/project/cool-admin-midway/test/user-registration.test.ts`

**Interfaces:**
- `isRegistrationPassword(value: unknown): boolean` is exported from `user/service/login.ts`.
- `AiUserMemberService.getLoginMember(userId: number)` resolves `{ levelCode, provider: { baseURL, apiKey }, models }` or throws `CoolCommException`.

- [ ] **Step 1: Write failing Jest tests for validation and DTO.**

```ts
import { isRegistrationPassword } from '../src/modules/user/service/login';
import { AiUserMemberService } from '../src/modules/ai/service/userMember';

it.each(['Short1!', 'toolongpassword1!A', 'lowercase1!', 'NoNumber!', 'NoSpecial1'])(
  '拒绝不符合规则的密码 %s', password => expect(isRegistrationPassword(password)).toBe(false)
);

it('返回当前会员供应商凭据及模型', async () => {
  const svc: any = new AiUserMemberService();
  svc.aiUserMemberEntity = { findOneBy: jest.fn(async () => ({ levelId: 2, keyPoolId: 3, status: 1, expireTime: null })) };
  svc.aiVipLevelEntity = { findOneBy: jest.fn(async () => ({ code: 'normal', status: 1, supplierId: 4, modelIds: ['model-a'] })) };
  svc.aiSupplierEntity = { findOneBy: jest.fn(async () => ({ code: 'normal', status: 1, upstreamUrl: 'https://api.example/v1' })) };
  svc.aiKeyPoolEntity = { findOneBy: jest.fn(async () => ({ apiKey: 'member-key' })) };
  await expect(svc.getLoginMember(7)).resolves.toEqual({ levelCode: 'normal', provider: { baseURL: 'https://api.example/v1', apiKey: 'member-key' }, models: ['model-a'] });
});
```

- [ ] **Step 2: Verify red.**

Run: `cd /Users/niean/Documents/project/cool-admin-midway && npm test -- --runInBand test/user-registration.test.ts`

Expected: failure because the exported validator and DTO method do not exist.

- [ ] **Step 3: Implement the smallest shared helpers.**

```ts
export const REGISTRATION_PASSWORD_RE = /^(?=.{6,10}$)(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9\s]).*$/;
export function isRegistrationPassword(value: unknown) {
  return typeof value === 'string' && REGISTRATION_PASSWORD_RE.test(value);
}

// getLoginMember validates active/non-expired membership, enabled level and
// supplier, assigned Key, and non-empty string[] modelIds before returning:
return { levelCode: level.code, provider: { baseURL: supplier.upstreamUrl, apiKey: key.apiKey }, models };
```

Use the same validator in `UserInfoService.setPassword`, replacing its length-only condition.

- [ ] **Step 4: Verify green.**

Run: `cd /Users/niean/Documents/project/cool-admin-midway && npm test -- --runInBand test/user-registration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the server primitive.**

```bash
cd /Users/niean/Documents/project/cool-admin-midway
git add src/modules/user/service/login.ts src/modules/user/service/info.ts src/modules/ai/service/userMember.ts test/user-registration.test.ts
git commit -s -m "feat(user): validate membership registration credentials"
```

### Task 2: Explicit normal-member registration and enriched login response

**Files:**
- Modify: `/Users/niean/Documents/project/cool-admin-midway/src/modules/user/service/login.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-midway/src/modules/ai/service/userMember.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-midway/src/modules/user/controller/app/login.ts`
- Modify: `/Users/niean/Documents/project/cool-admin-midway/test/user-registration.test.ts`

**Interfaces:**
- `UserLoginService.register(phone, smsCode, password)` validates and creates a user, assigns normal membership, and returns login fields plus `member`.
- `AiUserMemberService.assignNormalForRegistration(userId)` requires level/supplier code `normal`; it releases the Key if member persistence fails.
- `POST /app/user/login/register` is `IGNORE_TOKEN` and forwards `phone`, `smsCode`, `password`.

- [ ] **Step 1: Write failing registration tests.**

```ts
it('注册创建 normal 会员并返回凭据', async () => {
  const svc: any = makeLoginService({ smsPass: true, normalConfigured: true, freeKey: true });
  await expect(svc.register('13800000000', '1234', 'Passw0rd!')).resolves.toMatchObject({
    hasPassword: true,
    member: { levelCode: 'normal', provider: { baseURL: expect.any(String), apiKey: expect.any(String) }, models: ['model-a'] },
  });
});

it('normal 等级、供应商或 Key 不可用时不保存用户', async () => {
  const svc: any = makeLoginService({ smsPass: true, normalConfigured: false });
  await expect(svc.register('13800000000', '1234', 'Passw0rd!')).rejects.toThrow('普通会员');
  expect(svc.userInfoEntity.save).not.toHaveBeenCalled();
});

it('短信登录不隐式建用户', async () => {
  const svc: any = makeLoginService({ smsPass: true, existingUser: null });
  await expect(svc.phoneVerifyCode('13800000000', '1234')).rejects.toThrow('请先注册');
});
```

- [ ] **Step 2: Verify red.**

Run: `cd /Users/niean/Documents/project/cool-admin-midway && npm test -- --runInBand test/user-registration.test.ts`

Expected: failure because `register`, normal allocation, and enriched results are absent.

- [ ] **Step 3: Implement registration and route.**

```ts
async register(phone: string, smsCode: string, password: string) {
  if (!isRegistrationPassword(password)) throw new CoolCommException('密码须为6-10位，且包含大写字母、数字和特殊符号');
  if (!(await this.dypnsSmsService.check(phone, smsCode))) throw new CoolCommException('验证码错误或已过期');
  if (await this.userInfoEntity.findOneBy({ phone })) throw new CoolCommException('手机号已注册，请直接登录');
  await this.aiUserMemberService.assertNormalRegistrationReady();
  const user = await this.userInfoEntity.save({ phone, unionid: phone, loginType: 2, nickName: phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'), password: bcrypt.hashSync(password, 10) });
  try { await this.aiUserMemberService.assignNormalForRegistration(user.id); }
  catch (error) { await this.userInfoEntity.delete(user.id); throw error; }
  return this.loginResult(user, true);
}
```

`assertNormalRegistrationReady` locates a level with `code: 'normal'`, `status: 1`, then requires its supplier to have `code: 'normal'`, `status: 1`, before user persistence. `assignNormalForRegistration` claims a free Key with the existing `status = 0` conditional update, saves an active member, and calls `release` if member save fails. `loginResult` appends `await getLoginMember(user.id)` to `token`. Use it from password and SMS login; SMS login requires an existing account rather than calling `phone()`.

Add this controller action:

```ts
@CoolTag(TagTypes.IGNORE_TOKEN)
@Post('/register', { summary: '手机号注册' })
async register(@Body('phone') phone: string, @Body('smsCode') smsCode: string, @Body('password') password: string) {
  return this.ok(await this.userLoginService.register(phone, smsCode, password));
}
```

- [ ] **Step 4: Verify green and compile the backend.**

Run: `cd /Users/niean/Documents/project/cool-admin-midway && npm test -- --runInBand test/user-registration.test.ts && npm run lint && npm run build`

Expected: all commands exit 0.

- [ ] **Step 5: Commit the cool-admin feature.**

```bash
cd /Users/niean/Documents/project/cool-admin-midway
git add src/modules/user/service/login.ts src/modules/user/service/info.ts src/modules/user/controller/app/login.ts src/modules/ai/service/userMember.ts test/user-registration.test.ts
git commit -s -m "feat(user): register normal members with provider access"
```

### Task 3: Member-aware Tauri registration and secure persistence

**Files:**
- Modify: `/Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri/src/auth.rs`
- Modify: `/Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri/src/console.rs`
- Modify: `/Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri/src/main.rs`

**Interfaces:**
- `LoginRaw` gains `member: MemberLoginRaw` with `levelCode`, `provider.baseURL`, `provider.apiKey`, and non-empty `models`.
- `auth::register(phone, smsCode, password)` posts to `/app/user/login/register`.
- `console_login_register` persists only through Rust and returns `LoginResultView` without member credentials.

- [ ] **Step 1: Add failing Rust tests.**

```rust
#[test]
fn parse_member_login_and_persist_its_provider() {
    let raw: LoginRaw = parse_cool_response(r#"{"code":1000,"data":{"token":"t","refreshToken":"r","expire":1,"refreshExpire":2,"hasPassword":true,"member":{"levelCode":"normal","provider":{"baseURL":"https://api.example/v1","apiKey":"member-key"},"models":["model-a"]}}}"#).unwrap();
    assert_eq!(raw.member.level_code, "normal");
    assert_eq!(raw.member.provider.base_url, "https://api.example/v1");
    assert_eq!(raw.member.provider.api_key, "member-key");
    assert_eq!(raw.member.models, vec!["model-a"]);
}
```

- [ ] **Step 2: Verify red.**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri && cargo test parse_member_login_and_persist_its_provider`

Expected: failure because `LoginRaw` lacks the member contract.

- [ ] **Step 3: Implement typed parsing, POST helper, and command.**

```rust
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberLoginRaw { pub level_code: String, pub provider: MemberProviderRaw, pub models: Vec<String> }

pub fn register(phone: &str, sms_code: &str, password: &str) -> Result<LoginRaw, AuthError> {
    post_login("/app/user/login/register", serde_json::json!({ "phone": phone, "smsCode": sms_code, "password": password }))
}
```

Before `write_env_token_section` writes anything, reject a blank model, base URL, or API key. Write the member URL/key/first model instead of static MaaS defaults. Thread member through `finalize_login`, add `console_login_register`, and register it in `main.rs`. Do not add member fields to `LoginResultView`.

- [ ] **Step 4: Verify green.**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri && cargo fmt --check && cargo test auth console`

Expected: exit 0.

### Task 4: Vue registration entry and final review

**Files:**
- Modify: `/Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri/console-app/src/ipc/commands.ts`
- Modify: `/Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri/console-app/src/pages/LoginPage.vue`
- Modify: `/Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri/console-app/src/pages/__tests__/LoginPage.test.ts`

**Interfaces:**
- `consoleLoginRegister(phone: string, smsCode: string, password: string): Promise<LoginResultView>`.
- Login page has a `register` tab and the same `PASSWORD_RE` semantics as the server.

- [ ] **Step 1: Write failing Vitest cases.**

```ts
it('注册页在密码和图形验证码都合法前禁用获取验证码', async () => {
  const w = mount(LoginPage, { global: { plugins: [router] } });
  await w.get('[data-test="register-tab"]').trigger('click');
  await w.get('[data-test="register-phone"]').setValue('13800000000');
  await w.get('[data-test="register-password"]').setValue('weak');
  await w.get('[data-test="register-captcha"]').setValue('abcd');
  expect(w.get('[data-test="register-send-code"]').attributes('disabled')).toBeDefined();
});

it('完整注册表单调用注册 IPC', async () => {
  const w = mount(LoginPage, { global: { plugins: [router] } });
  await w.get('[data-test="register-tab"]').trigger('click');
  await w.get('[data-test="register-phone"]').setValue('13800000000');
  await w.get('[data-test="register-password"]').setValue('Passw0rd!');
  await w.get('[data-test="register-captcha"]').setValue('abcd');
  await w.get('[data-test="register-sms"]').setValue('1234');
  await w.get('[data-test="register-submit"]').trigger('click');
  await flushPromises();
  expect(mocks.consoleLoginRegister).toHaveBeenCalledWith('13800000000', '1234', 'Passw0rd!');
});
```

- [ ] **Step 2: Verify red.**

Run: `cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri/console-app && npm test -- src/pages/__tests__/LoginPage.test.ts`

Expected: failure because the tab and IPC function do not exist.

- [ ] **Step 3: Implement the registration form and command wrapper.**

```ts
const PASSWORD_RE = /^(?=.{6,10}$)(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9\s]).*$/;
const registerPasswordValid = computed(() => PASSWORD_RE.test(registerPassword.value));
const registerValid = computed(() => phoneValid.value && registerPasswordValid.value && captchaValid.value && smsValid.value);

async function submitRegister() {
  if (!registerValid.value) return;
  const view = await consoleLoginRegister(phone.value, smsCode.value, registerPassword.value);
  await finishLogin(view);
}
```

Add a registration tab with phone, password, captcha, and SMS fields. Its send-code button must require phone + strict password + captcha; reuse existing countdown/captcha error behavior. Put `data-test` attributes on registration-only controls and never display returned member data.

- [ ] **Step 4: Run cross-repository verification and separate review.**

Run: `cd /Users/niean/Documents/project/cool-admin-midway && npm test -- --runInBand test/user-registration.test.ts && npm run build && cd /Users/niean/Documents/project/Vibe-Trading-Desktop/src-tauri && cargo fmt --check && cargo test && cd console-app && npm test && npm run build`

Expected: all commands exit 0.

Review both diffs separately for exact normal-level/supplier checks, no implicit SMS registration, Key-release compensation, password-rule parity, raw Authorization compatibility, and absence of `apiKey` in Vue/Pinia/log output.

- [ ] **Step 5: Commit the desktop changes.**

```bash
cd /Users/niean/Documents/project/Vibe-Trading-Desktop
git add src-tauri/src/auth.rs src-tauri/src/console.rs src-tauri/src/main.rs src-tauri/console-app/src/ipc/commands.ts src-tauri/console-app/src/pages/LoginPage.vue src-tauri/console-app/src/pages/__tests__/LoginPage.test.ts
git commit -s -m "feat(console): register normal members securely"
```
