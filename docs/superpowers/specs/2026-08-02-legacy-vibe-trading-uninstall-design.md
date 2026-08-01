# Legacy Vibe Trading Uninstall Design

## Goal

Add a Settings page action that removes the legacy `Vibe Trading` desktop application on Windows and macOS without deleting the current user's Vibe Trading data.

## Scope

- Add a confirmed Settings page action labelled `Vibe Trading`.
- Add a Tauri IPC command, `console_uninstall_legacy_app`.
- Windows: resolve the current user's Local AppData directory and launch `Vibe Trading\\uninstall.exe`, allowing the NSIS uninstaller to handle its own cleanup and permissions.
- macOS: remove only the legacy app bundle from `/Applications/Vibe Trading.app` or `~/Applications/Vibe Trading.app`.
- Preserve `~/.vibe-trading` and all other user data on both platforms.
- Keep the current `Trading Worker` application running after the legacy uninstall is started/completed.

## Interaction and Error Handling

The Settings page shows the action in the maintenance area. Clicking it opens the existing `ConfirmDialog`; cancellation has no side effects. Confirmation runs through the existing busy-state helper, stops the current sidecar first when necessary, invokes the Rust command, and renders a success or error notice. A missing legacy installation is reported as an error rather than silently deleting another path.

The Rust command uses fixed, platform-specific candidate paths and never accepts a filesystem path from the frontend. Windows launches the discovered NSIS uninstaller and does not recursively delete the install directory. macOS only removes a candidate whose exact basename is `Vibe Trading.app`.

## Testing

- Rust unit tests cover platform path selection and the missing-installation/error behavior without touching real user directories.
- Vue tests cover rendering the action, confirmation gating, stopping a running service before invocation, invoking the IPC command, and displaying failures.
- Run the console-app test suite and Rust tests before completion.
