# Desktop VIP LLM Runtime Design

## Goal

When a desktop user is signed in, VIP Server is the default LLM runtime. Its
credentials must not be exposed in WebUI, ordinary UI, or user configuration
files. Users can explicitly switch to their existing custom-provider settings
without losing those settings.

## Scope and Security Boundary

- Persisted user configuration may retain desktop login access and refresh
  tokens, the selected mode, and existing custom-provider settings.
- VIP `apiKey`, `baseURL`, and model list are never written to `.env` or sent
  to WebUI.
- A desktop process holds decrypted VIP credentials only in memory, then passes
  them to its Python sidecar through process-local environment variables.
- This prevents disclosure through configuration files and ordinary UI. It does
  not claim to protect a credential from a user with local process-debugging or
  binary-analysis capabilities.

## Runtime Modes

`DESKTOP_LLM_MODE` is a non-secret setting in the desktop user `.env`:

- `vip` is the default after successful desktop login.
- `custom` activates the existing provider/model/key configuration flow.

The Python service treats VIP as active only when the mode is `vip` and the
desktop sidecar supplied a valid in-memory VIP credential. VIP mode never
rewrites the custom LLM keys in `.env`.

When a user selects custom mode and saves, the existing LLM save behavior writes
the custom provider settings and sets `DESKTOP_LLM_MODE=custom`. Selecting VIP
sets `DESKTOP_LLM_MODE=vip` without persisting a VIP key, URL, or model. The
sidecar keeps its VIP credential available for the process lifetime so the
switch takes effect in the running service. A failure to obtain or decrypt a
VIP credential is visible and does not silently fall back to custom mode.

## Encrypted Membership Credential API

The cool-admin AI module exposes a token-protected endpoint:

`POST /app/ai/member/credentials`

The request contains a one-time X25519 desktop public key. The endpoint uses
`ctx.user.id`, never a caller-provided user ID, to validate the active member,
VIP level, supplier, assigned key, and allowed models. It returns an encrypted
envelope with a version, server ephemeral public key, nonce, ciphertext, and
authentication tag. The plaintext contains only `baseURL`, `apiKey`, and
models.

The server and Tauri client derive an AES-256-GCM key from an X25519 shared
secret using HKDF with a versioned context string. The Tauri application creates
its key pair for the application process only and discards the private key at
exit. It decrypts the response in memory and never serializes the result.

## Desktop Login and Service Lifecycle

1. Login returns normal user authentication tokens only.
2. Tauri writes only the authentication token section and `DESKTOP_LLM_MODE` to
   the user `.env`; no VIP LLM fields are written.
3. Tauri requests encrypted membership credentials after login and again before
   service start or token refresh when needed.
4. The sidecar receives private VIP values in dedicated process environment
   variables, alongside a non-secret provisioned marker.
5. Logout clears authentication tokens, the mode, and all in-memory VIP state.
   Service exit discards child-process variables naturally.

## WebUI Behavior

The LLM settings area contains a binary mode control:

- **Use VIP service** is the default for an authenticated, provisioned desktop
  session. It identifies VIP Server as the active runtime and hides the model
  selection, API-key field, and save button.
- **Use custom model** restores the existing provider selector, model, base URL,
  API-key, and save controls. Saving preserves the current custom-provider
  behavior while selecting `custom` mode.

WebUI receives only mode and non-secret status fields. It must not receive the
VIP credential values or its model list.

## Verification

- Rust unit tests cover encrypted-envelope decrypt success, tamper rejection,
  process-memory-only session behavior, and `.env` persistence excluding VIP
  credentials.
- TypeScript service tests cover membership authorization, expired/inactive
  membership rejection, and that the controller ignores a supplied user ID.
- Python API tests cover mode selection, custom-save compatibility, VIP runtime
  activation, and rejection when VIP mode lacks a provisioned credential.
- Frontend tests cover both mode-control states and verify that VIP mode renders
  none of the model, API-key, or save controls.
