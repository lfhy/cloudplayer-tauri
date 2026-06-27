mod commands;
mod config;
mod global_hotkeys;
mod logging;
mod db;
mod download;
mod download_meta;
mod import_enrich;
mod import_playlist;
mod lrc_format;
mod lrc_embedded;
mod lddc_parse;
mod lyrics;
mod qrc_des;
mod lyric_qq;
mod lyric_kugou;
mod lyric_replace;
pub mod music_catalog;
mod rate_limiter;
mod share_link;

#[cfg(target_os = "android")]
use crate::config::init_android_storage;

#[cfg(desktop)]
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[cfg(desktop)]
use tauri::Emitter;
use tauri::Manager;
#[cfg(desktop)]
use tauri::WindowEvent;

#[cfg(desktop)]
use tauri::menu::{MenuBuilder, MenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

#[cfg(desktop)]
use crate::config::Settings;
#[cfg(desktop)]
use crate::global_hotkeys::{dispatch_shortcut, HotkeyShortcutMap};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::install_panic_hook();

    // 移动端不能出现 `Option<HotkeyShortcutMap>`：该类型未导入且全局快捷键仅桌面存在。
    #[cfg(desktop)]
    let hotkey_map = HotkeyShortcutMap::default();
    #[cfg(desktop)]
    let hotkey_for_handler = hotkey_map.clone();
    #[cfg(desktop)]
    let desktop_hotkey_map = hotkey_map;

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    dispatch_shortcut(app, shortcut, event, &hotkey_for_handler);
                })
                .build(),
        );
    }

    builder
        .on_window_event(|window, _event| {
            if window.label() != "main" {
                return;
            }
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = _event {
                api.prevent_close();
                let _ = window.emit("main-close-requested", ());
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "android")]
            {
                init_android_storage(app)?;
            }

            if let Err(e) = logging::init_from_app(app.handle()) {
                eprintln!("CloudPlayer: file logging init failed: {e}");
            }
            let conn = db::open_and_init().map_err(|e| format!("数据库初始化失败: {e}"))?;
            app.manage(db::DbState {
                conn: std::sync::Mutex::new(conn),
            });

            let mut client_builder = reqwest::Client::builder()
                .timeout(Duration::from_secs(45))
                .connect_timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::limited(10))
                // 部分站点在 HTTP/2 下偶发连接异常；与浏览器常见 HTTP/1.1 行为更一致。
                .http1_only()
                .cookie_store(true)
                .danger_accept_invalid_certs(true)
                .user_agent(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                );

            // 尝试使用系统代理（Windows 注册表），与浏览器行为一致。
            #[cfg(target_os = "windows")]
            {
                if let Ok(internet_settings) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
                    .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
                {
                    let proxy_enable: u32 = internet_settings.get_value("ProxyEnable").unwrap_or(0);
                    if proxy_enable != 0 {
                        if let Ok(proxy_server) = internet_settings.get_value::<String, _>("ProxyServer") {
                            let proxy_url = if proxy_server.contains("://") {
                                proxy_server
                            } else {
                                format!("http://{}", proxy_server)
                            };
                            if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
                                client_builder = client_builder.proxy(proxy);
                            }
                        }
                    }
                }
            }

            let client = client_builder
                .build()
                .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

            let (download_tx, mut download_rx) =
                tokio::sync::mpsc::channel::<download::DownloadJob>(64);
            let client_dl = client.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(job) = download_rx.recv().await {
                    download::run_one_job(client_dl.clone(), app_handle.clone(), job).await;
                }
            });

            app.manage(Arc::new(commands::AppState {
                client,
                limiter: Arc::new(rate_limiter::RateLimiter::new(45)),
                download_tx,
                catalog: Arc::new(music_catalog::CatalogService::new()),
            }));

            #[cfg(desktop)]
            {
                let cfg = Settings::load().global_hotkeys.clone();
                let _ = crate::global_hotkeys::apply_global_hotkeys_runtime(
                    app.handle(),
                    &cfg,
                    &desktop_hotkey_map,
                );
                app.manage(desktop_hotkey_map);
            }

            #[cfg(desktop)]
            {
                // 系统托盘：恢复 / 退出；左键单击显示主窗口（仅桌面）
                let tray_icon = app.default_window_icon().cloned().unwrap_or_else(|| {
                    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons/32x32.png");
                    tauri::image::Image::from_path(p).expect("load tray icon from icons/32x32.png")
                });
                let tray_menu = MenuBuilder::new(app)
                    .item(&MenuItem::with_id(
                        app,
                        "tray_show",
                        "显示主窗口",
                        true,
                        None::<&str>,
                    )?)
                    .item(&MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)?)
                    .build()?;
                let _tray = TrayIconBuilder::new()
                    .icon(tray_icon)
                    .menu(&tray_menu)
                    .tooltip("CloudPlayer")
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| {
                        if event.id == "tray_show" {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        } else if event.id == "tray_quit" {
                            app.exit(0);
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button,
                            button_state,
                            ..
                        } = event
                        {
                            if button == MouseButton::Left && button_state == MouseButtonState::Up {
                                let app = tray.app_handle();
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                            }
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings_cmd::get_settings,
            commands::settings_cmd::get_global_hotkeys,
            commands::settings_cmd::apply_global_hotkeys,
            commands::settings_cmd::validate_accelerator,
            commands::settings_cmd::get_default_download_dir,
            commands::settings_cmd::save_settings,
            commands::window_cmd::set_desktop_lyrics_click_through,
            commands::window_cmd::hide_main_window,
            commands::window_cmd::show_main_window,
            commands::window_cmd::quit_app,
            commands::search_cmd::search_songs,
            commands::search_cmd::get_preview_url,
            commands::search_cmd::cache_preview_for_play,
            commands::play_resolve_cmd::resolve_online_play,
            commands::playlist_cmd::list_playlists,
            commands::playlist_cmd::list_playlists_summary,
            commands::playlist_cmd::list_playlist_import_items,
            commands::playlist_cmd::create_playlist,
            commands::playlist_cmd::rename_playlist,
            commands::playlist_cmd::delete_playlist,
            commands::playlist_cmd::delete_playlist_import_item,
            commands::playlist_cmd::replace_playlist_import_items,
            commands::playlist_cmd::re_enrich_all_playlists,
            commands::playlist_cmd::append_playlist_import_items,
            commands::playlist_cmd::start_import_enrich,
            commands::playlist_cmd::try_fill_playlist_item_source_id,
            commands::favorites_cmd::ensure_favorites_playlist,
            commands::favorites_cmd::add_to_favorites,
            commands::favorites_cmd::remove_from_favorites,
            commands::lyrics_cmd::fetch_song_lrc,
            commands::lyrics_cmd::fetch_song_lrc_enriched,
            commands::lyrics_cmd::fetch_lrc_cx_cover,
            commands::lyrics_cmd::lyrics_search_candidates,
            commands::lyrics_cmd::lyrics_fetch_candidate,
            commands::download_cmd::enqueue_download,
            commands::download_cmd::list_downloaded_songs,
            commands::download_cmd::delete_downloaded_song,
            commands::library_cmd::list_local_songs,
            commands::library_cmd::scan_music_folder,
            commands::recent_cmd::list_recent_plays,
            commands::recent_cmd::record_recent_play,
            commands::util_cmd::db_status,
            commands::util_cmd::log_play_event,
            commands::util_cmd::read_file_bytes,
            commands::util_cmd::local_path_accessible,
            commands::util_cmd::get_app_log_path,
            commands::util_cmd::parse_import_text,
            commands::util_cmd::fetch_share_playlist,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CloudPlayer (Tauri)");
}
