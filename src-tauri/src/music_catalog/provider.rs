//! 在线曲库 Provider trait。

use std::path::Path;

use async_trait::async_trait;
use reqwest::Client;

use super::id::CatalogTrackId;
use super::types::{PreviewResolve, SearchPage, TrackMetadata};

/// 单个在线曲库源（搜索 / 试听 / 元数据 / 歌词 / 全量下载）。
#[async_trait]
pub trait MusicCatalogProvider: Send + Sync {
    fn name(&self) -> &'static str;

    async fn search(&self, client: &Client, keyword: &str, page: u32) -> Result<SearchPage, String>;

    async fn resolve_preview(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<PreviewResolve, String>;

    async fn fetch_preview_url(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<Option<String>, String>;

    async fn cache_preview(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<std::path::PathBuf, String>;

    async fn fetch_metadata(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<TrackMetadata, String>;

    async fn fetch_lrc(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<Option<String>, String>;

    /// 全量下载到 `dest` 路径（含扩展名）。默认不支持。
    async fn download_full(
        &self,
        _client: &Client,
        _track_id: &CatalogTrackId,
        _quality: &str,
        _dest: &Path,
    ) -> Result<(), String> {
        Err(format!("{} 暂不支持全量下载", self.name()))
    }

    fn supports_download(&self) -> bool {
        false
    }
}
