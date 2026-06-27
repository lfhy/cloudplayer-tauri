use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use rusqlite::OptionalExtension;

use super::AppState;
use crate::db::DbState;
use crate::import_enrich;
use crate::music_catalog::parse_catalog_id;
use crate::music_catalog::PROVIDER_NONE;

#[derive(Debug, Deserialize)]
pub struct ImportItemIn {
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default, alias = "pjmp3_source_id", alias = "pjmp3SourceId", alias = "catalog_id", alias = "catalogId")]
    pub source_id: String,
    #[serde(default, alias = "coverUrl")]
    pub cover_url: String,
    #[serde(default, alias = "playUrl")]
    pub play_url: String,
    #[serde(default, alias = "durationMs")]
    pub duration_ms: i64,
}

#[derive(Serialize)]
pub struct PlaylistRow {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub is_favorites: bool,
}

#[derive(Serialize)]
pub struct PlaylistSummaryRow {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
    #[serde(default)]
    pub cover_url: String,
    #[serde(default)]
    pub is_favorites: bool,
}

#[derive(Serialize)]
pub struct PlaylistImportItemRow {
    pub id: i64,
    pub sort_order: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    #[serde(alias = "catalog_id", alias = "catalogId", alias = "pjmp3_source_id", alias = "pjmp3SourceId")]
    pub catalog_id: String,
    #[serde(default)]
    pub catalog_provider: String,
    pub cover_url: String,
    pub duration_ms: i64,
}

