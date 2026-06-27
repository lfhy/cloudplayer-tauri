//! 在线曲库门面：按 settings 选择 active provider，统一试听缓存路径。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use reqwest::Client;

use crate::config::Settings;

use super::id::{parse_catalog_id, CatalogTrackId, PROVIDER_NONE};
use super::provider::MusicCatalogProvider;
use super::providers::GequhaiProvider;
use super::types::{
    PreviewResolve, SearchPage, SearchResultDto, TrackMetadata, CATALOG_UNAVAILABLE,
};

const PREVIEW_CACHE_EXTS: &[&str] = &[".mp3", ".m4a", ".aac", ".flac", ".ogg", ".wav"];

pub struct CatalogService {
    providers: HashMap<String, Arc<dyn MusicCatalogProvider>>,
}

impl CatalogService {
    pub fn new() -> Self {
        let mut providers: HashMap<String, Arc<dyn MusicCatalogProvider>> = HashMap::new();
        providers.insert(
            "gequhai".to_string(),
            Arc::new(GequhaiProvider::new()),
        );
        Self { providers }
    }

    pub fn active_provider_name() -> String {
        let name = Settings::load().catalog_provider.trim().to_lowercase();
        if name.is_empty() || name == PROVIDER_NONE {
            PROVIDER_NONE.to_string()
        } else {
            name
        }
    }

    pub fn is_online_available(&self) -> bool {
        Self::active_provider_name() != PROVIDER_NONE
    }

    fn provider_for_name(&self, name: &str) -> Result<Arc<dyn MusicCatalogProvider>, String> {
        if name == PROVIDER_NONE || name.is_empty() {
            return Err(CATALOG_UNAVAILABLE.to_string());
        }
        self.providers
            .get(name)
            .cloned()
            .ok_or_else(|| format!("未支持的曲库源: {name}"))
    }

    fn active_provider(&self) -> Result<Arc<dyn MusicCatalogProvider>, String> {
        self.provider_for_name(&Self::active_provider_name())
    }

    /// 若 id 带旧 provider 前缀（如 pjmp3）而当前 active 不同，用 active 的 id 重试（历史裸 id）。
    pub fn resolve_track_id(&self, raw: &str) -> Result<CatalogTrackId, String> {
        let parsed = parse_catalog_id(raw);
        if parsed.is_empty() {
            return Err("无效的歌曲 ID".to_string());
        }
        let active = Self::active_provider_name();
        if active == PROVIDER_NONE {
            return Err(CATALOG_UNAVAILABLE.to_string());
        }
        if parsed.provider != PROVIDER_NONE && parsed.provider != active {
            return Err(format!(
                "历史曲库 id（{}）已失效，请在「发现」中重新搜索或在歌单中触发富化",
                parsed.provider
            ));
        }
        Ok(CatalogTrackId::new(active, parsed.id))
    }

    pub fn require_download_provider(
        &self,
        raw_source_id: &str,
    ) -> Result<(Arc<dyn MusicCatalogProvider>, CatalogTrackId), String> {
        let track_id = self.resolve_track_id(raw_source_id)?;
        let provider = self.active_provider()?;
        if !provider.supports_download() {
            return Err(format!("{} 暂不支持下载", provider.name()));
        }
        Ok((provider, track_id))
    }

    pub async fn search(&self, client: &Client, keyword: &str, page: u32) -> Result<SearchPage, String> {
        let provider = self.active_provider()?;
        provider.search(client, keyword, page).await
    }

    pub async fn fetch_preview_url(
        &self,
        client: &Client,
        raw_id: &str,
    ) -> Result<String, String> {
        let track_id = self.resolve_track_id(raw_id)?;
        let provider = self.provider_for_name(&track_id.provider)?;
        provider
            .fetch_preview_url(client, &track_id)
            .await?
            .ok_or_else(|| "未解析到试听地址".to_string())
    }

    pub async fn cache_preview(&self, client: &Client, raw_id: &str) -> Result<PathBuf, String> {
        let track_id = self.resolve_track_id(raw_id)?;
        let provider = self.provider_for_name(&track_id.provider)?;
        provider.cache_preview(client, &track_id).await
    }

    pub async fn fetch_lrc(
        &self,
        client: &Client,
        raw_id: &str,
    ) -> Result<Option<String>, String> {
        let track_id = self.resolve_track_id(raw_id)?;
        let provider = self.provider_for_name(&track_id.provider)?;
        provider.fetch_lrc(client, &track_id).await
    }

    pub async fn search_first_match(
        &self,
        client: &Client,
        keyword: &str,
    ) -> Result<Option<SearchResultDto>, String> {
        let page = self.search(client, keyword, 1).await?;
        Ok(page.results.into_iter().next())
    }

    /// 按标题/歌手生成多组关键词，返回首个命中。
    pub async fn search_first_match_variants(
        &self,
        client: &Client,
        title: &str,
        artist: &str,
    ) -> Result<Option<SearchResultDto>, String> {
        let keywords = GequhaiProvider::search_keyword_variants(title, artist);
        for kw in keywords {
            match self.search_first_match(client, &kw).await {
                Ok(Some(r)) => return Ok(Some(r)),
                Ok(None) => {}
                Err(e) => {
                    log::warn!(target: "catalog", "search variant failed kw={} err={}", kw, e);
                    if e.contains("error sending request")
                        || e.contains("timeout")
                        || e.contains("connect")
                    {
                        return Ok(None);
                    }
                }
            }
        }
        Ok(None)
    }

    pub async fn fetch_metadata(
        &self,
        client: &Client,
        raw_id: &str,
    ) -> Result<TrackMetadata, String> {
        let track_id = self.resolve_track_id(raw_id)?;
        let provider = self.provider_for_name(&track_id.provider)?;
        provider.fetch_metadata(client, &track_id).await
    }

    pub fn preview_audio_cache_dir() -> PathBuf {
        std::env::temp_dir().join("cloudplayer_tauri_audio")
    }

    /// 查找已有试听缓存：`preview_{provider}_{id}.*`。
    pub fn preview_cache_path_if_exists(raw_id: &str) -> Option<PathBuf> {
        let track_id = parse_catalog_id(raw_id);
        if track_id.is_empty() {
            return None;
        }
        let dir = Self::preview_audio_cache_dir();
        let key = track_id.cache_key();
        for ext in PREVIEW_CACHE_EXTS {
            let path = dir.join(format!("preview_{key}{ext}"));
            if path_is_nonempty_file(&path) {
                return Some(path);
            }
        }
        None
    }

    pub async fn resolve_preview_for_play(
        &self,
        client: &Client,
        raw_id: &str,
    ) -> Result<PreviewResolve, String> {
        let track_id = self.resolve_track_id(raw_id)?;
        let provider = self.provider_for_name(&track_id.provider)?;
        provider.resolve_preview(client, &track_id).await
    }
}

fn path_is_nonempty_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

impl Default for CatalogService {
    fn default() -> Self {
        Self::new()
    }
}
