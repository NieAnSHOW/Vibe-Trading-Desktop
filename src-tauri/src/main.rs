// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod port;
mod resources;
mod version;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            match resources::Resources::resolve(&app.handle().clone()) {
                Ok(r) => {
                    println!("Resources resolved:");
                    println!("  python: {}", r.runtime_python.display());
                    println!("  agent:  {}", r.agent_template.display());
                    println!("  env:    {}", r.env_seed.display());
                    println!("  html:   {}", r.loading_html.display());
                    println!("  ver:    {}", r.version_file.display());
                }
                Err(e) => eprintln!("Resource resolution failed: {e}"),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
