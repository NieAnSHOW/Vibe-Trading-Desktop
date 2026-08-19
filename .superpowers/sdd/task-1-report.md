# Task 1 Report: Python Custom Runtime Exit

## Scope

- `agent/src/api/settings_routes.py`
- `agent/tests/test_settings_api.py`
- `agent/tests/test_api_server_startup.py`

## RED

Command:

```sh
pytest agent/tests/test_settings_api.py -q -k 'restore_custom_runtime or desktop_exit_vip'
```

Result: failed as expected before implementation. The two unit tests raised
`AttributeError` because `restore_custom_runtime` did not exist, and the HTTP
test returned `404` because the route did not exist. The first run also showed
that this environment's Starlette `TestClient` does not accept its existing
`client=` argument; the new HTTP test was then changed to use the file's
existing `httpx.ASGITransport` pattern.

## GREEN

Implemented:

- `CustomLLMReadinessResponse` with only `custom_configured`.
- `_custom_llm_configured`, including provider/model/base URL checks, required
  non-placeholder API-key checks, and OAuth login status.
- `restore_custom_runtime`, which writes `DESKTOP_LLM_MODE=custom`, restores
  persisted custom values, clears all six VIP process-only variables, resets
  `_vip_selected_model`, and returns a secret-free readiness result.
- `POST /settings/llm/desktop-exit-vip` protected by `require_local_or_auth`.
- Regression coverage for incomplete custom settings at startup.

Focused command:

```sh
pytest agent/tests/test_settings_api.py -q -k 'restore_custom_runtime or desktop_exit_vip'
```

Result: `3 passed`.

Startup command:

```sh
pytest agent/tests/test_api_server_startup.py -q
```

Result: `5 passed`.

Static checks:

```sh
python -m py_compile agent/src/api/settings_routes.py
ruff check agent/src/api/settings_routes.py agent/tests/test_settings_api.py agent/tests/test_api_server_startup.py
git diff --check
```

Result: all passed.

## Full Settings File

Command:

```sh
pytest agent/tests/test_settings_api.py -q
```

Result: blocked by a pre-existing environment compatibility issue: thirteen
tests error and three fail at fixture/client construction because the installed
Starlette `TestClient.__init__` rejects the existing `client=` keyword. The
task's focused route test uses `httpx.ASGITransport`, so it passes independently
of that unrelated test-client mismatch.

## Self-review

- The response model exposes no credentials, provider details, or URLs.
- VIP values are removed before custom aliases are re-established; saved
  `OPENAI_API_KEY`/`OPENAI_BASE_URL` remain available for a custom OpenAI
  provider.
- The route uses the requested local-or-auth dependency.
- No unrelated working-tree changes were included.

## Commit

`63f4ac37 feat: add desktop custom llm exit runtime switch`

## Review Fix

Review found that an invalid, missing, or `vip_server` persisted provider left
the process's active VIP `LANGCHAIN_*` and OpenAI aliases in place because the
runtime sync was skipped. It also found that a missing saved base URL was being
replaced with the provider default, making readiness incorrectly true.

Added RED coverage for invalid and missing providers seeded with a full VIP
runtime, asserting that logout returns `custom_configured=False` and removes
the provider/model plus OpenAI compatibility aliases. Added coverage that an
Ollama configuration without a persisted base URL is not ready.

Updated `restore_custom_runtime` to clear `LANGCHAIN_PROVIDER`,
`LANGCHAIN_MODEL_NAME`, `OPENAI_API_KEY`, `OPENAI_API_BASE`, and
`OPENAI_BASE_URL` when there is no valid non-VIP persisted provider. Valid
providers now synchronize only the persisted base URL, without substituting a
default.

Verification:

```sh
pytest agent/tests/test_settings_api.py -q -k 'restore_custom_runtime or desktop_exit_vip or persisted_base_url'
ruff check agent/src/api/settings_routes.py agent/tests/test_settings_api.py
python -m py_compile agent/src/api/settings_routes.py
git diff --check
```

Result: `6 passed`; lint, compilation, and diff checks passed.

Fix commit: `6e1e8662 fix: clear vip aliases on invalid custom restore`.
