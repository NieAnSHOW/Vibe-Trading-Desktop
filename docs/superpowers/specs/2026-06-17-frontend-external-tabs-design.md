# Frontend External Tabs Design

## Context

Vibe Trading Desktop currently renders a single React Web UI inside the Tauri main webview. The existing left sidebar in `frontend/src/components/layout/Layout.tsx` is part of that Web UI and should not appear as shared navigation for external websites.

The goal is to add a top-level tab experience in the current frontend architecture. The first tab remains the existing Web UI. A second tab shows common external-site shortcuts. Clicking a shortcut opens a new top-level tab that attempts to load the site inline.

## Decision

Implement external site tabs entirely in the React frontend.

External sites will load through `iframe` elements. This keeps the implementation inside the current `Layout.tsx` architecture and avoids the instability of managing multiple native Tauri webviews. Login state and cache persistence are best-effort: sites that allow iframe embedding and browser-managed storage can preserve their state through the current Tauri main webview profile; sites that block embedding or third-party cookie flows will fall back to an external-open action.

## Layout

The top-level layout becomes:

- Desktop tab bar at the top of `Layout.tsx`.
- `Web UI` tab renders the existing sidebar, connection banner, and `<Outlet />`.
- `Shortcuts` tab renders a grid of common external-site shortcuts and does not show the Web UI sidebar.
- External-site tabs render an iframe-focused view and do not show the Web UI sidebar.

This preserves the boundary that the left sidebar belongs only to the Web UI.

## Shortcut And Tab Behavior

The initial shortcuts list is static in the frontend. Each shortcut has:

- id
- label
- url
- icon

Clicking a shortcut opens or activates a tab for that site. Tabs can be closed except for the fixed `Web UI` and `Shortcuts` tabs. The active tab is held in React state. Site tabs remain mounted while open so their iframe state is not lost when switching tabs.

## External Site Rendering

Each external tab shows:

- tab title
- URL display
- refresh action
- external-open action
- iframe content
- fallback copy for sites that cannot be embedded

The iframe uses the site URL directly. The implementation will not attempt to bypass `X-Frame-Options`, CSP `frame-ancestors`, third-party cookie restrictions, OAuth popup behavior, or other browser security controls.

## Error Handling

Frontend code cannot reliably detect every iframe-blocking case because browser frame-denial behavior is intentionally constrained. The UI should still provide an always-visible external-open action and lightweight helper text so users can recover when a site fails to render or login does not complete.

## Out Of Scope

- Tauri-managed multi-webview tab system
- Browser-like native WebView lifecycle management
- Proxying or rewriting external websites
- wujie/micro-frontend integration
- User-editable shortcut management
- Guaranteed login persistence for arbitrary external sites

## Testing

Add focused frontend tests around:

- fixed Web UI and Shortcuts tabs
- opening an external tab from a shortcut
- switching back to Web UI restores the existing layout
- closing an external tab returns to a stable remaining tab

Run the frontend test suite and build/typecheck path used by the project.
