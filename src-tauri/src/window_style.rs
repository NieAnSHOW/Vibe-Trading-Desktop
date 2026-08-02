const WINDOWS_TITLEBAR_RGB: (u8, u8, u8) = (0x32, 0x3d, 0x43);

/// Convert the CSS-style RGB tuple to the Win32 COLORREF byte order (0x00BBGGRR).
pub const fn windows_titlebar_colorref() -> u32 {
    (WINDOWS_TITLEBAR_RGB.0 as u32)
        | ((WINDOWS_TITLEBAR_RGB.1 as u32) << 8)
        | ((WINDOWS_TITLEBAR_RGB.2 as u32) << 16)
}

#[cfg(target_os = "windows")]
pub fn apply_windows_titlebar_color(hwnd: isize) -> Result<(), String> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };

    let hwnd = hwnd as HWND;
    let caption_color = windows_titlebar_colorref();
    let text_color = 0x00FF_FFFF_u32;

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

#[cfg(not(target_os = "windows"))]
pub fn apply_windows_titlebar_color(_hwnd: isize) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::windows_titlebar_colorref;

    #[test]
    fn windows_titlebar_color_uses_rgb_colorref_order() {
        assert_eq!(windows_titlebar_colorref(), 0x0043_3d_32);
    }
}
