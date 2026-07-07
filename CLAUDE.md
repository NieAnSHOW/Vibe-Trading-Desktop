# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Vibe Trading Desktop** — A natural-language finance research AI agent with backtesting, wrapped in a Tauri v2 desktop shell for macOS/Windows distribution. Produced by HKUDS (HKU Data Science). Three-layer architecture:

1. **Python backend** (`agent/`) — FastAPI REST API + SSE streaming, LangGraph ReAct agent, 70+ finance skills, backtesting engine, live trading with mandate enforcement
2. **React frontend** (`frontend/`) — Vite + React 19 + TypeScript SPA with ECharts, Zustand state, Tailwind CSS
3. **Tauri desktop shell** (`src-tauri/`) — Rust app that embeds a Python 3.12 runtime, spawns it as a sidecar, and serves the UI in a native webview

## Common Commands

### Backend (Python)

```bash
pip install -e ".[dev]"                                    # install with dev deps
vibe-trading serve                                         # start API on :8899

# Tests
pytest --ignore=agent/tests/e2e_backtest \
       --ignore=agent/tests/test_e2e_harness_v2.py \
       --tb=short -q                                       # full suite (excludes e2e needing live keys)

# Safety-critical narrow tests (always run for order/mandate/live changes)
pytest agent/tests/test_sdk_order_gate.py \
       agent/tests/test_mandate_enforcement.py -q

# Syntax check
python -m compileall -q agent/cli
python -m py_compile agent/api_server.py agent/mcp_server.py
```

### Frontend (React/Vite)

```bash
cd frontend
npm install
npm run dev                  # dev server on :5899, proxies API to backend :8899
npm run build                # tsc -b && vite build
npx vitest run               # single test run
npx vitest run --coverage    # with v8 coverage (covers src/lib/**, src/stores/**)
```

Test files: `src/**/__tests__/**/*.test.{ts,tsx}` — jsdom environment, globals enabled.

### Desktop Shell (Tauri/Rust)

```bash
cd src-tauri
cargo test                   # unit tests per module (sidecar, resources, runtime_dir, port, version)
cargo tauri dev               # run desktop app (needs assembled resources in .desktop-build/)
```

### Desktop Build Assembly & Packaging

The desktop app bundles three artifacts into the Tauri resource bundle (see `src-tauri/tauri.conf.json` `bundle.resources`): an embedded **Python 3.12 runtime**, the **agent** code, and the **frontend dist**. All are staged under `.desktop-build/` before `cargo tauri build`. Scripts in `scripts/desktop/`:

```bash
# Full pipeline (stages into .desktop-build/):
bash scripts/desktop/fetch-runtime.sh     # download python-build-standalone runtime; PBS_TAG/PBS_ASSET optional (defaults to cpython-3.12.13+20260610, asset auto-picked by uname -m)
bash scripts/desktop/install-deps.sh [<runtime_dir>]  # `uv pip install` Tier 0 deps only (requirements-tier0.txt) into site-packages; runtime_dir defaults to .desktop-build/python-runtime
bash scripts/desktop/assemble.sh          # stage agent code + .env + VERSION into .desktop-build/, then run smoke_tier0.py

# End-to-end packaging (auto-runs fetch-runtime + install-deps + assemble if .desktop-build/ is not ready):
bash scripts/desktop/build-dmg.sh         # macOS .dmg (validates toolchain, rebuilds frontend, cargo tauri build, smoke-checks .app/.dmg)
./scripts/desktop/build-windows.ps1       # Windows MSI (fetch-runtime → install-deps → assemble → cargo tauri build)

# Version sync for tag-driven releases (keep pyproject.toml, tauri.conf.json, etc. aligned):
node scripts/desktop/sync-version.mjs <vX.Y.Z>
```

`fetch-runtime.sh` no longer hard-fails without `PBS_TAG`: it defaults to `PBS_TAG=20260610` / `PBS_PY=3.12.13` and auto-picks the `install_only` asset by `uname -sm` (macOS arm64/x86_64, Linux gnu x86_64/aarch64). Override only to pin a different release — `PBS_TAG=… PBS_ASSET=… bash scripts/desktop/fetch-runtime.sh` (or set `PBS_PY` to retarget the CPython patch version while keeping the auto-picked asset template). The CI equivalent lives in `.github/workflows/desktop-build.yml` (`PBS_TAG: '20260610'`, asset resolved via the release API).

`uv` is a prerequisite for `install-deps.sh`. **Note:** `install-deps.sh` now installs **only Tier 0** (`requirements-tier0.txt`, ~15 lightweight packages) instead of the full `requirements.txt`. Heavy dependencies (pandas, scipy, scikit-learn, duckdb, etc.) are installed at first-run bootstrap into `~/.vibe-trading/venv/` via `vibe-trading bootstrap`. See `docs/desktop/README.md` for the three-tier dependency model.

