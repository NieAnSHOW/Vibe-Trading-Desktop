//! 系统托盘 —— 后台挂载模式下的恢复/退出入口。
//!
//! 窗口关闭按钮 X 不再退出应用,而是把主窗口静默收纳到后台(见 main.rs 的
//! CloseRequested 处理)。此时托盘图标是唯一的可见入口:
//! - 左键点击托盘图标 → 唤回并聚焦主窗口
//! - 菜单「打开主界面」 → 唤回并聚焦主窗口
//! - 菜单「返回控制台」 → 主窗口从内嵌 WebUI 退回控制台页(未嵌入时 no-op)
//! - 菜单「退出」 → 空闲时直接退出;服务运行中 / 依赖安装中时,先唤回窗口
//!   让前端弹二次确认框(确认后前端调 console_quit 真正退出)。
//!   内嵌态下控制台页已被替换,确认事件改为导航回控制台后由
//!   main.rs 的 on_page_load 补发(见 webui_embed)。
//!
//! 退出决策抽成纯函数 `decide_quit`(可 cargo 测);Tauri 回调是薄壳(设计 D3)。

use std::sync::atomic::Ordering;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::console::{self, InstallingFlag, SharedChild, QUIT_REQUESTED_EVENT};

/// 托盘「退出」的决策。空闲则立即退出;有活跃工作(服务运行 / 安装中)则先请前端确认。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitDecision {
    /// 无活跃工作,直接退出应用。
    ExitNow,
    /// 有活跃工作,先唤回窗口让前端弹二次确认框。
    ConfirmFirst,
}

/// 依据当前运行态决定托盘「退出」的行为。纯函数,便于单测覆盖三态。
pub fn decide_quit(service_running: bool, installing: bool) -> QuitDecision {
    if console::needs_quit_confirmation(service_running, installing) {
        QuitDecision::ConfirmFirst
    } else {
        QuitDecision::ExitNow
    }
}

/// 唤回并聚焦主窗口(从后台收纳态恢复)。窗口不存在时静默跳过。
/// pub：单实例回调（main.rs）与托盘事件均需调用。
pub fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 读取当前运行态,执行托盘「退出」:空闲直接 exit,否则唤回窗口 + emit 让前端确认。
/// 嵌入态(主窗口停在 WebUI,控制台页已被替换)下事件无人监听——先带回
/// 控制台并挂起确认标记,由 main.rs 的 on_page_load 在页面加载完成后补发。
fn handle_quit(app: &AppHandle) {
    let service_running = app.state::<SharedChild>().lock().unwrap().is_some();
    let installing = app.state::<InstallingFlag>().0.load(Ordering::SeqCst);
    let embedded = app
        .state::<crate::webui_embed::WebuiEmbedState>()
        .is_embedded();
    match decide_quit(service_running, installing) {
        // app.exit(0) 触发 RunEvent::ExitRequested,由 main.rs 在那里回收 sidecar 进程组。
        QuitDecision::ExitNow => app.exit(0),
        QuitDecision::ConfirmFirst => {
            if embedded {
                // 嵌入态:控制台页已被 WebUI 替换,事件无人监听。先带回控制台
                // 并挂起确认标记,on_page_load 在页面加载完成后补发。
                app.state::<crate::webui_embed::WebuiEmbedState>()
                    .set_quit_pending();
                crate::webui_embed::return_to_console(app);
            } else {
                let _ = app.emit(
                    QUIT_REQUESTED_EVENT,
                    serde_json::json!({
                        "service_running": service_running,
                        "installing": installing,
                    }),
                );
            }
            show_main_window(app); // 确认框须在可见窗口里显示
        }
    }
}

/// 构建系统托盘图标 + 菜单并安装。在 Tauri setup 阶段调用一次。
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open_i = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
    // 主窗口内嵌 WebUI 后,控制台(启停/修复/登录/设置)只能从托盘回去。
    let console_i = MenuItem::with_id(app, "console", "返回控制台", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_i, &console_i, &quit_i])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Trading Worker")
        .menu(&menu)
        // 左键留给「唤回窗口」(on_tray_icon_event),右键才出菜单——契合“右击后台图标退出”。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "console" => {
                crate::webui_embed::return_to_console(app);
                show_main_window(app);
            }
            "quit" => handle_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 只认左键抬起的单击,避免 down/up 触发两次(与官方 system-tray 示例一致)。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // release 下 default_window_icon 来自 bundle.icon;取不到也不阻断托盘创建。
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decide_quit_exits_when_idle() {
        assert_eq!(decide_quit(false, false), QuitDecision::ExitNow);
    }

    #[test]
    fn decide_quit_confirms_when_service_running() {
        assert_eq!(decide_quit(true, false), QuitDecision::ConfirmFirst);
    }

    #[test]
    fn decide_quit_confirms_when_installing() {
        assert_eq!(decide_quit(false, true), QuitDecision::ConfirmFirst);
    }

    #[test]
    fn decide_quit_confirms_when_both_active() {
        assert_eq!(decide_quit(true, true), QuitDecision::ConfirmFirst);
    }
}
