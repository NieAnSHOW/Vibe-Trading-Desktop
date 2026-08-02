# Windows Window and Icon Design

## Scope

Update the Windows native title bar (the area containing minimize, maximize,
and close controls) and the Windows application icon embedded in the Tauri
bundle. Keep the console application's CSS theme and non-Windows icon assets
unchanged.

## Native Title Bar

Use the Windows DWM `DWMWA_CAPTION_COLOR` attribute to set the native title
bar to `#323d43`, and set its title text to white for contrast. Apply this
only to the main window on Windows; the console page and other platforms are
unchanged. Keep the Tauri `backgroundColor` startup fallback as well.

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
