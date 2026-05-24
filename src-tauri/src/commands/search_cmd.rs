use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use super::AppState;
use crate::music_catalog::SearchResultDto;

#[derive(Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResultDto>,
    pub has_next: bool,
}

#[tauri::command]
pub async fn search_songs(
    state: State<'_, Arc<AppState>>,
    keyword: String,
    page: u32,
) -> Result<SearchResponse, String> {
    let kw = keyword.trim();
    if kw.is_empty() {
        return Err("请输入搜索关键词".to_string());
    }
    state.limiter.acquire_slot().await;
    let p = page.max(1);
    let page_result = state
        .catalog
        .search(&state.client, kw, p)
        .await?;
    Ok(SearchResponse {
        results: page_result.results,
        has_next: page_result.has_next,
    })
}

#[tauri::command]
pub async fn get_preview_url(state: State<'_, Arc<AppState>>, song_id: String) -> Result<String, String> {
    let sid = song_id.trim();
    if sid.is_empty() {
        return Err("无效的歌曲 ID".to_string());
    }
    state.limiter.acquire_slot().await;
    state.catalog.fetch_preview_url(&state.client, sid).await
}

/// 下载试听到本地临时文件并返回路径，供前端 `convertFileSrc` 播放（避免 WebView 无法直连外链）。
#[tauri::command]
pub async fn cache_preview_for_play(state: State<'_, Arc<AppState>>, song_id: String) -> Result<String, String> {
    let sid = song_id.trim();
    if sid.is_empty() {
        return Err("无效的歌曲 ID".to_string());
    }
    state.limiter.acquire_slot().await;
    let path = state.catalog.cache_preview(&state.client, sid).await?;
    Ok(path.to_string_lossy().to_string())
}
