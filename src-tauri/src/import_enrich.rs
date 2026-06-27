//! 导入歌单条目后台富化：搜索曲库 id、封面缓存、补专辑/时长。

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use reqwest::Client;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tokio::time::sleep;

use crate::commands::AppState;
use crate::config::config_dir;
use crate::db::DbState;
use crate::music_catalog::parse_catalog_id;
use crate::music_catalog::CatalogService;
use crate::music_catalog::SearchResultDto;

const ENRICH_DELAY_MS: u64 = 450;
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 全局串行：避免 re_enrich_all 等多歌单并行打爆 gequhai 连接。
static ENRICH_SERIAL: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Clone, Debug)]
struct ImportRow {
    id: i64,
    title: String,
    artist: String,
    album: String,
    /// DB 列名仍为 `pjmp3_source_id`（历史兼容），语义为 catalog_id。
    catalog_id: String,
    catalog_provider: String,
    cover_url: String,
    cover_cache_path: String,
    duration_ms: i64,
}

fn cover_cache_dir() -> PathBuf {
    config_dir().join("cover_cache")
}

fn load_row(conn: &Connection, playlist_id: i64, row_id: i64) -> Result<Option<ImportRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        r#"SELECT id, title, artist, album, pjmp3_source_id, catalog_provider, cover_url, cover_cache_path, duration_ms
           FROM playlist_import_items WHERE id=?1 AND playlist_id=?2"#,
    )?;
    let mut rows = stmt.query_map(rusqlite::params![row_id, playlist_id], |r| {
        Ok(ImportRow {
            id: r.get(0)?,
            title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            artist: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            album: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            catalog_id: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            catalog_provider: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            cover_url: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
            cover_cache_path: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
            duration_ms: r.get(8)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

fn load_all_rows(conn: &Connection, playlist_id: i64) -> Result<Vec<ImportRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        r#"SELECT id, title, artist, album, pjmp3_source_id, catalog_provider, cover_url, cover_cache_path, duration_ms
           FROM playlist_import_items WHERE playlist_id=?1 ORDER BY sort_order ASC, id ASC"#,
    )?;
    let rows = stmt.query_map([playlist_id], |r| {
        Ok(ImportRow {
            id: r.get(0)?,
            title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            artist: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            album: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            catalog_id: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            catalog_provider: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            cover_url: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
            cover_cache_path: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
            duration_ms: r.get(8)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn catalog_id_needs_rematch(catalog_id: &str, catalog_provider: &str) -> bool {
    let cid = catalog_id.trim();
    if cid.is_empty() {
        return true;
    }
    let active = CatalogService::active_provider_name();
    if active == "none" {
        return false;
    }
    let parsed = parse_catalog_id(cid);
    if parsed.provider != "none" && parsed.provider != active {
        return true;
    }
    let cp = catalog_provider.trim();
    if !cp.is_empty() && cp != active {
        return true;
    }
    // 无前缀裸 id 且 DB 未标记当前 provider → 历史导入 id，需重搜
    if parsed.provider == "none" && cp != active {
        return true;
    }
    false
}

fn needs_enrichment(t: &ImportRow) -> bool {
    if t.title.trim().is_empty() {
        return false;
    }
    if catalog_id_needs_rematch(&t.catalog_id, &t.catalog_provider) {
        return true;
    }
    let cu = t.cover_url.trim();
    let cp = t.cover_cache_path.trim();
    if !cu.is_empty() && (cp.is_empty() || !Path::new(cp).is_file()) {
        return true;
    }
    t.album.trim().is_empty() || t.duration_ms <= 0
}

async fn download_cover(client: &Client, url: &str, dest: &Path) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("empty url".to_string());
    }
    let resp = client
        .get(url)
        .header("User-Agent", UA)
        .header("Accept", "image/*,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() < 32 {
        return Err("cover too small".to_string());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(dest, &bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// 搜索首条写入导入行（无曲库 id 时）。网络请求在锁外完成。
async fn apply_search_metadata(
    app: &AppHandle,
    client: &Client,
    app_state: &AppState,
    playlist_id: i64,
    row: &ImportRow,
) -> Result<(), String> {
    if row.title.trim().is_empty() {
        return Ok(());
    }
    if !app_state.catalog.is_online_available() {
        return Ok(());
    }
    app_state.limiter.acquire_slot().await;
    let Some(first) = app_state
        .catalog
        .search_first_match_variants(client, row.title.trim(), row.artist.trim())
        .await?
    else {
        return Ok(());
    };
    if first.source_id.trim().is_empty() {
        return Ok(());
    }
    let cover_path = cache_search_cover(client, app_state, &first).await;
    let cover_url_s = first.cover_url.clone().unwrap_or_default();
    let provider = first.catalog_provider.clone();
    let db: tauri::State<'_, DbState> = app.state();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        r#"UPDATE playlist_import_items SET
            title=?1, artist=?2, album=?3, pjmp3_source_id=?4, catalog_provider=?5,
            cover_url=?6, cover_cache_path=?7
           WHERE id=?8 AND playlist_id=?9"#,
        rusqlite::params![
            first.title,
            first.artist,
            first.album,
            first.source_id,
            provider,
            cover_url_s,
            cover_path.as_deref().unwrap_or(""),
            row.id,
            playlist_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn cache_search_cover(
    client: &Client,
    app_state: &AppState,
    first: &SearchResultDto,
) -> Option<String> {
    let u = first.cover_url.as_ref()?.trim();
    if u.is_empty() {
        return None;
    }
    let _ = std::fs::create_dir_all(cover_cache_dir());
    let sid = first.source_id.trim();
    let safe: String = sid
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == ':' { c } else { '_' })
        .collect();
    let path = cover_cache_dir().join(format!("cov_{safe}.jpg"));
    app_state.limiter.acquire_slot().await;
    if download_cover(client, u, &path).await.is_ok() {
        return Some(path.to_string_lossy().to_string());
    }
    None
}

/// 已有 URL 时仅下载封面到缓存。
async fn ensure_cover_file(
    client: &Client,
    app_state: &AppState,
    row: &ImportRow,
) -> Result<Option<String>, String> {
    let sid = row.catalog_id.trim();
    let cu = row.cover_url.trim();
    if sid.is_empty() || cu.is_empty() {
        return Ok(None);
    }
    let cp = row.cover_cache_path.trim();
    if !cp.is_empty() && Path::new(cp).is_file() {
        return Ok(None);
    }
    let _ = std::fs::create_dir_all(cover_cache_dir());
    let safe: String = sid
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == ':' { c } else { '_' })
        .collect();
    let path = cover_cache_dir().join(format!("cov_{safe}.jpg"));
    app_state.limiter.acquire_slot().await;
    match download_cover(client, cu, &path).await {
        Ok(()) => Ok(Some(path.to_string_lossy().to_string())),
        Err(_) => Ok(None),
    }
}

fn update_row_cover_cache(conn: &Connection, playlist_id: i64, row_id: i64, path: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE playlist_import_items SET cover_cache_path=?1 WHERE id=?2 AND playlist_id=?3",
        rusqlite::params![path, row_id, playlist_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn enrich_metadata(
    app: &AppHandle,
    client: &Client,
    app_state: &AppState,
    playlist_id: i64,
    row: &ImportRow,
) -> Result<(), String> {
    let sid = row.catalog_id.trim();
    if sid.is_empty() {
        return Ok(());
    }
    let need_album = row.album.trim().is_empty();
    let need_dur = row.duration_ms <= 0;
    if !need_album && !need_dur {
        return Ok(());
    }
    if !app_state.catalog.is_online_available() {
        return Ok(());
    }
    app_state.limiter.acquire_slot().await;
    let meta = match app_state.catalog.fetch_metadata(client, sid).await {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    let mut album = row.album.clone();
    let mut dur = row.duration_ms;
    let mut cover_url = row.cover_url.clone();
    if need_album && !meta.album.trim().is_empty() {
        album = meta.album;
    }
    if need_dur && meta.duration_ms > 0 {
        dur = meta.duration_ms;
    }
    if let Some(cu) = meta.cover_url.as_ref() {
        let t = cu.trim();
        if !t.is_empty() && row.cover_url.trim().is_empty() {
            cover_url = t.to_string();
        }
    }
    if need_album && album.trim().is_empty() {
        let kw = format!("{} {}", row.title.trim(), row.artist.trim());
        let q = kw.trim().to_string();
        if !q.is_empty() {
            app_state.limiter.acquire_slot().await;
            if let Ok(Some(r0)) = app_state.catalog.search_first_match(client, &q).await {
                if r0.source_id.trim() == sid && !r0.album.trim().is_empty() {
                    album = r0.album.clone();
                }
            }
        }
    }
    let db: tauri::State<'_, DbState> = app.state();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE playlist_import_items SET album=?1, duration_ms=?2, cover_url=?3 WHERE id=?4 AND playlist_id=?5",
        rusqlite::params![album, dur, cover_url, row.id, playlist_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 为缺少曲库 id 的单条导入记录尝试搜索并写库；已有 id 则直接返回该 id。
pub async fn try_resolve_import_row_source_id(
    app: &AppHandle,
    client: &Client,
    app_state: &AppState,
    playlist_id: i64,
    row_id: i64,
) -> Result<Option<String>, String> {
    if playlist_id <= 0 || row_id <= 0 {
        return Ok(None);
    }
    let row = {
        let db: tauri::State<'_, DbState> = app.state();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        load_row(&conn, playlist_id, row_id).map_err(|e| e.to_string())?
    };
    let Some(row) = row else {
        return Ok(None);
    };
    let existing = row.catalog_id.trim();
    if !existing.is_empty() && !catalog_id_needs_rematch(existing, &row.catalog_provider) {
        return Ok(Some(existing.to_string()));
    }
    apply_search_metadata(app, client, app_state, playlist_id, &row).await?;
    let row2 = {
        let db: tauri::State<'_, DbState> = app.state();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        load_row(&conn, playlist_id, row_id).map_err(|e| e.to_string())?
    };
    Ok(row2.and_then(|r| {
        let s = r.catalog_id.trim();
        if s.is_empty() {
            None
        } else {
            Some(s.to_string())
        }
    }))
}

pub fn spawn_playlist_enrich(app: AppHandle, playlist_id: i64) {
    if playlist_id <= 0 {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _guard = ENRICH_SERIAL.lock().await;
        if let Err(e) = run_enrich(app, playlist_id).await {
            eprintln!("import enrich playlist {playlist_id}: {e}");
        }
    });
}

async fn run_enrich(app: AppHandle, playlist_id: i64) -> Result<(), String> {
    let st: tauri::State<'_, Arc<AppState>> = app.state();
    let app_state_arc = Arc::clone(&*st);
    let client = app_state_arc.client.clone();

    let row_ids: Vec<i64> = {
        let db: tauri::State<'_, DbState> = app.state();
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let rows = load_all_rows(&conn, playlist_id).map_err(|e| e.to_string())?;
        rows.into_iter().map(|r| r.id).collect()
    };

    for rid in row_ids {
        sleep(Duration::from_millis(ENRICH_DELAY_MS)).await;

        let row = {
            let db: tauri::State<'_, DbState> = app.state();
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            load_row(&conn, playlist_id, rid).map_err(|e| e.to_string())?
        };
        let Some(mut row) = row else {
            continue;
        };
        if !needs_enrichment(&row) {
            continue;
        }

        if row.catalog_id.trim().is_empty() || catalog_id_needs_rematch(&row.catalog_id, &row.catalog_provider) {
            apply_search_metadata(&app, &client, app_state_arc.as_ref(), playlist_id, &row).await?;
            let _ = app.emit(
                "import-enrich-item-done",
                serde_json::json!({ "playlistId": playlist_id, "rowId": rid }),
            );
            row = {
                let db: tauri::State<'_, DbState> = app.state();
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                load_row(&conn, playlist_id, rid)
                    .map_err(|e| e.to_string())?
                    .unwrap_or(row)
            };
        }

        if row.catalog_id.trim().is_empty() {
            continue;
        }

        let r_cover = row.clone();
        let cover_res = ensure_cover_file(&client, app_state_arc.as_ref(), &r_cover).await;
        if let Ok(Some(path)) = cover_res {
            let db: tauri::State<'_, DbState> = app.state();
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            update_row_cover_cache(&conn, playlist_id, rid, &path)?;
            let _ = app.emit(
                "import-enrich-item-done",
                serde_json::json!({ "playlistId": playlist_id, "rowId": rid }),
            );
        }

        let row = {
            let db: tauri::State<'_, DbState> = app.state();
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            load_row(&conn, playlist_id, rid)
                .map_err(|e| e.to_string())?
                .unwrap_or(row)
        };

        let need_album = row.album.trim().is_empty();
        let need_dur = row.duration_ms <= 0;
        let need_cover_url = row.cover_url.trim().is_empty();
        if need_album || need_dur || need_cover_url {
            enrich_metadata(&app, &client, app_state_arc.as_ref(), playlist_id, &row).await?;
            let _ = app.emit(
                "import-enrich-item-done",
                serde_json::json!({ "playlistId": playlist_id, "rowId": rid }),
            );
        }

        let row = {
            let db: tauri::State<'_, DbState> = app.state();
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            load_row(&conn, playlist_id, rid)
                .map_err(|e| e.to_string())?
                .unwrap_or(row)
        };

        if !row.cover_url.trim().is_empty() {
            let r_cover = row.clone();
            if let Ok(Some(path)) = ensure_cover_file(&client, app_state_arc.as_ref(), &r_cover).await {
                let db: tauri::State<'_, DbState> = app.state();
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                update_row_cover_cache(&conn, playlist_id, rid, &path)?;
                let _ = app.emit(
                    "import-enrich-item-done",
                    serde_json::json!({ "playlistId": playlist_id, "rowId": rid }),
                );
            }
        }
    }

    let _ = app.emit(
        "import-enrich-finished",
        serde_json::json!({ "playlistId": playlist_id }),
    );
    Ok(())
}
