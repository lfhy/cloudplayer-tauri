//! 顺序下载队列：通过 provider trait 委托具体下载实现。

use std::error::Error;
use std::sync::Arc;
use std::path::{Path, PathBuf};

use log::{error, info, warn};
use reqwest::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::config::{default_download_dir, Settings};

fn persist_downloaded_record(app: &AppHandle, path: &Path, job: &DownloadJob, written_len: u64) {
    let Some(state) = app.try_state::<crate::db::DbState>() else {
        warn!(target: "download", "DbState missing, skip downloaded_tracks insert");
        return;
    };
    let file_size = std::fs::metadata(path)
        .map(|m| m.len() as i64)
        .unwrap_or(written_len as i64);
    let (duration_ms, album_tag) = crate::download_meta::probe_audio_file(path);
    let path_str = path.to_string_lossy().to_string();
    let completed_at = chrono::Utc::now().timestamp_millis();
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(e) => {
            warn!(target: "download", "db lock: {}", e);
            return;
        }
    };
    if let Err(e) = crate::db::insert_downloaded_track(
        &conn,
        &path_str,
        job.title.trim(),
        job.artist.trim(),
        album_tag.trim(),
        duration_ms,
        file_size,
        job.source_id.trim(),
        crate::music_catalog::parse_catalog_id(&job.source_id).provider.as_str(),
        job.quality.trim(),
        completed_at,
    ) {
        warn!(target: "download", "insert downloaded_tracks: {}", e);
    }
}

/// 把 `reqwest` 的根因（TLS/DNS/连接等）拼进文案，便于与「站点业务错误」区分。
fn format_reqwest_err(e: &reqwest::Error) -> String {
    let mut parts: Vec<String> = vec![e.to_string()];
    let mut cur: Option<&dyn Error> = e.source();
    while let Some(c) = cur {
        parts.push(c.to_string());
        cur = c.source();
    }
    let detail = parts.join(" | ");
    let hint = if e.is_timeout() {
        "（请求超时：可检查网络、代理或稍后重试）"
    } else if e.is_connect() {
        "（无法连接服务器：DNS、防火墙、代理或目标站点不可达）"
    } else if e.is_request() {
        "（请求构建或发送阶段失败）"
    } else {
        ""
    };
    if hint.is_empty() {
        detail
    } else {
        format!("{detail}{hint}")
    }
}

