use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbState;
use crate::music_catalog::parse_catalog_id;
use crate::music_catalog::CatalogService;

const RECENT_PLAYS_MAX: i64 = 100;

#[derive(Debug, Deserialize)]
pub struct RecentPlayIn {
    pub kind: String,
    pub title: String,
    pub artist: String,
    pub cover_url: Option<String>,
    #[serde(default, alias = "catalog_id", alias = "catalogId", alias = "pjmp3_source_id", alias = "pjmp3SourceId")]
    pub catalog_id: Option<String>,
    #[serde(default, alias = "catalogProvider")]
    pub catalog_provider: Option<String>,
    pub file_path: Option<String>,
    /// 在线曲目上次成功播放使用的直链（用于解析降级前优先重试）
    #[serde(default)]
    pub play_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentPlayRow {
    pub kind: String,
    pub title: String,
    pub artist: String,
    pub cover_url: Option<String>,
    #[serde(alias = "catalog_id", alias = "catalogId", alias = "pjmp3_source_id", alias = "pjmp3SourceId")]
    pub catalog_id: Option<String>,
    #[serde(default)]
    pub catalog_provider: Option<String>,
    pub file_path: Option<String>,
    pub play_url: Option<String>,
    pub played_at: i64,
}

#[tauri::command]
pub fn list_recent_plays(state: State<'_, DbState>) -> Result<Vec<RecentPlayRow>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT kind, title, artist, cover_url, pjmp3_source_id, catalog_provider, file_path,
                    IFNULL(play_url, ''), played_at
             FROM recent_plays ORDER BY played_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([RECENT_PLAYS_MAX], |r| {
            let pu: String = r.get(7)?;
            let cp: String = r.get::<_, Option<String>>(5)?.unwrap_or_default();
            Ok(RecentPlayRow {
                kind: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                artist: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                cover_url: r.get(3)?,
                catalog_id: r.get(4)?,
                catalog_provider: if cp.trim().is_empty() {
                    None
                } else {
                    Some(cp)
                },
                file_path: r.get(6)?,
                play_url: if pu.trim().is_empty() {
                    None
                } else {
                    Some(pu)
                },
                played_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn record_recent_play(state: State<'_, DbState>, row: RecentPlayIn) -> Result<(), String> {
    let k = row.kind.trim();
    if k != "online" && k != "local" {
        return Err("kind 须为 online 或 local".to_string());
    }
    if k == "online" {
        let sid = row.catalog_id.as_ref().map(|s| s.trim()).unwrap_or("");
        if sid.is_empty() {
            return Err("online 须含曲库 id（catalog_id）".to_string());
        }
    } else {
        let fp = row.file_path.as_ref().map(|s| s.trim()).unwrap_or("");
        if fp.is_empty() {
            return Err("local 须含 file_path".to_string());
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    let catalog_provider = row
        .catalog_provider
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            row.catalog_id
                .as_ref()
                .map(|s| parse_catalog_id(s).provider)
                .filter(|p| p != "none")
                .unwrap_or_else(CatalogService::active_provider_name)
        });

    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if k == "online" {
        let sid = row.catalog_id.as_ref().map(|s| s.trim()).unwrap_or("");
        tx.execute(
            "DELETE FROM recent_plays WHERE kind='online' AND pjmp3_source_id=?1",
            [sid],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let fp = row.file_path.as_ref().map(|s| s.trim()).unwrap_or("");
        tx.execute("DELETE FROM recent_plays WHERE kind='local' AND file_path=?1", [fp])
            .map_err(|e| e.to_string())?;
    }
    let (pid, fpath): (Option<String>, Option<String>) = if k == "online" {
        (row.catalog_id, None)
    } else {
        (None, row.file_path)
    };
    let play_url = row
        .play_url
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    tx.execute(
        "INSERT INTO recent_plays (kind, title, artist, cover_url, pjmp3_source_id, catalog_provider, file_path, play_url, played_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![k, row.title, row.artist, row.cover_url, pid, catalog_provider, fpath, play_url, now],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        &format!(
            "DELETE FROM recent_plays WHERE id NOT IN (SELECT id FROM recent_plays ORDER BY played_at DESC LIMIT {RECENT_PLAYS_MAX})"
        ),
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
