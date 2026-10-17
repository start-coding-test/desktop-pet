mod commands;
mod fsutil;
mod gate;
#[cfg(test)]
mod gate_coverage;
mod host_error;
mod ids;
mod plugin_caps;
mod services;
mod window;

use services::{
    agent::AgentState, ble::BleState, http::HttpState, permission::PermissionState,
    store::StoreState,
};
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 卸载应用前的清理分支（NSIS 的 NSIS_HOOK_PREUNINSTALL 调它）。分流必须和下面的 hook
    // 分支一样排在建窗与单实例锁之前，否则会被转给已运行的实例、这次清理根本不发生；
    // 而且它永不返回非零退出码 —— 清理失败不能拦住卸载。
    if std::env::args().any(|arg| arg == "--pet-hook-cleanup") {
        services::agent::linkage::run_cleanup_cli();
        return;
    }

    // Agent hook 的接收分支必须排在一切之前：它只把 stdin 落到一个文件就退出。
    // 走完整启动流程不仅慢，还会被下面的单实例插件把参数转发给已运行的实例，
    // 于是 stdin 与这次事件一起丢掉。
    //
    // Rejected 分支单独存在是因为它绝不能掉到下面的启动流程里：一次写坏的 hook 条目
    // （未知 phase 或未知 --agent）要是继续往下走，就会在用户的桌面上把 GUI 拉起来。
    match services::agent::hook_phase_from_args(&mut std::env::args()) {
        services::agent::phases::HookArgs::NotForUs => {}
        services::agent::phases::HookArgs::Rejected(why) => {
            eprintln!("desktop-pet: 忽略一次 --pet-hook 调用（{why}），不采集也不启动应用");
            return;
        }
        services::agent::phases::HookArgs::Event(cmd) => {
            services::agent::hook_ingest(cmd.phase, cmd.agent);
            return;
        }
    }

    // 插件与形象的文件协议必须在窗口创建前注册
    let builder = services::skins::register_skin_protocol(
        commands::plugins::register_plugin_protocol(tauri::Builder::default()),
    );
    builder
        // 单实例必须最先注册：重复启动时唤起已有宠物窗
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(pet) = app.get_webview_window("pet") {
                let _ = pet.show();
                let _ = pet.unminimize();
                let _ = pet.set_focus();
            }
        }))
        // 宿主侧日志：此前所有失败都被 `let _ =` 吞掉，出错时毫无线索
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("host".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        // 系统通知：只给宿主 Rust 侧调用，插件必须经 notify_show 的授权检查
        .plugin(tauri_plugin_notification::init())
        // 开机自启（HKCU 的 Run 键），由设置窗的 autostart_set 驱动
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // 全局快捷键：按下就唤出插件页（设置窗）。键本身由 services::hotkeys 管
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state == ShortcutState::Pressed {
                        window::tray::open_settings(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            app.manage(StoreState::new());
            app.manage(PermissionState::new());
            app.manage(BleState::new());
            app.manage(HttpState::new());
            app.manage(Arc::new(AgentState::default()));
            app.state::<StoreState>().init(app.handle())?;
            app.state::<PermissionState>().init(app.handle())?;
            // 启停联动的现状在这里对齐：先补写老用户的显式选择，再按「联动已关」摘残余。
            // 开着的时候不重装（顺序判据见 services/agent/linkage.rs）。
            services::agent::linkage::startup(app.handle());
            window::pet::setup(app.handle())?;
            window::tray::setup(app.handle())?;
            // watcher 被 drop 就停止监听，所以必须交给 app state 长期持有
            let watcher = commands::plugins::spawn_plugins_watcher(app.handle())?;
            app.manage(std::sync::Mutex::new(watcher));
            let agent_watcher = services::agent::spawn_agent_watcher(app.handle())?;
            app.manage(std::sync::Mutex::new(agent_watcher));
            services::agent::start_agent_ticker(app.handle());
            services::fullscreen::start(app.handle());
            // 恢复用户上次选的加速键（失败会退回默认值，保证插件页叫得出来）
            services::hotkeys::restore(app.handle());
            // 首启且本地什么都没有时自动装默认形象（后台跑，离线只留一条 warn）
            services::skins::ensure_default(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window::pet::set_click_through,
            window::pet::set_pet_hidden,
            window::tray::settings_show,
            window::overlay::overlay_show,
            window::overlay::overlay_hide,
            window::overlay::overlay_destroy,
            window::overlay::overlay_reclaim,
            window::overlay::overlay_list,
            window::overlay::overlay_owner,
            commands::plugins::plugins_list,
            commands::plugins::plugin_file_version,
            commands::agent::agent_hooks_status,
            commands::agent::agent_hooks_install,
            commands::agent::agent_hooks_uninstall,
            services::fullscreen::fullscreen_watch_set,
            services::fullscreen::fullscreen_watch_status,
            services::fullscreen::fullscreen_probe,
            commands::bus::bus_publish,
            commands::bus::bus_peek,
            services::skins::pet_skin_active,
            services::skins::pet_skin_list,
            services::skins::pet_skin_install,
            services::skins::pet_skin_use,
            services::skins::pet_skin_remove,
            services::autostart::autostart_status,
            services::autostart::autostart_set,
            services::enabled::plugin_enabled_list,
            services::enabled::plugin_enabled_set,
            services::enabled::plugin_enabled_migrate,
            services::hotkeys::hotkey_status,
            services::hotkeys::hotkey_set,
            services::hotkeys::hotkey_test,
            services::store::store_get,
            services::store::store_set,
            services::store::store_delete,
            services::http::http_request,
            services::notify::notify_show,
            services::permission::permission_check,
            services::permission::permission_request,
            services::permission::consent_details,
            services::permission::consent_answer,
            services::permission::permission_list,
            services::permission::permission_revoke,
            services::ble::ble_start_scan,
            services::ble::ble_stop_scan,
            services::ble::ble_connect,
            services::ble::ble_disconnect,
            services::ble::ble_connected_device
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