#[derive(Debug, Clone)]
pub struct DownloadJob {
    pub source_id: String,
    pub title: String,
    pub artist: String,
    pub quality: String,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTaskEvent {
    pub source_id: String,
    pub title: String,
    pub artist: String,
    pub quality: String,
    pub status: String,
    pub progress: f64,
    pub message: Option<String>,
}

fn emit_download_step(
    task: &mut DownloadTaskEvent,
    emit: &impl Fn(DownloadTaskEvent),
    progress: f64,
    msg: impl Into<String>,
) {
    task.progress = progress.clamp(0.0, 1.0);
    task.message = Some(msg.into());
    emit(task.clone());
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect()
}

fn dest_root() -> PathBuf {
    let s = Settings::load();
    let p = s.download_folder.trim();
    if p.is_empty() {
        default_download_dir()
    } else {
        PathBuf::from(p)
    }
}

/// 与 `run_one_job` 落盘规则一致：`{title} - {artist}.mp3` / `.flac`，用于播放时优先走已下载文件。
pub fn candidate_downloaded_audio_paths(title: &str, artist: &str) -> Vec<PathBuf> {
    let root = dest_root();
    let name_mp3 = sanitize_filename(&format!("{} - {}.mp3", title.trim(), artist.trim()));
    let name_flac = sanitize_filename(&format!("{} - {}.flac", title.trim(), artist.trim()));
    vec![root.join(name_mp3), root.join(name_flac)]
}

fn check_and_reserve_download_slot() -> Result<(), String> {
    let mut s = Settings::load();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if s.downloads_today_date != today {
        s.downloads_today_date = today;
        s.downloads_today_count = 0;
    }
    if s.daily_download_limit > 0 && s.downloads_today_count >= s.daily_download_limit {
        return Err(format!(
            "已达到当日下载上限（{} 次）",
            s.daily_download_limit
        ));
    }
    Ok(())
}

fn download_fail_emit(
    task: &mut DownloadTaskEvent,
    emit: &impl Fn(DownloadTaskEvent),
    job: &DownloadJob,
    msg: String,
) {
    error!(
        target: "download",
        "{} | source_id={} title={} artist={}",
        msg,
        job.source_id,
        job.title,
        job.artist
    );
    task.status = "failed".to_string();
    task.message = Some(msg);
    emit(task.clone());
}

fn record_download_success() -> Result<(), String> {
    let mut s = Settings::load();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if s.downloads_today_date != today {
        s.downloads_today_date = today;
        s.downloads_today_count = 0;
    }
    s.downloads_today_count += 1;
    s.save()
}

pub async fn run_one_job(client: Client, app: AppHandle, job: DownloadJob) {
    let emit = |task: DownloadTaskEvent| {
        let _ = app.emit("download-task-changed", &task);
    };

    let mut task = DownloadTaskEvent {
        source_id: job.source_id.clone(),
        title: job.title.clone(),
        artist: job.artist.clone(),
        quality: job.quality.clone(),
        status: "queued".to_string(),
        progress: 0.0,
        message: None,
    };

    let (provider, catalog_track_id) = {
        let st = app.state::<Arc<crate::commands::AppState>>();
        match st.catalog.require_download_provider(&job.source_id) {
            Ok((provider, track_id)) => (provider, track_id),
            Err(e) => {
                download_fail_emit(&mut task, &emit, &job, e);
                return;
            }
        }
    };

    if let Err(e) = check_and_reserve_download_slot() {
        download_fail_emit(&mut task, &emit, &job, e);
        return;
    }

    task.status = "downloading".to_string();
    emit(task.clone());
    emit_download_step(&mut task, &emit, 0.05, "准备下载…");

    let ext = if job.quality == "flac" { ".flac" } else { ".mp3" };
    let name = sanitize_filename(&format!("{} - {}{}", job.title, job.artist, ext));
    let root = dest_root();
    if let Err(e) = tokio::fs::create_dir_all(&root).await {
        download_fail_emit(&mut task, &emit, &job, format!("创建目录: {e}"));
        return;
    }
    let out_path = root.join(name);

    info!(
        target: "download",
        "starting download source_id={} provider={} dest={}",
        job.source_id,
        provider.name(),
        out_path.display()
    );

    match provider
        .download_full(&client, &catalog_track_id, &job.quality, &out_path)
        .await
    {
        Ok(()) => {
            let written = std::fs::metadata(&out_path)
                .map(|m| m.len())
                .unwrap_or(0);

            if let Err(e) = record_download_success() {
                log::warn!(
                    target: "download",
                    "saved file but daily count failed: {} | source_id={}",
                    e,
                    job.source_id
                );
                task.message = Some(format!("已保存但计数失败: {e}"));
            } else {
                task.message = Some(format!("已保存: {}", out_path.display()));
            }
            persist_downloaded_record(&app, out_path.as_path(), &job, written);
            task.status = "completed".to_string();
            task.progress = 1.0;
            info!(
                target: "download",
                "completed source_id={} path={}",
                job.source_id,
                out_path.display()
            );
            emit(task);
        }
        Err(e) => {
            download_fail_emit(&mut task, &emit, &job, e);
        }
    }
}

/// 流式下载音频到文件（不发 Tauri 事件、不计每日额度）。供 provider 实现内部复用。
pub async fn stream_audio_to_file(
    client: &Client,
    music_url: &str,
    referer: &str,
    out_path: &Path,
) -> Result<u64, String> {
    use futures_util::StreamExt;

    let resp = client
        .get(music_url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .header("Referer", referer)
        .send()
        .await
        .map_err(|e| format!("音频请求: {}", format_reqwest_err(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("音频 HTTP {}", resp.status()));
    }
    if let Some(parent) = out_path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return Err(format!("创建目录: {e}"));
        }
    }
    let mut file = tokio::fs::File::create(out_path)
        .await
        .map_err(|e| format!("创建文件: {e}"))?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| format!("下载流: {}", format_reqwest_err(&e)))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入: {e}"))?;
        received += chunk.len() as u64;
    }
    file.flush().await.map_err(|e| format!("写入: {e}"))?;
    Ok(received)
}