`weasyprint` is excluded from the bundle (native cairo/pango deps don't bundle) — shadow-account **PDF** reports will not render in desktop builds (HTML reports still work). Note: the bootstrap CLI (`agent/src/desktop_bootstrap/cli.py`) reads `agent/requirements.txt` directly and does **not** filter weasyprint, so bootstrap will attempt to install it into `venv`. If the system lacks cairo/pango libraries (e.g., missing `brew install` on macOS), weasyprint will fail at runtime but only PDF report generation is affected — all other functionality works fine.

`.desktop-build/` is git-ignored staging; never commit it. CI release builds run via `.github/workflows/desktop-build.yml` (tag-driven).

### Distribution on macOS (MVP)

`build-dmg.sh` produces an **unsigned, unnotarized** `.dmg` (the default for the MVP). macOS Gatekeeper reports these as "damaged and can't be opened" when the DMG is downloaded through a browser, because the browser applies a `com.apple.quarantine` attribute.

**User-side workaround — document this in Release notes:** after dragging the app to `/Applications`, the user opens Terminal and runs:

```bash
xattr -cr "/Applications/Vibe Trading.app"
```

This clears the quarantine flag on that one app only — it does not touch system settings or other apps. Full install instructions live in `docs/desktop/README.md`. Telling users to disable Gatekeeper globally (`sudo spctl --master-disable`, the hidden "Anywhere" option) is **not** recommended: it lowers security for the whole machine and is unreliable on newer macOS.

### Code Signing & Notarization (future — after Apple Developer account)

When an Apple Developer Program account is available, the build can sign + notarize so users double-click to install with no workaround. When `APPLE_SIGNING_IDENTITY` is set, `build-dmg.sh` auto-invokes `scripts/desktop/sign-and-notarize.sh`, which deep-codesigns the `.app` — including the ~400 `.dylib`/`.so` C extensions in the embedded Python runtime — with Hardened Runtime, submits the `.dmg` to `notarytool`, and staples the ticket.

**Prerequisites** (one-time):
1. Apple Developer Program membership; import a "Developer ID Application" certificate into Keychain (`security find-identity -p codesigning -v` to confirm).
2. Create notarization credentials — either store a Keychain profile (`xcrun notarytool store-credentials "vibe-trading" --apple-id <id> --team-id <tid> --password <app-specific>`, recommended) or generate an App-Specific Password at appleid.apple.com.

**Build a shippable DMG:**

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
APPLE_KEYCHAIN_PROFILE=vibe-trading \
bash scripts/desktop/build-dmg.sh
# alt: set APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID instead of the profile
```

**Why no App Sandbox:** the Python sidecar pip-installs third-party packages into `~/.vibe-trading/runtime/libs` at first run and `dlopen`s them; those runtime-downloaded `.so` can't be pre-signed, so `src-tauri/Entitlements.plist` carries `disable-library-validation` (plus the JIT/unsigned-memory exceptions CPython needs). Only Hardened Runtime is enabled.

**Verify a signed build:** `xcrun stapler validate <dmg>` and `spctl -a -vvv -t install <dmg>` should report `source=Notarized Developer ID`. **CI does not sign** — `.github/workflows/desktop-build.yml` ships unsigned artifacts; sign locally for distribution.

## Architecture

### Data Flow (Desktop Mode)

1. Tauri app starts → shows desktop console UI
2. Rust resolves bundled resources (Python runtime, agent code, frontend dist)
3. On first run or version bump, agent code copies to `~/.vibe-trading/runtime/agent/`
4. Rust checks `~/.vibe-trading/venv/` status:
   - If venv missing or incomplete, shows "Not Installed" / "Incomplete" state
   - If `.requirements_hash` marker present and smoke passed, shows "Ready"
5. User clicks "Install / Fix Dependencies" → Rust spawns `vibe-trading bootstrap --sse` using Tier 0 runtime's Python (not venv), streaming progress back to console UI. Bootstrap creates venv in `~/.vibe-trading/venv/`, pip-installs the full `requirements.txt`, writes a hash marker, and runs smoke validation
6. When "Ready" and user clicks "Start Service" → Rust spawns serve from the venv Python (`~/.vibe-trading/venv/bin/python` / `Scripts/python.exe`). Health-check polls `GET /health` (up to 60s). On success, "Open WebUI in Browser" button becomes active
7. "Open WebUI in Browser" opens `http://127.0.0.1:<port>/` in the system default browser (the Tauri webview is the console, not the business UI)
8. On exit, sidecar process group killed via `killpg(SIGTERM)`

### Backend Key Paths

- **Entry points**: `agent/cli/main.py` (CLI `vibe-trading`), `agent/mcp_server.py` (MCP `vibe-trading-mcp`)
- **API server**: `agent/api_server.py` — FastAPI on port 8899, SSE streaming
- **Agent core**: `agent/src/agent/` — LangGraph ReAct agent loop
- **Skills**: `agent/src/skills/` — 70+ domain skills (technical analysis, market data, strategy, research, crypto, backtesting)
- **Backtesting**: `agent/backtest/` — runner, metrics, engines (China A/futures, crypto, forex, global equity/futures), loaders, optimizers
- **Swarm**: `agent/src/swarm/` — multi-agent orchestration with presets, token tracking, trust model
- **Live trading**: `agent/src/live/` — runtime scheduler, mandate enforcement, order gate, halt, audit ledger
- **Data providers**: `agent/src/providers/` — market data abstraction (ccxt, yfinance, akshare, tushare, etc.)
- **Shadow account**: `agent/src/shadow_account/` — paper trading simulation with HTML/PDF reports

### Frontend Key Paths

- **State**: single Zustand store at `src/stores/agent.ts`
- **Streaming**: `src/hooks/useSSE.ts` (Server-Sent Events for agent responses)
- **API layer**: `src/lib/api.ts`, `src/lib/apiAuth.ts`
- **Routes** (lazy-loaded, see `frontend/src/router.tsx`): `/` Home, `/agent` Chat, `/runtime` (desktop runtime settings), `/settings`, `/runs/:runId`, `/compare`, `/correlation`, `/alpha-zoo` (+ `/bench`, `/compare`, `/:alphaId` sub-routes)
- **Components**: `components/chat/` (chat UI, message bubbles, tool progress), `components/charts/` (ECharts candlestick/equity/correlation), `components/common/`, `components/layout/`
- **Path alias**: `@/*` → `./src/*`

### Tauri Shell Key Paths

- `src-tauri/src/main.rs` — entry point and module declarations (`mod resources; mod version; mod runtime_dir; mod port; mod sidecar;`), Tauri builder setup, webview + sidecar lifecycle
- `src-tauri/src/sidecar.rs` — Python sidecar spawning, health polling, process lifecycle
- `src-tauri/src/resources.rs` — bundled resource resolution, first-run setup
- `src-tauri/src/runtime_dir.rs` — `~/.vibe-trading/runtime/` directory management
- `src-tauri/src/port.rs` — free port detection
- `src-tauri/src/version.rs` — version comparison for upgrade detection
- `src-tauri/tauri.conf.json` — bundle config (`identifier: ai.vibetrading.desktop`); `bundle.resources` wires `.desktop-build/python-runtime`, `.desktop-build/agent`, `frontend/dist` into the app

## High-Risk Surfaces (Safety-Critical)

These code paths are safety-critical even when changes appear small. Always run the narrow safety tests:

- **Order gate**: `agent/src/live/order_gate.py` — mandate-gated, kill-switch-aware, fail-closed
- **Mandate enforcement**: `agent/src/live/mandate.py`
- **Kill switch / halt**: `agent/src/live/halt.py`
- **Audit ledger**: `agent/src/live/audit_ledger.py`
- **Broker connectors**: any file under `agent/src/live/` touching broker writes

Never run live trading, payment, wallet, contract, or broker-write flows as part of routine PR validation. See `AGENT_CONTRIBUTOR_GUIDE.md` for full safety rules.

## Lint & Style

- **Python**: Ruff (`select = ["E", "F", "W"]`, ignore `E501`, line-length 120, target py311). Config in `pyproject.toml`.
- **Frontend**: TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`). Build runs `tsc -b` before Vite.
- **Commits**: Community commits require DCO `Signed-off-by:` trailer (`git commit -s`). No AI-assistant attribution trailers.

## Proxy Routes (Dev Server)

Vite dev server (`:5899`) proxies these paths to the backend (`:8899`): `/sessions`, `/swarm/presets`, `/swarm/runs`, `/settings/llm`, `/settings/data-sources`, `/mandate`, `/live`, `/upload`, `/shadow-reports`, `/runs`, `/correlation`, `/alpha`.

## Docker

```bash
docker compose up vibe-trading                  # API only on :8899
docker compose --profile frontend up            # API + Vite dev frontend on :5899
```

## Environment Configuration

`agent/.env.example` documents 13+ LLM provider configs (OpenRouter, OpenAI, DeepSeek, Gemini, Groq, DashScope, Zhipu, Moonshot, MiniMax, Xiaomi MIMO, Z.ai, Ollama) and data source configs (Tushare, yfinance, ccxt, Futu). API deployments beyond loopback require `API_AUTH_KEY`.
