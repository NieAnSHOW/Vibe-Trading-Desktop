# Desktop Console Reference Redesign

## Goal

Rework the desktop control console around the supplied wide-screen reference while preserving every existing runtime workflow. The page should feel calm and operational, use `#1caea2` as its primary accent, and remain useful without an authenticated account.

## Product Constraints

- Core local features remain available without login: dependency installation and repair, service start and stop, opening WebUI, channel status, progress, errors, and logs.
- Login only unlocks member services. The signed-out state must not occupy a large panel, block the main action, or imply that authentication is required.
- Preserve all existing Tauri IPC calls, event listeners, polling intervals, busy states, confirmation dialogs, advertising slots, update feedback, and error handling.
- Preserve the existing account profile route and settings route.
- Use WCAG 2.1 AA contrast, visible keyboard focus, and reduced-motion fallbacks.

## Layout

The default Tauri window becomes a resizable 1180 by 760 pixel console with a 900 by 680 pixel minimum. The page uses three structural bands:

1. A compact application header containing the logo, product name, tagline, account entry, WebUI shortcut, and settings entry.
2. A main two-column workspace. The wider left column contains the research-service state and primary workflow. The narrower right column contains optional membership information.
3. A full-width operational footer containing errors and the runtime log.

When the user is signed out, the membership column is removed and the primary service workspace spans the full available width. Below the 900 pixel desktop breakpoint, the authenticated membership column moves below the primary service workspace. Text and controls wrap without changing type size or overlapping.

## Primary Service Workspace

The left workspace is the visual and functional priority. It includes:

- A `研究服务` heading, one-line service status, and concise description.
- One contextual primary action:
  - install or repair dependencies when the environment is not ready;
  - start the service when the environment is ready and stopped;
  - open WebUI when the service is running.
- A secondary action area for stop service, force-clean environment, or other destructive maintenance. Existing confirmation dialogs remain authoritative.
- A three-part status strip for the runtime environment, research service, and message channels.
- The existing hint and bootstrap progress directly beneath the state they explain.

Busy actions remain visible and disabled while work is in progress. Bootstrap completion continues to be controlled by the exit event rather than the initial IPC resolution.

## Membership Workspace

Authenticated users receive a compact account and usage panel with account name, member tier, expiry, remaining or unlimited quota, usage details, refresh, and profile navigation. It should be visually secondary to the local service controls.

Signed-out users receive only a compact login action in the application header with short copy indicating that login is needed for member services. No membership panel or empty sidebar is rendered, so the local service workspace keeps the full page width and visual priority.

Member usage continues to cover loading, stale-data retention after a temporary failure, unlimited quota, and expired-login cleanup. No member request may interrupt the local runtime workflow.

## Supporting Content

- Update and login-success notices appear in a compact full-width notice area below the header. The existing login notice read from the route query must be rendered again.
- Banner advertising remains optional and is placed where it does not displace the primary service action. Bottom advertising remains above the log footer.
- Runtime errors appear immediately before the log so the diagnostic context stays together.
- The log becomes a full-width bottom band with the existing open-directory, clear-files, and clear-view actions.
- Version information remains visible without covering logs or ads.

## Visual System

- Use deep neutral surfaces tinted slightly toward the brand hue, not a saturated terminal-black or blue fintech palette.
- Use exact brand teal `#1caea2` for the primary action, focus rings, selected states, and critical healthy-state emphasis. Do not use it as decoration across inactive surfaces.
- Preserve green, amber, and red for success, warning, and danger states.
- Use the existing system sans-serif stack and compact product typography.
- Keep panel radii at 12 pixels or less. Avoid nested cards, glass effects, wide shadows, gradient text, and decorative animation.
- State transitions use 150 to 250 millisecond easing and respect `prefers-reduced-motion`.

## Component and Data Boundaries

`ConsolePage.vue` continues to own orchestration and state selection. Existing `AppButton`, `StatusBadge`, `ProgressBar`, `HintBanner`, `ConfirmDialog`, `AdSlot`, `UpdateBanner`, `LogViewer`, and `VersionFooter` public contracts remain unchanged.

The redesign adds computed presentation values for the contextual primary action and remaining usage percentage, without duplicating store state or changing backend payloads. Tauri window geometry is configured in `src-tauri/tauri.conf.json`; responsive behavior remains CSS-driven.

## Error and Edge States

- Environment detection, incomplete environment, missing environment, ready-but-stopped, starting, running, stopping, and bootstrap failure must remain distinguishable.
- Long account names, tier names, expiry strings, errors, and log lines truncate or wrap within their containers.
- The page must remain coherent with login disabled, advertising disabled, missing usage data, unlimited usage, and no log output.
- The hidden hint must continue to use an explicit CSS rule so its flex display does not override the native `hidden` attribute.
- All Tauri listeners and polling timers must still be removed on unmount.

## Validation

- Update focused Vue tests for the contextual actions, compact signed-out state, member usage states, profile/settings navigation, and restored login notice.
- Run the console Vitest suite, Vue type checking, and production build.
- Run relevant Rust configuration tests after changing the Tauri window definition.
- Inspect the real Tauri window at the default size and minimum size. Cover signed out, authenticated finite quota, unlimited quota, environment not ready, service starting/running/stopped, bootstrap progress/failure, long errors, empty/populated logs, and enabled/disabled advertising.
- Use screenshots for both desktop two-column and narrow single-column layouts and check that no text, buttons, dialogs, ads, logs, or version text overlap.
