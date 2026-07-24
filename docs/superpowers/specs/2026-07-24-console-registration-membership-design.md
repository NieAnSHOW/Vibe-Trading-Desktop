# Console Registration And Membership Design

## Goal

Add an explicit desktop-console registration flow backed by cool-admin. A
successful registration creates a password-protected account and an active
normal membership, then configures the desktop runtime from the returned
member provider credentials.

## Scope And Ownership

The cool-admin repository at
`/Users/niean/Documents/project/cool-admin-midway` is the source of truth for
accounts, SMS verification, memberships, suppliers, and Key-pool allocation.
The Vibe Trading Desktop repository owns the Vue registration experience,
Tauri IPC, and owner-only local persistence of the login result. The Python
agent is not an account service and is out of scope.

## Registration Contract

`POST /app/user/login/register` accepts `phone`, `smsCode`, and `password`.
The server validates the SMS code and rejects an already registered phone.
The password must be 6 through 10 characters and contain at least one ASCII
uppercase letter, decimal digit, and non-alphanumeric special character.

Registration resolves a VIP level whose `code` is `normal`, then verifies that
its linked supplier is enabled and has `code` equal to `normal`. Both records
are maintained manually by operators in every environment. It reserves an
available Key from that supplier and creates the user plus one active member
record. A missing/disabled normal level or supplier, or an exhausted Key pool,
causes the whole registration to fail without leaving a usable user account.

The success payload has the existing login fields plus:

```ts
type MemberLoginView = {
  levelCode: "normal" | string;
  provider: { baseURL: string; apiKey: string };
  models: string[];
};
```

The `models` array is the configured `ai_vip_level.modelIds` list. Existing
password and SMS login return the same member object. The member API key is
returned by the service only to the Tauri client; it is not exposed to Vue or
stored in Pinia.

## Desktop Flow

The login page gains a Registration tab with phone, password, image captcha,
and SMS code fields. The password uses the same strict rule as the server.
"Get code" is enabled only when the phone, password, and four-character image
captcha are valid. "Register" is enabled only when every field is valid.

On success, Tauri persists the token, refresh metadata, provider base URL,
provider API key, and the first configured model to the existing 0600 user
`.env`. It caches and returns only user-safe information to Vue, then navigates
to the console home. Login fails visibly when a valid member configuration is
not returned so stale credentials are never retained.

## Error Handling

The server returns its normal cool-admin envelope and business errors for an
invalid or expired SMS code, duplicate phone, invalid password, missing normal
configuration, unavailable Key, or malformed member model list. The desktop
surfaces the API message, refreshes the image captcha after a failed SMS or
registration request, and does not start a countdown when the SMS request
fails.

## Tests

Server tests cover strict password validation, duplicate rejection, normal
level/supplier selection, no-Key failure with no created account, successful
registration, and member data in both login responses. Rust tests cover member
response parsing and environment persistence. Vue tests cover registration
visibility, the captcha/password gate on SMS sending, invalid form blocking,
and the registration IPC call.
