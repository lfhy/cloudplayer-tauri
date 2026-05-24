use std::sync::Arc;

use tauri::State;

use crate::config::Settings;

use super::AppState;

#[tauri::command]
pub async fn fetch_song_lrc(
    state: State<'_, Arc<AppState>>,
    song_id: String,
) -> Result<Option<String>, String> {
    let sid = song_id.trim();
    if sid.is_empty() {
        return Err("无效的歌曲 ID".to_string());
    }
    eprintln!("[lyrics] command fetch_song_lrc song_id={sid}");
    state.limiter.acquire_slot().await;
    let raw = state.catalog.fetch_lrc(&state.client, sid).await?;
    Ok(raw.map(crate::lyrics::pack_lyrics_for_ui))
}

/// 多源歌词：固定顺序 QQ → 酷狗 → 网易云 → LRCLIB（与歌词替换「换」同源）；自托管网易 API 时在拉取候选后仍走 `/lyric/new` 优先。
#[tauri::command]
pub async fn fetch_song_lrc_enriched(
    state: State<'_, Arc<AppState>>,
    req: crate::lyrics::LyricsFetchIn,
) -> Result<Option<crate::lyrics::LyricsPayload>, String> {
    let settings = Settings::load();
    state.limiter.acquire_slot().await;
    crate::lyric_replace::fetch_song_lddc_enriched(&state.client, &settings, &req).await
}

/// 封面补全：`GET https://api.lrc.cx/cover`（跟随重定向至图片 URL）。
#[tauri::command]
pub async fn fetch_lrc_cx_cover(
    state: State<'_, Arc<AppState>>,
    title: String,
    artist: String,
    album: Option<String>,
) -> Result<Option<String>, String> {
    state.limiter.acquire_slot().await;
    let alb = album.unwrap_or_default();
    crate::lyrics::fetch_lrc_cx_cover(&state.client, &title, &artist, &alb).await
}

/// 歌词替换：多源搜索候选（QQ / 酷狗 / 网易 / LRCLIB）。
#[tauri::command]
pub async fn lyrics_search_candidates(
    state: State<'_, Arc<AppState>>,
    keyword: String,
    duration_ms: Option<i64>,
    sources: Option<Vec<String>>,
) -> Result<Vec<crate::lyric_replace::LyricCandidate>, String> {
    let settings = Settings::load();
    state.limiter.acquire_slot().await;
    crate::lyric_replace::lyrics_search_candidates(
        &state.client,
        &settings,
        keyword,
        duration_ms,
        sources,
    )
    .await
}

/// 歌词替换：拉取选中候选的完整 [`LyricsPayload`]。
#[tauri::command]
pub async fn lyrics_fetch_candidate(
    state: State<'_, Arc<AppState>>,
    candidate: crate::lyric_replace::LyricCandidate,
) -> Result<crate::lyrics::LyricsPayload, String> {
    let settings = Settings::load();
    state.limiter.acquire_slot().await;
    crate::lyric_replace::lyrics_fetch_candidate(&state.client, &settings, candidate).await
}
