# Desktop Console Full-Width Shell Design

## Goal

Refactor the Tauri console's native-page shell so every route rendered beside
`Rail` owns the same viewport width as the embedded WebUI iframe. The console
must use the Trading Worker design-system foundation without changing service,
navigation, theme, or cross-document transition behavior.

## Scope

- Update the `App.vue` shell layout for routes that render the fixed Rail.
- Move viewport positioning and rail compensation out of the global `body`
  layout rule and into the shell.
- Preserve route-local content spacing and responsive behavior.
- Align shell surfaces with Trading Worker tokens: restrained dark/light
  surfaces, low-contrast borders, and teal as the single brand emphasis.

No route logic, IPC command, iframe URL, Rail item, or runtime behavior changes
are part of this work.

## Layout Contract

The main native shell uses the following dimensions:

- Rail-present routes start at `var(--rail-width)` and have a width of
  `calc(100vw - var(--rail-width))`.
- The shell's minimum height is `100dvh`, matching `.desktop-webui-frame`.
- The embedded WebUI retains its existing fixed positioning and dimensions.
  The native shell and iframe therefore share the exact same available canvas.
- Rail-less standalone routes (`/` onboarding and `/login`) occupy `100vw`.
- Route pages retain their own internal max-width or grid constraints only
  where readability requires them. The shell itself never constrains content
  to the former 580px centered column.

## Visual Direction

Use the Trading Worker desktop foundation: near-black-blue (or the existing
light-mode equivalent) canvas, subtle boundaries, system sans-serif for
controls, and the existing teal brand token for the current/ready focus. No
additional gradients, glow effects, or decorative panels are introduced.

The existing theme event bridge continues to synchronize the retained iframe.
Page and shell transition timing, including reduced-motion behavior, remains
unchanged.

## Implementation Boundaries

`src-tauri/console-app/src/App.vue` owns the outer native canvas and its
Rail-aware modifier classes. `src-tauri/console-app/src/styles/console.css`
provides neutral document defaults rather than global rail compensation.
Existing page components remain responsible for their content composition;
their widths are adjusted only when a fixed 580px rule prevents the agreed
full-width shell behavior.

## Verification

- Extend the App shell tests to assert Rail-aware and standalone width classes
  and the iframe/native-shell sizing contract.
- Run `npm run build` from `src-tauri/console-app`.
- Run the console test suite with `npm test -- --run` or the repository's
  equivalent Vitest invocation.
