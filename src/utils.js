/** 通用工具函数 */
import { appState } from "./state.js";
import { MSG_REQUEST_FAILED } from "./constants.js";
import { invoke } from "@tauri-apps/api/core";

// ── HTML / 格式 ──

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function formatTime(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatDurationMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "--";
  return formatTime(n / 1000);
}

export function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── DOM 工具 ──

export function setTableMutedMessage(tbody, colSpan, message) {
  if (!tbody) return;
  tbody.innerHTML = "";
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = colSpan;
  td.className = "muted";
  td.textContent = String(message ?? "");
  tr.appendChild(td);
  tbody.appendChild(tr);
}

// ── 错误处理 ──

export function warnRequestFailed(e, label) {
  if (label) console.warn(label, e);
  else console.warn(e);
}

export function alertRequestFailed(e, label) {
  warnRequestFailed(e, label);
  alert(MSG_REQUEST_FAILED);
}

// ── 播放诊断 ──

/** 供 `log_play_event` 写入 cloudplayer.log，与 Rust `pj-play` / 移动端对照 */
export function audioDiagPayload(a) {
  let bufferedEnd = null;
  try {
    if (a.buffered && a.buffered.length > 0) {
      bufferedEnd = a.buffered.end(a.buffered.length - 1);
    }
  } catch {
    /* ignore */
  }
  return {
    currentTime: a.currentTime,
    duration: a.duration,
    readyState: a.readyState,
    networkState: a.networkState,
    bufferedEnd,
  };
}

export async function logPlayEventDesktop(stage, { url = null, error_code = null, message = null, extra = null } = {}) {
  if (typeof window.__TAURI_INTERNALS__ === "undefined") return;
  try {
    await invoke("log_play_event", {
      stage,
      url,
      error_code,
      message,
      extra: extra != null ? (typeof extra === "string" ? extra : JSON.stringify(extra)) : null,
    });
  } catch {
    /* ignore */
  }
}

// ── 设置工具 ──

export function normalizeCloseAction(v) {
  const t = String(v || "ask").toLowerCase();
  return t === "quit" || t === "tray" ? t : "ask";
}

// ── 收藏 ──

export function loadLikedSet() {
  try {
    const raw = localStorage.getItem("cp_tauri_liked_ids");
    if (!raw) return new Set();
    const a = JSON.parse(raw);
    return new Set(Array.isArray(a) ? a : []);
  } catch {
    return new Set();
  }
}

export function saveLikedSet(set) {
  localStorage.setItem("cp_tauri_liked_ids", JSON.stringify([...set]));
}

// ── 播放工具 ──

export function randomNextIndex() {
  const n = appState.playQueue.length;
  if (n <= 1) return 0;
  let j = appState.playIndex;
  let guard = 0;
  while (j === appState.playIndex && guard++ < 12) {
    j = Math.floor(Math.random() * n);
  }
  return j;
}

export function isSamePlayableIdentity(a, b) {
  if (!a || !b) return false;
  return (
    (a.local_path || "") === (b.local_path || "") &&
    (a.source_id || "").trim() === (b.source_id || "").trim()
  );
}

export function formatNowPlayingSubtitle(track) {
  if (track?.local_path) {
    return track?.artist ? `${track.artist} · 本地` : "本地音乐";
  }
  return track?.artist ? `${track.artist} · 在线试听` : "在线试听";
}

export function formatLoadingSubtitle(track) {
  const base = track?.local_path
    ? track?.artist
      ? `${track.artist}`
      : "本地音乐"
    : track?.artist
      ? `${track.artist}`
      : "在线试听";
  return `${base} · ${track?.local_path ? "正在加载本地文件…" : "正在拉取音频…"}`;
}

// ── 曲库 id 归一化 ──

/** @param {Record<string, unknown>} r */
export function catalogIdFromRow(r) {
  return String(
    r.source_id ?? r.sourceId ?? r.catalog_id ?? r.catalogId ?? "",
  ).trim();
}

/** @param {Record<string, unknown>} r */
export function catalogProviderFromRow(r) {
  return String(r.catalog_provider ?? r.catalogProvider ?? "").trim();
}

// ── 表格标题列 ──

/**
 * 发现搜索 / 导入歌单表格中「标题」列：标题 + 歌手；已下载曲目在歌手行右侧显示小字「已下载」。
 * @param {{ title?: string, artist?: string, source_id?: string, catalog_id?: string }} r
 * @param {{ titleFallback?: string }} [opts]
 */
