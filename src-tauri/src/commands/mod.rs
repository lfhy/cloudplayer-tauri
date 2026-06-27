pub mod proxy_cmd;
pub mod settings_cmd;
pub mod window_cmd;
pub mod search_cmd;
pub mod play_resolve_cmd;
pub mod playlist_cmd;
pub mod favorites_cmd;
pub mod lyrics_cmd;
pub mod download_cmd;
pub mod library_cmd;
pub mod recent_cmd;
pub mod util_cmd;

use std::sync::Arc;

use crate::music_catalog::CatalogService;
use crate::rate_limiter::RateLimiter;

/// HTTP 客户端与搜索限速（与 Python 侧行为接近，避免短时间大量请求）。
#[derive(Clone)]
pub struct AppState {
    pub client: reqwest::Client,
    pub limiter: Arc<RateLimiter>,
    pub download_tx: tokio::sync::mpsc::Sender<crate::download::DownloadJob>,
    pub catalog: Arc<CatalogService>,
    /// 启动期解析的最终代理；仅用于 `get_proxy_status` 展示，运行期代理变更需要重启。
    pub proxy: Arc<crate::proxy::EffectiveProxy>,
}

// Commands are referenced via full paths in lib.rs (e.g. `commands::settings_cmd::get_settings`).
// Re-exports are unnecessary since Tauri's generate_handler! needs the original module paths.