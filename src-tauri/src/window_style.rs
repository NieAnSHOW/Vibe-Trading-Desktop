// 仅 Windows 需要:让原生窗口(背景 + 标题栏)跟随应用浅/深主题,
// 颜色与 console-app 的 --rail-background 保持一致(亮 #f3f4f7 / 暗 #08090d)。
#![cfg(target_os = "windows")]

/// 窗口与标题栏底色:浅色主题(console-app 亮色 --rail-background)。
const LIGHT_WINDOW_RGB: (u8, u8, u8) = (0xf3, 0xf4, 0xf7);
/// 窗口与标题栏底色:深色主题(console-app 暗色 --rail-background)。
const DARK_WINDOW_RGB: (u8, u8, u8) = (0x08, 0x09, 0x0d);
/// 标题文字:浅色主题取亮色 --ink(hsl(220 18% 16%) ≈ #212630)。
const LIGHT_CAPTION_TEXT_RGB: (u8, u8, u8) = (0x21, 0x26, 0x30);
/// 标题文字:深色主题用白。
const DARK_CAPTION_TEXT_RGB: (u8, u8, u8) = (0xff, 0xff, 0xff);

/// Convert the CSS-style RGB tuple to the Win32 COLORREF byte order (0x00BBGGRR).
pub const fn windows_colorref(rgb: (u8, u8, u8)) -> u32 {
    (rgb.0 as u32) | ((rgb.1 as u32) << 8) | ((rgb.2 as u32) << 16)
}

/// theme_mode(system/light/dark)+ 系统当前深浅 → 窗口是否用深色。
/// 未知模式按浅色处理,与 settings 默认 light 一致。
pub fn effective_dark(theme_mode: &str, system_dark: bool) -> bool {
    match theme_mode {
        "dark" => true,
        "system" => system_dark,
        _ => false,
    }
}

/// 把窗口背景与标题栏一并切到对应主题配色。
pub fn apply_window_theme(win: &tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    let rgb = if dark {
        DARK_WINDOW_RGB
    } else {
        LIGHT_WINDOW_RGB
    };
    win.set_background_color(Some(tauri::window::Color::from(rgb)))
        .map_err(|e| format!("set_background_color: {e}"))?;
    let hwnd = win.hwnd().map_err(|e| format!("hwnd: {e}"))?;
    apply_windows_titlebar_color(hwnd.0 as isize, dark)
}

pub fn apply_windows_titlebar_color(hwnd: isize, dark: bool) -> Result<(), String> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };

    let hwnd = hwnd as HWND;
    let caption_rgb = if dark {
        DARK_WINDOW_RGB
    } else {
        LIGHT_WINDOW_RGB
    };
    let caption_color = windows_colorref(caption_rgb);
    let text_color = windows_colorref(if dark {
        DARK_CAPTION_TEXT_RGB
    } else {
        LIGHT_CAPTION_TEXT_RGB
    });

    for (attribute, color) in [
        (DWMWA_CAPTION_COLOR, caption_color),
        (DWMWA_TEXT_COLOR, text_color),
    ] {
        let status = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute as u32,
                (&color as *const u32).cast(),
                size_of::<u32>() as u32,
            )
        };
        if status < 0 {
            return Err(format!("DwmSetWindowAttribute({attribute}) failed: HRESULT 0x{status:08X}"));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_colorref_uses_bgr_byte_order() {
        // #ff0000(红)在 COLORREF 里是 0x000000FF。
        assert_eq!(windows_colorref((0xff, 0x00, 0x00)), 0x0000_00ff);
        // #323d43 → 0x00433D32,证明 R 在最低位、B 在最高位。
        assert_eq!(windows_colorref((0x32, 0x3d, 0x43)), 0x0043_3d_32);
    }

    #[test]
    fn window_palette_matches_console_rail_background() {
        assert_eq!(LIGHT_WINDOW_RGB, (0xf3, 0xf4, 0xf7));
        assert_eq!(DARK_WINDOW_RGB, (0x08, 0x09, 0x0d));
    }

    #[test]
    fn effective_dark_follows_mode_and_system() {
        assert!(effective_dark("dark", false));
        assert!(!effective_dark("light", true));
        assert!(effective_dark("system", true));
        assert!(!effective_dark("system", false));
        // 未知模式回退浅色,与 settings 默认一致。
        assert!(!effective_dark("broken", true));
    }
}
