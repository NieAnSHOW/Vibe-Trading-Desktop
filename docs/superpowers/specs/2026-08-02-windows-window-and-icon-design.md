# Windows Window and Icon Design

## Scope

Update only the Windows native window's launch background and the Windows
application icon embedded in the Tauri bundle. The console application's CSS
theme and non-Windows icon assets remain unchanged.

## Native Window Background

Set the Tauri main window `backgroundColor` to `#323d43`. This color is shown
by Windows while the webview initializes, preventing the current dark launch
flash. It does not override the rendered console page background after load.

## Windows Icon

Keep the existing Trading Worker mark and dark rounded-square background so
the product remains recognizable. Regenerate `src-tauri/icons/icon.ico` from
that master asset with Windows target sizes: 16, 20, 24, 30, 32, 36, 40, 48,
60, 64, 72, 80, 96, and 256 pixels.

For 16 through 48 pixels, apply a modest optical crop before resampling so the
white mark remains legible in the title bar, taskbar, and Start menu. Larger
sizes preserve the full master composition. The ICO remains the single icon
file used by the Tauri Windows bundle.

## Verification

Inspect the generated ICO for every required size and transparency, then run
the Tauri configuration validation/build command available in this repository.
