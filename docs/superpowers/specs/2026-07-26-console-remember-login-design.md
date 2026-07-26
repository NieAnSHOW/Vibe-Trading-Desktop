# Desktop Console Remembered Login Design

## Goal

Make the desktop console preserve an opted-in user login across application restarts for a fixed 14-day period, while simplifying registration into a secondary entry from the login page.

## Scope

- Keep only SMS and password as login-method tabs.
- Put a compact registration entry below each login form. It opens the existing registration form in the same page, with a return-to-login entry.
- Add an unchecked-by-default `记住登录（有效期 14 天）` checkbox to both login forms.
- When selected, persist the token session and a client-enforced absolute `remember_until` deadline in the existing user `.env` file.
- When not selected, keep the successful session only in process memory; quitting the application ends that session.
- On application launch, recover the stored session only when the 14-day deadline has not passed. Restore the console's authenticated UI state without requiring the user to visit the login screen first.
- At or after the local deadline, clear all persisted login keys and treat the user as logged out even if the server refresh token would otherwise remain valid.
- A token refresh may update server-token expiry values but must never extend the local 14-day remembered-login deadline.
- Logout must clear the remembered-login deadline together with all tokens.

## Architecture

The Vue page owns only the selected checkbox and passes `remember` to the phone/password Tauri commands. Rust remains the sole owner of secrets: it conditionally writes or clears the existing token block, adding `USER_REMEMBER_UNTIL` as an epoch-seconds value. `read_env_token_section` validates this deadline before returning a session and clears expired persisted credentials atomically.

`console_auth_status` restores an authenticated remembered session on startup. The auth store is refreshed during console-page initialization, so the restored session is represented in the UI. No token is placed in Pinia, localStorage, or the WebView.

Registration remains a normal successful-login flow and will use the default non-persistent behavior; the requested checkbox applies specifically to SMS and password login methods.

## Error Handling and Security

- Missing, malformed, zero, or expired `USER_REMEMBER_UNTIL` makes persisted credentials invalid and causes the complete login key set to be cleared.
- Local persistence stays at the existing `.env` location with atomic writes and Unix `0600` file permissions.
- The 14-day client deadline is enforced before any restored token can be used to start the VIP service.
- Existing server access-token/refresh-token expiry checks remain in force; the effective session window is the earlier of the server and local expiry boundaries.

## Verification

- Vue tests prove there are exactly two login tabs, registration is reached through the compact entry, and both login methods pass the checkbox value through IPC.
- Rust tests prove remembered credentials round-trip before their deadline, non-remembered credentials are not persisted, expired or malformed remembered state is rejected and cleared, and refresh preserves the original deadline.
- Run the affected Vitest suite, `cargo test`, and the console production build.
