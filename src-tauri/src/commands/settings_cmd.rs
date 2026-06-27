use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::config::{GlobalHotkeys, Settings};

#[derive(Debug, Deserialize)]
pub struct SettingsPatch {
    pub volume: Option<f64>,
    pub last_library_folder: Option<String>,
    pub daily_download_limit: Option<i64>,
    pub desktop_lyrics_visible: Option<bool>,
    pub desktop_lyrics_locked: Option<bool>,
    pub desktop_lyrics_x: Option<i32>,
    pub desktop_lyrics_y: Option<i32>,
    pub desktop_lyrics_width: Option<u32>,
    pub desktop_lyrics_height: Option<u32>,
    pub desktop_lyrics_scale: Option<f64>,
    pub download_folder: Option<String>,
    pub lyrics_netease_api_base: Option<String>,
    pub lyrics_lrclib_enabled: Option<bool>,
    pub main_window_close_action: Option<String>,
    pub desktop_lyrics_color_base: Option<String>,
    pub desktop_lyrics_color_highlight: Option<String>,
    pub desktop_lyrics_font_family: Option<String>,
    pub last_play_queue_json: Option<String>,
    pub last_play_index: Option<i64>,
    pub last_play_mode_index: Option<i64>,
    /// 代理嵌套 patch（仅支持顶层三字段，URL 形态由 \`save_settings\` 调 \`proxy::validate_config\` 校验）。
    pub proxy_enabled: Option<bool>,
    pub proxy_url: Option<String>,
    pub proxy_no_proxy: Option<String>,
}

#[tauri::command]
pub fn get_settings() -> Settings {
    Settings::load()
}

#[tauri::command]
pub fn get_global_hotkeys() -> GlobalHotkeys {
    Settings::load().global_hotkeys
}

#[tauri::command]
pub fn validate_accelerator(s: String) -> Result<(), String> {
    crate::global_hotkeys::validate_accelerator_str(&s)
}

#[tauri::command]
pub fn apply_global_hotkeys(app: AppHandle, cfg: GlobalHotkeys) -> Result<crate::global_hotkeys::HotkeyApplyReport, String> {
    #[cfg(desktop)]
    {
        let map = app
            .try_state::<crate::global_hotkeys::HotkeyShortcutMap>()
            .ok_or_else(|| "内部错误：快捷键状态未初始化".to_string())?;
        let report = crate::global_hotkeys::apply_global_hotkeys_runtime(&app, &cfg, &map)?;
        let mut s = Settings::load();
        s.global_hotkeys = cfg;
        s.save()?;
        return Ok(report);
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        let mut s = Settings::load();
        s.global_hotkeys = cfg;
        s.save()?;
        Ok(crate::global_hotkeys::HotkeyApplyReport::all_ok())
    }
}

/// 未在设置中指定 `download_folder` 时，与下载落盘使用的默认目录一致（绝对路径）。
#[tauri::command]
pub fn get_default_download_dir() -> String {
    crate::config::default_download_dir()
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
pub fn save_settings(patch: SettingsPatch) -> Result<(), String> {
    let mut s = Settings::load();
    if let Some(v) = patch.volume {
        s.volume = v.clamp(0.0, 1.0);
    }
    if let Some(v) = patch.last_library_folder {
        s.last_library_folder = v;
    }
    if let Some(v) = patch.daily_download_limit {
        s.daily_download_limit = v.max(0);
    }
    if let Some(v) = patch.desktop_lyrics_visible {
        s.desktop_lyrics_visible = v;
    }
    if let Some(v) = patch.desktop_lyrics_locked {
        s.desktop_lyrics_locked = v;
    }
    if let Some(v) = patch.desktop_lyrics_x {
        s.desktop_lyrics_x = Some(v);
    }
    if let Some(v) = patch.desktop_lyrics_y {
        s.desktop_lyrics_y = Some(v);
    }
    if let Some(v) = patch.desktop_lyrics_width {
        s.desktop_lyrics_width = Some(v.max(200));
    }
    if let Some(v) = patch.desktop_lyrics_height {
        s.desktop_lyrics_height = Some(v.max(72));
    }
    if let Some(v) = patch.desktop_lyrics_scale {
        s.desktop_lyrics_scale = v.clamp(0.5, 2.5);
    }
    if let Some(v) = patch.download_folder {
        s.download_folder = v;
    }
    if let Some(v) = patch.lyrics_netease_api_base {
        s.lyrics_netease_api_base = v;
    }
    if let Some(v) = patch.lyrics_lrclib_enabled {
        s.lyrics_lrclib_enabled = v;
    }
    if let Some(v) = patch.main_window_close_action {
        let t = v.trim().to_ascii_lowercase();
        if t == "ask" || t == "quit" || t == "tray" {
            s.main_window_close_action = t;
        }
    }
    if let Some(v) = patch.desktop_lyrics_color_base {
        let t = v.trim();
        if t.len() == 7 && t.starts_with('#') && t.chars().skip(1).all(|c| c.is_ascii_hexdigit()) {
            s.desktop_lyrics_color_base = t.to_ascii_lowercase();
        }
    }
    if let Some(v) = patch.desktop_lyrics_color_highlight {
        let t = v.trim();
        if t.len() == 7 && t.starts_with('#') && t.chars().skip(1).all(|c| c.is_ascii_hexdigit()) {
            s.desktop_lyrics_color_highlight = t.to_ascii_lowercase();
        }
    }
    if let Some(v) = patch.desktop_lyrics_font_family {
        let t = v.trim();
        if t.len() <= 200 {
            s.desktop_lyrics_font_family = t.to_string();
        }
    }
    if let Some(v) = patch.last_play_queue_json {
        if v.len() <= 200_000 {
            s.last_play_queue_json = v;
        }
    }
    if let Some(v) = patch.last_play_index {
        s.last_play_index = v.max(0);
    }
    if let Some(v) = patch.last_play_mode_index {
        s.last_play_mode_index = v.clamp(0, 3);
    }
    // 代理：enabled/url/no_proxy 三字段任意一个出现都视为一次 patch；
    // URL 形态由 \`crate::proxy::validate_config\` 校验；运行期变更需重启。
    let proxy_touched = patch.proxy_enabled.is_some()
        || patch.proxy_url.is_some()
        || patch.proxy_no_proxy.is_some();
    if proxy_touched {
        if let Some(b) = patch.proxy_enabled {
            s.proxy.enabled = b;
        }
        if let Some(v) = patch.proxy_url {
            s.proxy.url = v.trim().to_string();
        }
        if let Some(v) = patch.proxy_no_proxy {
            s.proxy.no_proxy = v.trim().to_string();
        }
        if let Err(e) = crate::proxy::validate_config(&s.proxy) {
            return Err(format!("代理设置无效: {e}"));
        }
    }
    s.save()
}
