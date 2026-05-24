//! `Pjmp3Provider` — legacy pjmp3.com 实现（站点已下线，默认不在 CatalogService 中激活）。

use async_trait::async_trait;
use reqwest::Client;

use super::super::id::{CatalogTrackId, PROVIDER_PJMP3};
use super::super::provider::MusicCatalogProvider;
use super::super::types::{PreviewResolve, SearchPage, SearchResultDto, TrackMetadata};
use super::pjmp3_impl::{
    cache_preview_audio_file, extract_album_from_song_html, extract_duration_ms_from_song_html,
    fetch_preview_url as pjmp3_fetch_preview_url, fetch_song_lrc_text, fetch_song_page_html,
    search_pjmp3, SearchResultDto as Pjmp3SearchRow,
};

pub struct Pjmp3Provider;

impl Pjmp3Provider {
    pub fn new() -> Self {
        Self
    }

    fn ensure_pjmp3_id(track_id: &CatalogTrackId) -> Result<&str, String> {
        if track_id.provider != PROVIDER_PJMP3 {
            return Err(format!(
                "曲库 id 来源不匹配（期望 pjmp3，实际 {}）",
                track_id.provider
            ));
        }
        let sid = track_id.id.trim();
        if sid.is_empty() {
            return Err("无效的歌曲 ID".to_string());
        }
        Ok(sid)
    }

    fn map_search_row(row: Pjmp3SearchRow) -> SearchResultDto {
        let track_id = CatalogTrackId::pjmp3(row.source_id.clone());
        SearchResultDto {
            source_id: track_id.to_api_string(),
            catalog_provider: PROVIDER_PJMP3.to_string(),
            title: row.title,
            artist: row.artist,
            album: row.album,
            cover_url: row.cover_url,
        }
    }
}

#[async_trait]
impl MusicCatalogProvider for Pjmp3Provider {
    fn name(&self) -> &'static str {
        PROVIDER_PJMP3
    }

    async fn search(&self, client: &Client, keyword: &str, page: u32) -> Result<SearchPage, String> {
        let (results, has_next) = search_pjmp3(client, keyword, page).await?;
        Ok(SearchPage {
            results: results.into_iter().map(Self::map_search_row).collect(),
            has_next,
        })
    }

    async fn resolve_preview(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<PreviewResolve, String> {
        let sid = Self::ensure_pjmp3_id(track_id)?;
        if let Some(url) = pjmp3_fetch_preview_url(client, sid).await? {
            if !url.trim().is_empty() {
                return Ok(PreviewResolve::Url(url));
            }
        }
        let path = cache_preview_audio_file(client, sid).await?;
        Ok(PreviewResolve::CachedPath(path))
    }

    async fn fetch_preview_url(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<Option<String>, String> {
        let sid = Self::ensure_pjmp3_id(track_id)?;
        pjmp3_fetch_preview_url(client, sid).await
    }

    async fn cache_preview(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<std::path::PathBuf, String> {
        let sid = Self::ensure_pjmp3_id(track_id)?;
        cache_preview_audio_file(client, sid).await
    }

    async fn fetch_metadata(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<TrackMetadata, String> {
        let sid = Self::ensure_pjmp3_id(track_id)?;
        let html = fetch_song_page_html(client, sid).await.unwrap_or_default();
        let album = extract_album_from_song_html(&html).unwrap_or_default();
        let duration_ms = extract_duration_ms_from_song_html(&html);
        Ok(TrackMetadata {
            album,
            duration_ms,
            cover_url: None,
        })
    }

    async fn fetch_lrc(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<Option<String>, String> {
        let sid = Self::ensure_pjmp3_id(track_id)?;
        fetch_song_lrc_text(client, sid).await
    }

    fn supports_download(&self) -> bool {
        true
    }
}