#[tauri::command]
pub fn list_playlists(state: State<'_, DbState>) -> Result<Vec<PlaylistRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, is_favorites FROM playlists ORDER BY is_favorites DESC, name COLLATE NOCASE")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PlaylistRow {
                id: r.get(0)?,
                name: r.get(1)?,
                is_favorites: r.get::<_, i64>(2)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_playlists_summary(state: State<'_, DbState>) -> Result<Vec<PlaylistSummaryRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name, COUNT(i.id) AS cnt, \
             COALESCE((SELECT TRIM(COALESCE(i2.cover_url, '')) FROM playlist_import_items i2 \
              WHERE i2.playlist_id = p.id AND LENGTH(TRIM(COALESCE(i2.cover_url, ''))) > 0 \
              ORDER BY i2.sort_order ASC, i2.id ASC LIMIT 1), '') AS cover_url, \
              p.is_favorites \
             FROM playlists p \
             LEFT JOIN playlist_import_items i ON i.playlist_id = p.id \
             GROUP BY p.id \
             ORDER BY p.is_favorites DESC, p.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PlaylistSummaryRow {
                id: r.get(0)?,
                name: r.get(1)?,
                track_count: r.get(2)?,
                cover_url: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                is_favorites: r.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_playlist_import_items(state: State<'_, DbState>, playlist_id: i64) -> Result<Vec<PlaylistImportItemRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(r#"SELECT id, sort_order, title, artist, album, pjmp3_source_id, catalog_provider, cover_url, duration_ms
               FROM playlist_import_items WHERE playlist_id=?1 ORDER BY sort_order ASC, id ASC"#)
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([playlist_id], |r| {
            Ok(PlaylistImportItemRow {
                id: r.get(0)?,
                sort_order: r.get(1)?,
                title: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                artist: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                album: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                catalog_id: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                catalog_provider: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                cover_url: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
                duration_ms: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_playlist(state: State<'_, DbState>, name: String) -> Result<i64, String> {
    let n = name.trim();
    if n.is_empty() { return Err("歌单名称不能为空".into()); }
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO playlists (name) VALUES (?1)", [n]).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn rename_playlist(state: State<'_, DbState>, playlist_id: i64, name: String) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() { return Err("歌单名称不能为空".into()); }
    if playlist_id <= 0 { return Err("无效的歌单 id".into()); }
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let nchg = conn.execute("UPDATE playlists SET name=?1 WHERE id=?2", rusqlite::params![n, playlist_id]).map_err(|e| e.to_string())?;
    if nchg == 0 { return Err("歌单不存在".into()); }
    Ok(())
}

#[tauri::command]
pub fn delete_playlist(state: State<'_, DbState>, playlist_id: i64) -> Result<(), String> {
    if playlist_id <= 0 { return Err("无效的歌单 id".into()); }
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let nchg = conn.execute("DELETE FROM playlists WHERE id=?1", [playlist_id]).map_err(|e| e.to_string())?;
    if nchg == 0 { return Err("歌单不存在".into()); }
    Ok(())
}

#[tauri::command]
pub fn delete_playlist_import_item(state: State<'_, DbState>, playlist_id: i64, item_id: i64) -> Result<(), String> {
    if playlist_id <= 0 || item_id <= 0 { return Err("无效的 id".into()); }
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let nchg = conn.execute("DELETE FROM playlist_import_items WHERE id=?1 AND playlist_id=?2", rusqlite::params![item_id, playlist_id]).map_err(|e| e.to_string())?;
    if nchg == 0 { return Err("未找到该导入条目".into()); }
    Ok(())
}

fn catalog_provider_for_item(source_id: &str) -> String {
    let parsed = parse_catalog_id(source_id);
    if parsed.provider != PROVIDER_NONE && !parsed.provider.is_empty() {
        parsed.provider
    } else {
        crate::music_catalog::CatalogService::active_provider_name()
    }
}

#[tauri::command]
pub fn replace_playlist_import_items(app: AppHandle, state: State<'_, DbState>, playlist_id: i64, items: Vec<ImportItemIn>) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM playlist_import_items WHERE playlist_id=?1", [playlist_id]).map_err(|e| e.to_string())?;
    for (i, t) in items.iter().enumerate() {
        let sid = t.source_id.trim();
        let provider = catalog_provider_for_item(sid);
        tx.execute(
            r#"INSERT INTO playlist_import_items (playlist_id, sort_order, title, artist, album, play_url, pjmp3_source_id, catalog_provider, cover_url, cover_cache_path, duration_ms, audio_cache_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '', ?10, '')"#,
            rusqlite::params![playlist_id, i as i64, t.title.trim(), t.artist.trim(), t.album.trim(), t.play_url.trim(), sid, provider, t.cover_url.trim(), t.duration_ms.max(0)],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    import_enrich::spawn_playlist_enrich(app, playlist_id);
    Ok(())
}

#[tauri::command]
pub fn append_playlist_import_items(app: AppHandle, state: State<'_, DbState>, playlist_id: i64, items: Vec<ImportItemIn>) -> Result<(), String> {
    if playlist_id <= 0 { return Err("无效的歌单 id".into()); }
    if items.is_empty() { return Ok(()); }
    let shift: i64 = items.len() as i64;
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE playlist_import_items SET sort_order = sort_order + ?1 WHERE playlist_id = ?2", rusqlite::params![shift, playlist_id]).map_err(|e| e.to_string())?;
    for (i, t) in items.iter().enumerate() {
        let sid = t.source_id.trim();
        let provider = catalog_provider_for_item(sid);
        tx.execute(
            r#"INSERT INTO playlist_import_items (playlist_id, sort_order, title, artist, album, play_url, pjmp3_source_id, catalog_provider, cover_url, cover_cache_path, duration_ms, audio_cache_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '', ?10, '')"#,
            rusqlite::params![playlist_id, i as i64, t.title.trim(), t.artist.trim(), t.album.trim(), t.play_url.trim(), sid, provider, t.cover_url.trim(), t.duration_ms.max(0)],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    import_enrich::spawn_playlist_enrich(app, playlist_id);
    Ok(())
}

#[tauri::command]
pub fn start_import_enrich(app: AppHandle, playlist_id: i64) -> Result<(), String> {
    if playlist_id <= 0 { return Err("无效的歌单 id".into()); }
    import_enrich::spawn_playlist_enrich(app, playlist_id);
    Ok(())
}

#[tauri::command]
pub async fn try_fill_playlist_item_source_id(app: AppHandle, state: State<'_, Arc<AppState>>, db: State<'_, DbState>, playlist_id: i64, item_id: i64) -> Result<Option<String>, String> {
    if playlist_id <= 0 || item_id <= 0 { return Err("无效的 id".into()); }
    let empty_before = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let s: String = conn.query_row("SELECT IFNULL(pjmp3_source_id,'') FROM playlist_import_items WHERE id=?1 AND playlist_id=?2", rusqlite::params![item_id, playlist_id], |r| r.get::<_, String>(0)).optional().map_err(|e| e.to_string())?.unwrap_or_default();
        s.trim().is_empty()
    };
    let client = state.client.clone();
    let out = import_enrich::try_resolve_import_row_source_id(&app, &client, state.inner().as_ref(), playlist_id, item_id).await?;
    let newly_filled = empty_before && out.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false);
    if newly_filled {
        let _ = app.emit("import-enrich-item-done", serde_json::json!({ "playlistId": playlist_id, "rowId": item_id }));
        import_enrich::spawn_playlist_enrich(app.clone(), playlist_id);
    }
    Ok(out)
}

/// 重新触发所有歌单的导入富化（用于曲库源切换后补充新 source_id）。
#[tauri::command]
pub fn re_enrich_all_playlists(app: AppHandle, state: State<'_, DbState>) -> Result<(), String> {
    let ids: Vec<i64> = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id FROM playlists")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(id) = row {
                out.push(id);
            }
        }
        out
    };

    for pid in ids {
        import_enrich::spawn_playlist_enrich(app.clone(), pid);
    }
    Ok(())
}
