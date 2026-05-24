use std::path::PathBuf;
use std::sync::Arc;

use log::{info, warn};
use rusqlite::OptionalExtension;
use serde::Serialize;
use tauri::State;

use super::AppState;
use crate::db::DbState;

/// 在线播放解析顺序：**本地曲库 songs → 下载目录同名文件 → 试听磁盘缓存 → 最近播放保存的试听直链 → 拉取试听缓存 → 解析直链**；均失败则 Err。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveOnlinePlayOut {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub via: String,
}

fn local_library_audio_path(conn: &rusqlite::Connection, sid: &str, title: &str, artist: &str) -> Option<PathBuf> {
    if !sid.is_empty() {
        let q: std::result::Result<String, rusqlite::Error> = conn.query_row(
            "SELECT file_path FROM songs WHERE TRIM(IFNULL(source_id,'')) = TRIM(?1) LIMIT 1",
            [sid],
            |r| r.get(0),
        );
        if let Ok(fp) = q {
            let p = PathBuf::from(fp);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    if title.is_empty() {
        return None;
    }
    let q: std::result::Result<String, rusqlite::Error> = conn.query_row(
        "SELECT file_path FROM songs WHERE title = ?1 COLLATE NOCASE AND artist = ?2 COLLATE NOCASE LIMIT 1",
        rusqlite::params![title, artist],
        |r| r.get(0),
    );
    if let Ok(fp) = q {
        let p = PathBuf::from(fp);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn recent_play_stored_preview_url(conn: &rusqlite::Connection, sid: &str) -> Option<String> {
    if sid.is_empty() {
        return None;
    }
    conn.query_row(
        "SELECT play_url FROM recent_plays WHERE kind='online' AND TRIM(IFNULL(pjmp3_source_id,'')) = TRIM(?1)
         AND TRIM(IFNULL(play_url,'')) != '' ORDER BY played_at DESC LIMIT 1",
        [sid],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .filter(|s| !s.trim().is_empty())
}

fn log_url_160(s: &str) -> String {
    let t: String = s.chars().take(160).collect();
    if s.len() > 160 {
        format!("{t}…")
    } else {
        t
    }
}

#[tauri::command]
pub async fn resolve_online_play(
    state: State<'_, Arc<AppState>>,
    db: State<'_, DbState>,
    song_id: String,
    title: String,
    artist: String,
    skip_recent_url: Option<bool>,
) -> Result<ResolveOnlinePlayOut, String> {
    let t0 = std::time::Instant::now();
    let sid = song_id.trim();
    if sid.is_empty() {
        warn!(
            target: "pj-play",
            "resolve_online_play reject empty_id elapsed_ms={}",
            t0.elapsed().as_millis()
        );
        return Err("无效的歌曲 ID".to_string());
    }
    let tit = title.trim();
    let art = artist.trim();

    // 1) 本地音乐（扫描进库的 songs）
    let local_from_library: Option<PathBuf> = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        local_library_audio_path(&conn, sid, tit, art)
    };
    if let Some(p) = local_from_library {
        if tokio::fs::metadata(&p)
            .await
            .map(|m| m.is_file() && m.len() > 0)
            .unwrap_or(false)
        {
            let path_str = p.to_string_lossy().to_string();
            info!(
                target: "pj-play",
                "resolve_online_play ok sid={} via=local_library elapsed_ms={} path_len={} path_prefix={}",
                sid,
                t0.elapsed().as_millis(),
                path_str.len(),
                log_url_160(&path_str)
            );
            return Ok(ResolveOnlinePlayOut {
                kind: "file".to_string(),
                path: Some(path_str),
                url: None,
                via: "local_library".to_string(),
            });
        }
    }

    // 1a) 已下载记录（按曲库 id，不依赖歌名与落盘文件名一致）
    let dl_paths: Vec<String> = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        crate::db::downloaded_track_paths_by_source_id(&conn, sid).map_err(|e| e.to_string())?
    };
    for fp in dl_paths {
        let p = PathBuf::from(&fp);
        if tokio::fs::metadata(&p)
            .await
            .map(|m| m.is_file() && m.len() > 0)
            .unwrap_or(false)
        {
            let path_str = p.to_string_lossy().to_string();
            info!(
                target: "pj-play",
                "resolve_online_play ok sid={} via=downloaded_track elapsed_ms={} path_len={} path_prefix={}",
                sid,
                t0.elapsed().as_millis(),
                path_str.len(),
                log_url_160(&path_str)
            );
            return Ok(ResolveOnlinePlayOut {
                kind: "file".to_string(),
                path: Some(path_str),
                url: None,
                via: "downloaded_track".to_string(),
            });
        }
    }

    // 1b) 下载目录同名文件（本地，未入库也能播）
    for p in crate::download::candidate_downloaded_audio_paths(tit, art) {
        if tokio::fs::metadata(&p)
            .await
            .map(|m| m.is_file() && m.len() > 0)
            .unwrap_or(false)
        {
            let path_str = p.to_string_lossy().to_string();
            info!(
                target: "pj-play",
                "resolve_online_play ok sid={} via=download elapsed_ms={} path_len={} path_prefix={}",
                sid,
                t0.elapsed().as_millis(),
                path_str.len(),
                log_url_160(&path_str)
            );
            return Ok(ResolveOnlinePlayOut {
                kind: "file".to_string(),
                path: Some(path_str),
                url: None,
                via: "download".to_string(),
            });
        }
    }

    // 2) 试听磁盘缓存
    if let Some(p) = crate::music_catalog::CatalogService::preview_cache_path_if_exists(sid) {
        let path_str = p.to_string_lossy().to_string();
        info!(
            target: "pj-play",
            "resolve_online_play ok sid={} via=preview_cache elapsed_ms={} path_len={} path_prefix={}",
            sid,
            t0.elapsed().as_millis(),
            path_str.len(),
            log_url_160(&path_str)
        );
        return Ok(ResolveOnlinePlayOut {
            kind: "file".to_string(),
            path: Some(path_str),
            url: None,
            via: "preview_cache".to_string(),
        });
    }

    // 3) 播放记录中上次成功使用的试听直链（可能已过期，由播放器侧失败）
    if !skip_recent_url.unwrap_or(false) {
        let stored_recent_url: Option<String> = {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            recent_play_stored_preview_url(&conn, sid)
        };
        if let Some(u) = stored_recent_url {
            let url_trim = u.trim().to_string();
            info!(
                target: "pj-play",
                "resolve_online_play ok sid={} via=recent_play_url elapsed_ms={} url_len={} url_prefix={}",
                sid,
                t0.elapsed().as_millis(),
                url_trim.len(),
                log_url_160(&url_trim)
            );
            return Ok(ResolveOnlinePlayOut {
                kind: "url".to_string(),
                path: None,
                url: Some(url_trim),
                via: "recent_play_url".to_string(),
            });
        }
    }

    state.limiter.acquire_slot().await;
    let err_preview = match state
        .catalog
        .cache_preview(&state.client, sid)
        .await
    {
        Ok(p) => {
            let path_str = p.to_string_lossy().to_string();
            info!(
                target: "pj-play",
                "resolve_online_play ok sid={} via=fetched_preview elapsed_ms={} path_len={} path_prefix={}",
                sid,
                t0.elapsed().as_millis(),
                path_str.len(),
                log_url_160(&path_str)
            );
            return Ok(ResolveOnlinePlayOut {
                kind: "file".to_string(),
                path: Some(path_str),
                url: None,
                via: "fetched_preview".to_string(),
            });
        }
        Err(e) => e,
    };

    warn!(
        target: "pj-play",
        "resolve_online_play fetched_preview_failed sid={} elapsed_ms={} err={} — try direct_url",
        sid,
        t0.elapsed().as_millis(),
        err_preview
    );

    state.limiter.acquire_slot().await;
    match state.catalog.fetch_preview_url(&state.client, sid).await {
        Ok(url) => {
            let u = url.trim();
            if !u.is_empty() {
                let u_owned = u.to_string();
                info!(
                    target: "pj-play",
                    "resolve_online_play ok sid={} via=direct_url elapsed_ms={} url_len={} url_prefix={}",
                    sid,
                    t0.elapsed().as_millis(),
                    u_owned.len(),
                    log_url_160(&u_owned)
                );
                return Ok(ResolveOnlinePlayOut {
                    kind: "url".to_string(),
                    path: None,
                    url: Some(u_owned),
                    via: "direct_url".to_string(),
                });
            }
            let msg = format!("{err_preview}；直链降级：未解析到 MP3 地址");
            warn!(
                target: "pj-play",
                "resolve_online_play fail sid={} elapsed_ms={} err={}",
                sid,
                t0.elapsed().as_millis(),
                msg
            );
            Err(msg)
        }
        Err(e) => {
            let msg = format!("{err_preview}；直链降级失败：{e}");
            warn!(
                target: "pj-play",
                "resolve_online_play fail sid={} elapsed_ms={} err={}",
                sid,
                t0.elapsed().as_millis(),
                msg
            );
            Err(msg)
        }
    }
}
