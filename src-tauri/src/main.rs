#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod resources; mod version; mod runtime_dir; mod port; mod sidecar;

use std::sync::{Arc, Mutex};
use std::process::Child;
use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

type SharedChild = Arc<Mutex<Option<Child>>>;

fn main() {
    let shared: SharedChild = Arc::new(Mutex::new(None));
    let shared_setup = shared.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            // D3: 窗口先开,加载本地 loading.html(打包资源)
            let res = resources::Resources::resolve(&handle)
                .map_err(|e| format!("resources: {e}"))?;
            let win = WebviewWindowBuilder::new(
                &handle, "main",
                WebviewUrl::App("loading.html".into()))
                .title("Vibe Trading").inner_size(1280.0, 832.0).build()?;

            let shared = shared_setup.clone();
            std::thread::spawn(move || {
                if let Err(msg) = boot(&handle, &win, &res, &shared) {
                    let safe = msg.replace('`', "'").replace('\\', "\\\\");
                    let _ = win.eval(&format!(
                        "document.getElementById('spin').style.display='none';\
                         document.getElementById('msg').textContent='启动失败';\
                         var e=document.getElementById('err');e.style.display='block';\
                         e.textContent=`{safe}`;\
                         var q=document.getElementById('quit');q.style.display='block';\
                         q.onclick=function(){{window.__TAURI__.process.exit(1)}};"));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build tauri app")
        .run(move |_app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(mut child) = shared.lock().unwrap().take() {
                    sidecar::terminate(&mut child);
                }
            }
        });
}

fn boot(
    _handle: &tauri::AppHandle,
    win: &tauri::WebviewWindow,
    res: &resources::Resources,
    shared: &SharedChild,
) -> Result<(), String> {
    // D4/D5: 准备可写运行目录
    let layout = runtime_dir::Layout::from_home()?;
    runtime_dir::prepare(&res.agent_template, &res.env_seed, &res.version_file, &layout)?;
    // D6: 选端口
    let p = port::pick_free_port()?;
    // D7: 启动 sidecar(PYTHONPATH 指向可写副本)
    let mut child = sidecar::spawn(&res.runtime_python, &layout.runtime_agent, p)?;
    // D8: 门控
    match sidecar::await_health(&mut child, p) {
        sidecar::Ready::Ok => {
            shared.lock().unwrap().replace(child);
            // Tauri 2 navigate 接受 Url 类型
            let target = format!("http://127.0.0.1:{p}/");
            win.navigate(tauri::Url::parse(&target).map_err(|e| format!("parse url: {e}"))?)
                .map_err(|e| format!("navigate: {e}"))?;
            Ok(())
        }
        sidecar::Ready::ProcessExited(code) =>
            Err(format!("后端进程提前退出(退出码 {code:?})。请检查依赖与配置。")),
        sidecar::Ready::Timeout =>
            Err("后端在 60 秒内未就绪(健康检查超时)。".into()),
    }
}
