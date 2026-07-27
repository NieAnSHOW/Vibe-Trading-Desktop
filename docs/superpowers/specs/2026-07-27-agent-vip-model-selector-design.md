# Agent VIP Model Selector

## Goal

Replace the browser-native VIP model `<select>` in the Agent composer with a
compact, Codex-inspired trigger and an upward-opening model menu. The change
only affects model selection; it does not add reasoning-strength controls or
other runtime settings.

## Layout

- The selector stays in the composer action row between the existing `+` menu
  and the textarea, retaining the current eligibility condition.
- Its trigger is a compact muted pill that displays the selected model and a
  downward chevron. Long names truncate rather than changing the action row's
  layout.
- Clicking the trigger opens a surfaced menu immediately above the composer.
  The menu has a bounded width and height, its contents scroll when needed,
  and each model occupies a full-width selectable row.
- The active model is visibly distinguished with a trailing check icon. The
  implementation uses existing color, border, shadow, and dark-mode tokens;
  it does not introduce a separate theme.

## Interaction

- The menu opens only while the existing VIP model-selector condition is true.
- Selecting a different model closes the menu and invokes the existing
  `updateVIPModel` request. Selecting the current model simply closes the menu
  and returns focus to the composer.
- While a model update is pending or the agent is streaming, the trigger and
  rows are unavailable. The trigger communicates pending work with the
  existing loader affordance without moving surrounding controls.
- A click outside the selector or `Escape` closes the menu. The trigger exposes
  appropriate expanded and control relationships for assistive technology;
  list items remain keyboard reachable.
- Existing error toast behavior and refocusing of the composer after the
  request completes remain unchanged.

## Implementation Boundary

- Keep the state and event handling local to `frontend/src/pages/Agent.tsx`.
- Reuse the page's existing ref-driven outside-click pattern and Lucide icons.
- Do not alter model availability rules, API payloads, translated strings,
  message submission, or other composer controls.

## Verification

- Add or adapt focused Agent-page tests for opening and closing the menu,
  selecting a model, and preserving the loading/streaming disabled behavior.
- Run the focused frontend tests and `npm run build`.
- Inspect desktop and narrow layouts to confirm the menu opens upward, is not
  clipped, and does not overlap the textarea or send action.