export function discoverPlaylistTitleCellHtml(r, opts = {}) {
  const titleFallback = opts.titleFallback ?? "—";
  const sid = catalogIdFromRow(r);
  const showDl = sid && appState.downloadedSourceIds.has(sid);
  const hasTitle = r.title != null && String(r.title).trim() !== "";
  const titleLine = `<span class="t-title">${escapeHtml(hasTitle ? String(r.title) : titleFallback)}</span>`;
  const hasArt = (r.artist || "").trim();
  if (!hasArt) {
    if (!showDl) return titleLine;
    return `${titleLine}<div class="t-art-row t-art-row--end"><span class="t-dl-badge">已下载</span></div>`;
  }
  const artEsc = escapeHtml(r.artist);
  const artBlock = showDl
    ? `<div class="t-art-row"><span class="t-art">${artEsc}</span><span class="t-dl-badge">已下载</span></div>`
    : `<span class="t-art">${artEsc}</span>`;
  return `${titleLine}${artBlock}`;
}

// ── 队列项转换 ──

export function searchResultToQueueItem(r) {
  return {
    source_id: r.source_id,
    title: r.title,
    artist: r.artist || "",
    album: r.album || "",
    cover_url: r.cover_url || null,
  };
}

/** 导入歌单行 → 队列项（可无曲库 id，播放时会尝试 `try_fill_playlist_item_source_id`） */
export function playlistImportRowToQueueItem(r) {
  return {
    source_id: catalogIdFromRow(r),
    title: r.title,
    artist: r.artist || "",
    album: r.album || "",
    cover_url: (r.cover_url || "").trim() || null,
    import_playlist_id: appState.selectedPlaylistId != null ? appState.selectedPlaylistId : null,
    import_item_id: r.id != null ? r.id : null,
  };
}

/** 本地曲库行 → 播放队列项 */
export function localLibraryRowToQueueItem(r) {
  return {
    title: r.title || "",
    artist: r.artist || "",
    local_path: (r.file_path || "").trim(),
    cover_url: null,
  };
}

/** 「下载歌曲」Tab 行 → 播放队列项 */
export function downloadedSongRowToQueueItem(r) {
  const fp = String(r.file_path ?? r.filePath ?? "").trim();
  return {
    title: r.title || "",
    artist: r.artist || "",
    album: r.album || "",
    local_path: fp,
    cover_url: null,
    source_id: catalogIdFromRow(r) || undefined,
  };
}

/**
 * @param {{ title?: string, artist?: string, album?: string, sourceId?: string, source_id?: string, catalog_id?: string, coverUrl?: string | null, cover_url?: string | null, playUrl?: string, play_url?: string, durationMs?: number, duration_ms?: number }} track
 */
export function buildPlaylistImportItem(track = {}) {
  const sid = String(
    track.sourceId ?? track.source_id ?? track.catalog_id ?? track.catalogId ?? "",
  ).trim();
  const cover = String(track.coverUrl ?? track.cover_url ?? "").trim();
  const playUrl = String(track.playUrl ?? track.play_url ?? "").trim();
  const durationRaw = Number(track.durationMs ?? track.duration_ms ?? 0);
  return {
    title: String(track.title || "").trim(),
    artist: String(track.artist || "").trim(),
    album: String(track.album || "").trim(),
    source_id: sid,
    cover_url: cover,
    play_url: playUrl,
    duration_ms: Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : 0,
  };
}

// ── 歌单/下载工具 ──

export async function listPlaylistsCached() {
  try {
    return await invoke("list_playlists");
  } catch (e) {
    console.warn("list_playlists", e);
    return [];
  }
}

/** @param {{ sourceId?: string, title?: string, artist?: string }} track */
export async function enqueueDownloadForTrack(track, quality) {
  const sid = (track.sourceId || "").trim();
  if (!sid) {
    alert("无曲库 id，无法下载。");
    return;
  }
  try {
    await invoke("enqueue_download", {
      job: {
        source_id: sid,
        title: track.title || "",
        artist: track.artist || "",
        quality,
      },
    });
  } catch (e) {
    alertRequestFailed(e, "enqueue_download");
  }
}

export async function refreshDownloadedSourceIdSet() {
  try {
    const rows = await invoke("list_downloaded_songs");
    appState.downloadedSourceIds = new Set(
      (rows || [])
        .map((r) => catalogIdFromRow(r))
        .filter(Boolean),
    );
  } catch {
    appState.downloadedSourceIds = new Set();
  }
}
