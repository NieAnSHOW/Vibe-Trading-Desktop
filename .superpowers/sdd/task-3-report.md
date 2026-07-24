# Task 3 Report: VIP and Custom LLM Settings API

## Outcome

Implemented explicit desktop LLM modes in the settings API. The persisted
`DESKTOP_LLM_MODE` value selects either `vip` or `custom`; desktop VIP
credentials, URL, and model list remain transient process environment values.

- `GET /settings/llm` returns `desktop_llm_mode` and `desktop_vip_available`.
- VIP mode selects the effective `vip_server` runtime provider without
  serializing injected credentials, URL, or model list to the WebUI.
- `PUT /settings/llm` with `mode: "vip"` persists only
  `DESKTOP_LLM_MODE=vip` and maps the already-injected values into the active
  Python runtime environment.
- `PUT /settings/llm` with `mode: "custom"` preserves the existing custom
  provider persistence flow and writes `DESKTOP_LLM_MODE=custom`.
- Removed the deprecated `/settings/llm/vip-models` API and frontend types.

## Security Boundaries

- `VIBE_DESKTOP_VIP_API_KEY`, `VIBE_DESKTOP_VIP_BASE_URL`, and
  `VIBE_DESKTOP_VIP_MODELS_JSON` are never passed to a dotenv writer.
- Legacy `VIP_API_KEY` and `VIP_BASE_URL` are excluded from the settings
  dotenv-key set, and custom mode rejects `vip_server` as a persisted provider.
- The settings response omits the VIP provider metadata and clears normal
  `base_url` / `api_key_env` response values while VIP is active.

## Verification

```text
./.venv/bin/pytest agent/tests/test_settings_api.py -q
21 passed

../.venv/bin/python (from agent/)
vip endpoint absent; transient keys excluded from dotenv writers
```

`frontend/npm run build` currently fails only because the parallel Settings UI
task has not yet replaced its obsolete `getVipModels` call or supplied the new
required `mode` field. The API types were intentionally updated to make those
call sites fail until that task lands.

## Files

- `agent/src/api/settings_routes.py`
- `agent/tests/test_settings_api.py`
- `frontend/src/lib/api.ts`
