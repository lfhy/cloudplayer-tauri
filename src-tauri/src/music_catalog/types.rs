//! 在线曲库公共类型（与具体 provider 无关）。

use std::path::PathBuf;

use serde::Serialize;

use super::id::CatalogTrackId;

/// 序列化到前端的搜索结果（`source_id` 保持与历史前端兼容：裸 id 或 `provider:id`）。
#[derive(Serialize, Clone, Debug)]
pub struct SearchResultDto {
    pub source_id: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    pub cover_url: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub catalog_provider: String,
}

impl SearchResultDto {
    pub fn from_catalog(
        track_id: &CatalogTrackId,
        title: String,
        artist: String,
        album: String,
        cover_url: Option<String>,
    ) -> Self {
        Self {
            source_id: track_id.to_api_string(),
            catalog_provider: track_id.provider.clone(),
            title,
            artist,
            album,
            cover_url,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SearchPage {
    pub results: Vec<SearchResultDto>,
    pub has_next: bool,
}

#[derive(Debug, Clone)]
pub struct TrackMetadata {
    pub album: String,
    pub duration_ms: i64,
    pub cover_url: Option<String>,
}

#[derive(Debug, Clone)]
pub enum PreviewResolve {
    Url(String),
    CachedPath(PathBuf),
}

pub const CATALOG_UNAVAILABLE: &str = "在线曲库暂不可用，请稍后再试或在设置中配置曲库源";
