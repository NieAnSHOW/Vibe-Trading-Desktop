# Task 3 Report: Member-aware Tauri registration and secure persistence

## Outcome

Implemented the cool-admin member login contract in the Tauri Rust layer. Phone, password, refresh, and registration login responses now parse typed member provider data. Successful login finalization writes the returned provider base URL, provider API key, and first model to the existing user `.env` through the atomic 0600 writer.

Added `auth::register` for `POST /app/user/login/register`, exposed `console_login_register`, and registered the command in the Tauri invoke handler. `LoginResultView` remains credential-free.

## Security behavior

- Rejects an empty models list or blank first model, provider base URL, or provider API key before reading or mutating `.env`.
- Preserves the provider values exactly as returned by the member contract.
- Persists the cool-admin access token separately as `USER_ACCESS_TOKEN`; it is never confused with or replaced by `OPENAI_API_KEY` during restart recovery.
- Clears both access and provider credentials on logout.
- Explicitly forces the atomic temp file to mode 0600 even when a stale temp file already exists with broader permissions.

## TDD evidence

Red runs observed:

- `cargo test parse_member_login_and_persist_its_provider` failed because `MemberLoginRaw`, `MemberProviderRaw`, and `LoginRaw.member` did not exist.
- `cargo test write_env_atomic_forces_0600_when_temp_file_already_exists` failed with observed mode 0644 instead of 0600.
- `cargo test read_token_section_roundtrips_after_write` failed because restart recovery returned the member provider key as the user access token.

Green verification:

```text
cargo fmt --check       PASS
cargo test auth         PASS (23 passed)
cargo test console      PASS (17 passed)
```

The brief's literal combined command `cargo test auth console` is not valid Cargo syntax, so the two filters were run separately.

## Independent review

The first review identified a high-severity credential-boundary issue in restart recovery: the old implementation restored `UserSession.token` from `OPENAI_API_KEY`. The implementation now persists and restores `USER_ACCESS_TOKEN` separately, with a regression test proving the user access token and member provider key remain distinct.

## Files

- `src-tauri/src/auth.rs`
- `src-tauri/src/console.rs`
- `src-tauri/src/main.rs`
