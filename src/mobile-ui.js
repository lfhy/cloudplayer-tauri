import "./mobile-ui.css";
import {
  buildImportCsvBlobUtf8,
  buildImportTxtBlob,
  triggerBlobDownload,
} from "./export-playlist.js";
import { convertFileSrc, invoke as invokeTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  mediaNotifUpdate,
  mediaNotifSetState,
  mediaNotifClear,
  mediaNotifRequestPermission,
} from "./mobile-media-notif.js";

/** 是否在 Tauri WebView 内（浏览器 ?cp_mobile=1 预览时无 IPC） */
function hasTauriIpc() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke(cmd, args) {
  if (!hasTauriIpc()) {
    throw new Error(
      "仅在 CloudPlayer 应用内可用。开发调试请用：npm run android:dev（真机/模拟器热重载）；浏览器可访问 ?cp_mobile=1 仅预览布局。",
    );
  }
  if (args === undefined) return invokeTauri(cmd);
  return invokeTauri(cmd, args);
}

function errText(e) {
  if (typeof e === "string") return e;
  if (e && typeof e.message === "string" && e.message) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** 供 `log_play_event` 写入 cloudplayer.log，与 Rust `pj-play` 对照 */
function audioDiagPayload(a) {
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

async function logPlayEventMobile(stage, { url = null, error_code = null, message = null, extra = null } = {}) {
  if (!hasTauriIpc()) return;
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

/**
 * Android WebView：`convertFileSrc` 对本地音频只缓冲开头，约 30s 停播（tauri-apps/tauri#14776）。
 * 应用内整文件读入后 `Blob` + `URL.createObjectURL` 可完整播放。
 */
let lastAudioObjectUrl = null;

function revokeMobileAudioObjectUrl() {
  if (lastAudioObjectUrl) {
    try {
      URL.revokeObjectURL(lastAudioObjectUrl);
    } catch {
      /* ignore */
    }
    lastAudioObjectUrl = null;
  }
}

function mimeForAudioPath(p) {
  const low = String(p || "").toLowerCase();
  if (low.endsWith(".mp3")) return "audio/mpeg";
  if (low.endsWith(".m4a")) return "audio/mp4";
  if (low.endsWith(".aac")) return "audio/aac";
  if (low.endsWith(".flac")) return "audio/flac";
  if (low.endsWith(".ogg")) return "audio/ogg";
  if (low.endsWith(".wav")) return "audio/wav";
  return "audio/mpeg";
}

function bytesToUint8(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return new Uint8Array(raw);
  return new Uint8Array(raw);
}

/** @param {string} path */
async function playableUrlFromLocalPath(path) {
  if (!hasTauriIpc()) {
    return convertFileSrc(path);
  }
  const raw = await invoke("read_file_bytes", { path });
  const u8 = bytesToUint8(raw);
  revokeMobileAudioObjectUrl();
  const blob = new Blob([u8], { type: mimeForAudioPath(path) });
  lastAudioObjectUrl = URL.createObjectURL(blob);
  return lastAudioObjectUrl;
}

/** 与桌面 `persistRecentPlaySnapshot` 一致：写入 DB，供 `resolve_online_play` 的「最近播放直链」分支 */
async function persistRecentPlaySnapshot(snap) {
  try {
    if (snap.local_path) {
      await invoke("record_recent_play", {
        row: {
          kind: "local",
          title: snap.title,
          artist: snap.artist || "",
          cover_url: null,
          catalog_id: null,
          file_path: snap.local_path,
        },
      });
    } else {
      await invoke("record_recent_play", {
        row: {
          kind: "online",
          title: snap.title,
          artist: snap.artist || "",
          cover_url: snap.cover_url ?? null,
          catalog_id: snap.source_id,
          file_path: null,
          play_url: snap.play_url && String(snap.play_url).trim() ? String(snap.play_url).trim() : null,
        },
      });
    }
  } catch (e) {
    console.warn("record_recent_play", e);
  }
}

/**
 * 在线曲目成功开播后写入最近播放（含本次 http 直链，便于下次优先解析）
 * @param {string | null} [onlinePlayUrl]
 */
function pushMobileRecentFromCurrentTrack(onlinePlayUrl = null) {
  const it = playQueue[playIndex];
  if (!it) return;
  if (it.local_path) {
    void persistRecentPlaySnapshot({ title: it.title, artist: it.artist || "", local_path: it.local_path });
    return;
  }
  const sid = (it.source_id || "").trim();
  if (!sid) return;
  const pu = onlinePlayUrl && String(onlinePlayUrl).trim() ? String(onlinePlayUrl).trim() : "";
  void persistRecentPlaySnapshot({
    source_id: sid,
    title: it.title,
    artist: it.artist || "",
    album: it.album || "",
    cover_url: it.cover_url || null,
    ...(pu ? { play_url: pu } : {}),
  });
}

/** 补全曲库 id 后更新歌单详情行样式（与桌面更新表格类似） */
function patchPlaylistDetailRowAfterFill(itemId, _fid) {
  const li = document.querySelector(`#cp-m-pl-tracks-ul li[data-item-id="${itemId}"]`);
  if (!li) return;
  li.style.opacity = "1";
  const row = playlistDetailRows.find((r) => Number(r.id) === Number(itemId));
  const sub = li.querySelector(".cp-m-li-sub");
  if (sub && row) {
    sub.textContent = row.artist || "";
  }
}

const PLACEHOLDER_COVER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Crect fill='%23e5e7eb' width='48' height='48'/%3E%3C/svg%3E";

/**
 * @type {Array<{
 *   source_id?: string;
 *   title: string;
 *   artist: string;
 *   album?: string;
 *   cover_url?: string | null;
 *   local_path?: string;
 *   import_playlist_id?: number | null;
 *   import_item_id?: number | null;
 * }>}
 */
let playQueue = [];
let playIndex = 0;
let playLoadGeneration = 0;
let audioSourceGeneration = 0;
/** 取消进行中的预解析任务 */
let prefetchJobId = 0;
/** 当前曲播放期间预解析的下一首（自动切歌时命中则跳过 resolve） @type {null | { listeningGen: number; fromIdx: number; nextIdx: number; songId: string; resolved: { kind: string; url?: string; path?: string; via?: string } }} */
let prefetchedNextPlay = null;
let prefetchNearEndLastTs = 0;
let lastAutoRetryTrackIdx = -1;
let lastAutoRetryAt = 0;
let seekDragging = false;
/** `progress` 上报节流：最多每秒一条 */
let audioProgressLogLastTs = 0;

/** 与桌面 `PLAY_MODES` 一致：序 → 循 → 单 → 随（移动端用图标，文案见 tip） */
const PLAY_MODES = [
  { key: "sequential", label: "序", tip: "顺序播放（点击切换模式）" },
  { key: "loop_list", label: "循", tip: "列表循环" },
  { key: "one", label: "单", tip: "单曲循环" },
  { key: "shuffle", label: "随", tip: "随机播放" },
];

/** 播放顺序按钮内图标（stroke 继承 currentColor，适配深浅底） */
function playModeIconInnerHtml(modeKey) {
  const S = `<svg class="cp-m-play-mode-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`;
  switch (modeKey) {
    case "sequential":
      /* 列表 + 前进：顺序播放 */
      return `${S}<path d="M4 6h11"/><path d="M4 12h9"/><path d="M4 18h11"/><path d="M17 8l4 4-4 4"/></svg>`;
    case "loop_list":
      /* 双箭头环：列表循环 */
      return `${S}<path d="M17 2.3L21 6l-3.8 3.8"/><path d="M3 11.2V10A7 7 0 0110 3h11"/><path d="M7 21.7 3 18l3.8-3.8"/><path d="M21 12.8V14a7 7 0 01-7 7H3"/></svg>`;
    case "one":
      /* 循环 + 1：单曲循环 */
      return `${S}<path d="M17 2.3L21 6l-3.8 3.8"/><path d="M3 11.2V10A7 7 0 0110 3h11"/><path d="M7 21.7 3 18l3.8-3.8"/><path d="M21 12.8V14a7 7 0 01-7 7H3"/><text x="12" y="16.2" font-size="7.5" fill="currentColor" stroke="none" text-anchor="middle" font-weight="700">1</text></svg>`;
    case "shuffle":
      /* 双向交叉箭头：随机 */
      return `${S}<path d="M7.5 20.5 3 16m0 0 4.5-4.5M3 16h11.5a4 4 0 003.9-3.1"/><path d="M16.5 3.5 21 8m0 0-4.5 4.5M21 8H9.5a4 4 0 00-3.9 3.1"/></svg>`;
    default:
      return `${S}<path d="M4 6h16"/><path d="M4 12h12"/><path d="M4 18h16"/></svg>`;
  }
}

function loadPlayModeIndex() {
  try {
    const v = Number(localStorage.getItem("cp_m_play_mode_idx"));
    if (Number.isFinite(v) && v >= 0 && v < PLAY_MODES.length) return v;
  } catch {
    /* ignore */
  }
  return 0;
}

let playModeIndex = loadPlayModeIndex();

/** 自动下一首：略推迟再解析，减轻 Android 上「ended 后立即请求」导致的瞬时 DNS 失败 */
const MOBILE_AUTO_NEXT_DELAY_MS = 260;
let mobileAudioEndedAt = 0;

function schedulePlayFromQueueIndex(idx) {
  window.setTimeout(() => {
    void playFromQueueIndex(idx);
  }, MOBILE_AUTO_NEXT_DELAY_MS);
}

function randomNextIndex() {
  const n = playQueue.length;
  if (n <= 1) return 0;
  let j = playIndex;
  let guard = 0;
  while (j === playIndex && guard++ < 12) {
    j = Math.floor(Math.random() * n);
  }
  return j;
}

function invalidateMobilePrefetch() {
  prefetchJobId += 1;
  prefetchedNextPlay = null;
}

/** @returns {number | null} */
function computePrefetchNextIndex(fromIdx, n, modeKey) {
  if (n < 2) return null;
  if (modeKey === "one") return null;
  if (modeKey === "loop_list") return (fromIdx + 1) % n;
  if (modeKey === "shuffle") return randomNextIndex();
  if (fromIdx >= n - 1) return null;
  return fromIdx + 1;
}

async function resolveOnlinePlayWithRetryMobile(songId, title, artist, isStale, opts = {}) {
  const skipRecentUrl = !!opts.skipRecentUrl;
  const resolveRetryBudgetMs = 22_000;
  let resolveBackoffMs = 280;
  const resolveT0 = Date.now();
  let lastErr = null;
  for (;;) {
    if (isStale()) return { ok: false, cancelled: true, lastErr };
    if (Date.now() - resolveT0 >= resolveRetryBudgetMs) break;
    try {
      const resolved = await invoke("resolve_online_play", {
        songId,
        title: title || "",
        artist: artist || "",
        skipRecentUrl,
      });
      return { ok: true, resolved };
    } catch (e) {
      lastErr = e;
      if (Date.now() - resolveT0 >= resolveRetryBudgetMs) break;
      const wait = Math.min(resolveBackoffMs, resolveRetryBudgetMs - (Date.now() - resolveT0));
      resolveBackoffMs = Math.min(Math.floor(resolveBackoffMs * 1.45), 2800);
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  return { ok: false, cancelled: false, lastErr };
}

function prefetchPayloadMatchesQueue(pf, idx, item) {
  if (!pf || pf.nextIdx !== idx) return false;
  const sid = (item.source_id || "").trim();
  if (sid && sid !== pf.songId) return false;
  return true;
}

async function runPrefetchNextTrack() {
  const myJob = prefetchJobId;
  const n = playQueue.length;
  const fromIdx = playIndex;
  const listeningGen = playLoadGeneration;
  const modeKey = PLAY_MODES[playModeIndex].key;
  const nextIdx = computePrefetchNextIndex(fromIdx, n, modeKey);
  if (nextIdx == null || nextIdx < 0 || nextIdx >= n) {
    prefetchedNextPlay = null;
    return;
  }
  let item = playQueue[nextIdx];
  if (!item) return;
  if (item.local_path) {
    prefetchedNextPlay = null;
    return;
  }
  let songId = (item.source_id || "").trim();
  const iPl = item.import_playlist_id;
  const iRow = item.import_item_id;
  if (!songId && iPl != null && iRow != null) {
    try {
      const filled = await invoke("try_fill_playlist_item_source_id", {
        playlistId: iPl,
        itemId: iRow,
      });
      if (myJob !== prefetchJobId || listeningGen !== playLoadGeneration || fromIdx !== playIndex) return;
      if (filled && String(filled).trim()) {
        const fid = String(filled).trim();
        songId = fid;
        playQueue[nextIdx] = { ...playQueue[nextIdx], source_id: fid };
        item = playQueue[nextIdx];
        const match = playlistDetailRows.find((row) => Number(row.id) === Number(iRow));
        if (match) match.catalog_id = fid;
        patchPlaylistDetailRowAfterFill(Number(iRow), fid);
      }
    } catch (e) {
      console.warn("prefetch try_fill", e);
    }
  }
  if (myJob !== prefetchJobId || listeningGen !== playLoadGeneration || fromIdx !== playIndex) return;
  if (!songId) return;
  const r = await resolveOnlinePlayWithRetryMobile(songId, item.title, item.artist, () => {
    return myJob !== prefetchJobId || listeningGen !== playLoadGeneration || fromIdx !== playIndex;
  });
  if (!r.ok || r.cancelled || !r.resolved) return;
  if (myJob !== prefetchJobId || listeningGen !== playLoadGeneration || fromIdx !== playIndex) return;
  const res = r.resolved;
  if ((res.kind !== "url" || !res.url) && (res.kind !== "file" || !res.path)) return;
  prefetchedNextPlay = {
    listeningGen,
    fromIdx,
    nextIdx,
    songId,
    resolved: res,
  };
}

function maybePrefetchNextNearEnd(a) {
  if (prefetchedNextPlay) return;
  if (playQueue.length < 2) return;
  const mode = PLAY_MODES[playModeIndex].key;
  if (mode === "one") return;
  const dur = a.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  if (dur - a.currentTime > 22) return;
  const now = Date.now();
  if (now - prefetchNearEndLastTs < 10_000) return;
  prefetchNearEndLastTs = now;
  void runPrefetchNextTrack();
}

/** 下载品质面板：非空时整单下载（优先于多选） @type {any[] | null} */
let pendingDownloadRows = null;

/** 「添加到歌单」面板：整单打开时固定行集（否则用多选） @type {any[] | null} */
let addToPanelPinnedRows = null;

/** @type {{ id: number; name: string } | null} */
let openPlaylistCtx = null;

/** 当前歌单详情曲目（与桌面 `playlistDetailRows` 对齐） @type {any[]} */
let playlistDetailRows = [];
let detailSelectMode = false;
/** @type {Set<number>} */
let selectedDetailIds = new Set();
let detailTrackLongPressTimer = 0;
let detailTrackLongPressSuppressClick = false;

/** 当前搜索页结果（多选与播放共用） @type {any[]} */
let searchResultRows = [];
let searchSelectMode = false;
/** @type {Set<number>} */
let selectedSearchIndices = new Set();
let searchRowLongPressTimer = 0;
let searchRowLongPressSuppressClick = false;

const DETAIL_LONG_MS = 520;

// ─── Android 物理返回键统一处理 ────────────────────────────────────────────
function androidBackInternal() {
  const addToPage = document.getElementById("cp-m-addto-page");
  if (addToPage && !addToPage.classList.contains("hidden")) { closeAddToPage(); return true; }
  const addTo = document.getElementById("cp-m-addto-panel");
  if (addTo && !addTo.classList.contains("hidden")) { closeAddToPanel(); return true; }
  const dlQ = document.getElementById("cp-m-dl-quality-panel");
  if (dlQ && !dlQ.classList.contains("hidden")) { closeDlQualityPanel(); return true; }
  const imp = document.getElementById("cp-m-import-panel");
  if (imp && !imp.classList.contains("hidden")) { closeImportPanel(); return true; }
  const sp = document.getElementById("cp-m-search-panel");
  if (sp && !sp.classList.contains("hidden")) {
    if (searchSelectMode) exitSearchSelectMode();
    else closeSearchPanel();
    return true;
  }
  const sheet = document.getElementById("cp-m-queue-sheet");
  if (sheet && !sheet.classList.contains("hidden")) { closeQueueSheet(); return true; }
  const page = document.getElementById("cp-m-np-page");
  if (page && !page.classList.contains("hidden")) { closeNowPlayingPage(); return true; }
  if (detailSelectMode) { exitDetailSelectMode(); return true; }
  const detail = document.getElementById("cp-m-pl-detail");
  if (detail && !detail.classList.contains("hidden")) { closePlaylistDetail(); return true; }
  return false;
}
window.__cpAndroidBack = () => androidBackInternal();

// ─── 媒体通知回调（Android MediaSession → JS） ───────────────────────────
let mediaNotifPermissionRequested = false;
window.__cpMediaCb = (cmd) => {
  if (cmd === "play" || cmd === "pause") {
    const a = audioEl();
    if (!a || !a.src) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  } else if (cmd === "next") {
    const n = playQueue.length;
    if (!n) return;
    const mode = PLAY_MODES[playModeIndex].key;
    if (mode === "shuffle") { void playFromQueueIndex(randomNextIndex()); return; }
    if (mode === "loop_list" && playIndex === n - 1) { void playFromQueueIndex(0); return; }
    if (playIndex < n - 1) void playFromQueueIndex(playIndex + 1);
  } else if (cmd === "prev") {
    const n = playQueue.length;
    if (!n) return;
    const mode = PLAY_MODES[playModeIndex].key;
    if (mode === "shuffle") { void playFromQueueIndex((playIndex - 1 + n) % n); return; }
    if (mode === "loop_list" && playIndex === 0) { void playFromQueueIndex(n - 1); return; }
    if (playIndex > 0) void playFromQueueIndex(playIndex - 1);
  } else if (typeof cmd === "string" && cmd.startsWith("seek:")) {
    const ms = parseInt(cmd.slice(5), 10);
    if (!isNaN(ms)) {
      const a = audioEl();
      if (a) a.currentTime = ms / 1000;
    }
  } else if (cmd === "stop") {
    const a = audioEl();
    if (a) { a.pause(); a.currentTime = 0; }
  }
};

// ─── 歌单自动补全监听 ─────────────────────────────────────────────────────
let mobileEnrichListenersWired = false;
let enrichRefreshTimer = 0;

function scheduleEnrichRefresh() {
  clearTimeout(enrichRefreshTimer);
  enrichRefreshTimer = setTimeout(async () => {
    if (!openPlaylistCtx) return;
    try {
      const rows = await invoke("list_playlist_import_items", { playlistId: openPlaylistCtx.id });
      playlistDetailRows = rows;
      const ul = document.getElementById("cp-m-pl-tracks-ul");
      if (!ul) return;
      const lis = ul.querySelectorAll("li.cp-m-pl-track");
      rows.forEach((r, i) => {
        const li = lis[i];
        if (!li) return;
        const sid = (r.catalog_id || "").trim();
        const sub = li.querySelector(".cp-m-li-sub");
        if (sub) sub.textContent = r.artist || "";
        if (sid) {
          li.style.opacity = "";
          const txt = sub?.textContent || "";
          if (txt.includes("无曲库 id")) sub.textContent = txt.replace(/ · 无曲库 id$/, "");
        }
      });
      const missing = rows.filter((r) => !(r.catalog_id || "").trim()).length;
      const heroSub = document.getElementById("cp-m-pl-hero-sub");
      if (heroSub) {
        heroSub.textContent = missing > 0
          ? `共 ${rows.length} 首 · 自动补全中 (${missing} 待处理)`
          : `共 ${rows.length} 首导入曲目`;
      }
    } catch (_) {}
  }, 300);
}

function wireEnrichListeners() {
  if (mobileEnrichListenersWired || !hasTauriIpc()) return;
  mobileEnrichListenersWired = true;
  listen("import-enrich-item-done", (e) => {
    if (!openPlaylistCtx) return;
    if (e.payload?.playlistId === openPlaylistCtx.id) scheduleEnrichRefresh();
  });
  listen("import-enrich-finished", async (e) => {
    if (!openPlaylistCtx) return;
    if (e.payload?.playlistId === openPlaylistCtx.id) {
      clearTimeout(enrichRefreshTimer);
      await openPlaylistDetail(openPlaylistCtx.id, openPlaylistCtx.name);
    }
  });
}

function loadLikedSet() {
  try {
    const raw = localStorage.getItem("cp_tauri_liked_ids");
    if (!raw) return new Set();
    const a = JSON.parse(raw);
    return new Set(Array.isArray(a) ? a : []);
  } catch {
    return new Set();
  }
}

function saveLikedSet(set) {
  localStorage.setItem("cp_tauri_liked_ids", JSON.stringify([...set]));
}

/** 导入歌单页已解析条目（与桌面 `main.js` importTracks 对齐） @type {{ title: string, artist: string, album: string }[]} */
let importTracks = [];
/** 分享链接拉取成功后建议的歌单名 */
let importShareSuggestedName = "";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatTime(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function audioEl() {
  return document.getElementById("audio-player");
}

function setChrome({ title, sub, coverUrl }) {
  const t = document.getElementById("cp-m-dock-title");
  const s = document.getElementById("cp-m-dock-sub");
  const c = document.getElementById("cp-m-dock-cover");
  if (title !== undefined && t) t.textContent = title;
  if (sub !== undefined && s) s.textContent = sub;
  if (coverUrl && c) c.src = coverUrl;
  else if (c && coverUrl === null) c.src = PLACEHOLDER_COVER;

  // 同步 Now Playing 页（标题 / 歌手 / 封面 / 背景模糊图）
  const npTitle = document.getElementById("cp-m-np-title");
  const npArtist = document.getElementById("cp-m-np-artist");
  const npCover = document.getElementById("cp-m-np-cover");
  const npBg = document.getElementById("cp-m-np-bg");
  if (title !== undefined && npTitle) npTitle.textContent = title;
  if (sub !== undefined && npArtist) npArtist.textContent = sub;
  if (coverUrl) {
    if (npCover) npCover.src = coverUrl;
    if (npBg) {
      npBg.style.backgroundImage = `url("${String(coverUrl).replace(/"/g, '\\"')}")`;
      npBg.classList.add("has-cover");
    }
  } else if (coverUrl === null) {
    if (npCover) npCover.src = PLACEHOLDER_COVER;
    if (npBg) {
      npBg.style.backgroundImage = "";
      npBg.classList.remove("has-cover");
    }
  }
}

/** 同步 mini-player 与 Now Playing 页两套播放按钮的图标 */
function syncPlayBtnUi() {
  const a = audioEl();
  if (!a) return;
  const label = a.paused ? "▶" : "⏸";
  const btn = document.getElementById("cp-m-play");
  const btn2 = document.getElementById("cp-m-np-play");
  if (btn) btn.textContent = label;
  if (btn2) btn2.textContent = label;
}

function syncPlayModeUi() {
  const m = PLAY_MODES[playModeIndex];
  const iconHtml = playModeIconInnerHtml(m.key);
  for (const id of ["cp-m-queue-play-mode", "cp-m-np-play-mode"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.innerHTML = iconHtml;
    el.title = m.tip;
    el.setAttribute("aria-label", m.tip);
  }
}

function cyclePlayMode() {
  playModeIndex = (playModeIndex + 1) % PLAY_MODES.length;
  try {
    localStorage.setItem("cp_m_play_mode_idx", String(playModeIndex));
  } catch {
    /* ignore */
  }
  invalidateMobilePrefetch();
  syncPlayModeUi();
  syncMobilePlayerNav();
  void runPrefetchNextTrack();
}

/** 与桌面 `setPlayerNavEnabled` 一致：上一首 / 下一首是否可点 */
function syncMobilePlayerNav() {
  const prevDock = document.getElementById("cp-m-prev");
  const nextDock = document.getElementById("cp-m-next");
  const prevNp = document.getElementById("cp-m-np-prev");
  const nextNp = document.getElementById("cp-m-np-next");
  const n = playQueue.length;
  const mode = PLAY_MODES[playModeIndex].key;
  let disPrev = false;
  let disNext = false;
  if (!n) {
    disPrev = true;
    disNext = true;
  } else if (mode === "loop_list" || mode === "shuffle") {
    disPrev = false;
    disNext = false;
  } else if (mode === "one") {
    const dis = n <= 1;
    disPrev = dis;
    disNext = dis;
  } else {
    disPrev = playIndex <= 0;
    disNext = playIndex >= n - 1;
  }
  for (const el of [prevDock, prevNp]) {
    el?.toggleAttribute("disabled", disPrev);
  }
  for (const el of [nextDock, nextNp]) {
    el?.toggleAttribute("disabled", disNext);
  }
}

function syncSeekUi() {
  const a = audioEl();
  const seek = document.getElementById("cp-m-seek");
  const cur = document.getElementById("cp-m-time-cur");
  const tot = document.getElementById("cp-m-time-tot");
  const seek2 = document.getElementById("cp-m-np-seek");
  const cur2 = document.getElementById("cp-m-np-time-cur");
  const tot2 = document.getElementById("cp-m-np-time-tot");
  if (!a) return;
  const d = a.duration;
  if (d && Number.isFinite(d) && d > 0) {
    const totTxt = formatTime(d);
    const curTxt = formatTime(a.currentTime);
    const val = String(Math.min(1000, Math.floor((a.currentTime / d) * 1000)));
    if (tot) tot.textContent = totTxt;
    if (cur) cur.textContent = curTxt;
    if (seek) {
      if (!seekDragging) seek.value = val;
      seek.disabled = false;
    }
    if (tot2) tot2.textContent = totTxt;
    if (cur2) cur2.textContent = curTxt;
    if (seek2) {
      if (!seekDragging) seek2.value = val;
      seek2.disabled = false;
    }
  } else {
    if (cur) cur.textContent = "0:00";
    if (tot) tot.textContent = "0:00";
    if (seek) {
      seek.value = "0";
      seek.disabled = !a.src;
    }
    if (cur2) cur2.textContent = "0:00";
    if (tot2) tot2.textContent = "0:00";
    if (seek2) {
      seek2.value = "0";
      seek2.disabled = !a.src;
    }
  }
}

function exitSearchSelectMode() {
  searchSelectMode = false;
  selectedSearchIndices.clear();
  const panel = document.getElementById("cp-m-search-panel");
  const bar = document.getElementById("cp-m-search-batch-bar");
  const head = document.getElementById("cp-m-search-select-head");
  panel?.classList.remove("cp-m-search-panel--select");
  bar?.classList.add("hidden");
  head?.classList.add("hidden");
  document.querySelectorAll("#cp-m-discover-ul .cp-m-search-row").forEach((el) => {
    el.classList.remove("is-selected");
  });
  syncSearchBarDisabled();
}

function updateSearchSelectUi() {
  const nEl = document.getElementById("cp-m-search-select-n");
  const allBtn = document.getElementById("cp-m-search-select-all");
  const n = selectedSearchIndices.size;
  if (nEl) nEl.textContent = String(n);
  const len = searchResultRows.length;
  const allOn = len > 0 && [...Array(len).keys()].every((i) => selectedSearchIndices.has(i));
  if (allBtn) allBtn.textContent = allOn ? "全不选" : "全选";
  syncSearchBarDisabled();
}

function syncSearchBarDisabled() {
  const empty = selectedSearchIndices.size === 0;
  for (const id of ["cp-m-search-act-addto", "cp-m-search-act-download", "cp-m-search-act-like"]) {
    document.getElementById(id)?.toggleAttribute("disabled", empty);
  }
}

function refreshSearchRowSelectionClasses() {
  document.querySelectorAll("#cp-m-discover-ul li.cp-m-search-row").forEach((li) => {
    const idx = Number(li.dataset.rowIndex);
    if (!Number.isFinite(idx)) return;
    li.classList.toggle("is-selected", selectedSearchIndices.has(idx));
  });
}

function enterSearchSelectMode(firstIndex) {
  searchSelectMode = true;
  selectedSearchIndices.clear();
  if (firstIndex >= 0) selectedSearchIndices.add(firstIndex);
  const panel = document.getElementById("cp-m-search-panel");
  const bar = document.getElementById("cp-m-search-batch-bar");
  const head = document.getElementById("cp-m-search-select-head");
  panel?.classList.add("cp-m-search-panel--select");
  bar?.classList.remove("hidden");
  head?.classList.remove("hidden");
  refreshSearchRowSelectionClasses();
  updateSearchSelectUi();
}

function toggleSearchRowSelection(rowIndex, li) {
  if (rowIndex < 0) return;
  if (selectedSearchIndices.has(rowIndex)) selectedSearchIndices.delete(rowIndex);
  else selectedSearchIndices.add(rowIndex);
  li.classList.toggle("is-selected", selectedSearchIndices.has(rowIndex));
  updateSearchSelectUi();
}

function toggleSearchSelectAll() {
  const len = searchResultRows.length;
  const allIdx = [...Array(len).keys()];
  const allOn = len > 0 && allIdx.every((i) => selectedSearchIndices.has(i));
  if (allOn) selectedSearchIndices.clear();
  else allIdx.forEach((i) => selectedSearchIndices.add(i));
  refreshSearchRowSelectionClasses();
  updateSearchSelectUi();
}

function getSelectedSearchRows() {
  return [...selectedSearchIndices]
    .sort((a, b) => a - b)
    .map((i) => searchResultRows[i])
    .filter(Boolean);
}

function openSearchPanel() {
  exitDetailSelectMode();
  const p = document.getElementById("cp-m-search-panel");
  const inp = document.getElementById("cp-m-search");
  if (p) p.classList.remove("hidden");
  inp?.focus();
}

function closeSearchPanel() {
  exitSearchSelectMode();
  document.getElementById("cp-m-search-panel")?.classList.add("hidden");
}

function updateImportActionState() {
  const has = importTracks.length > 0;
  const sel = document.getElementById("cp-m-import-merge-pl");
  const nOpt = !!(sel && !sel.disabled && sel.options && sel.options.length > 0);
  document.getElementById("cp-m-import-save-new")?.toggleAttribute("disabled", !has);
  document.getElementById("cp-m-import-export-txt")?.toggleAttribute("disabled", !has);
  document.getElementById("cp-m-import-export-csv")?.toggleAttribute("disabled", !has);
  document.getElementById("cp-m-import-merge-btn")?.toggleAttribute("disabled", !has || !nOpt);
}

function renderImportResultList() {
  const ul = document.getElementById("cp-m-import-ul");
  const hint = document.getElementById("cp-m-import-hint");
  if (!ul) return;
  ul.innerHTML = "";
  importTracks.forEach((t) => {
    const li = document.createElement("li");
    const sub = [t.artist || "", t.album || ""].filter(Boolean).join(" · ");
    li.innerHTML = `<div><div class="cp-m-li-title">${escapeHtml(t.title || "—")}</div><div class="cp-m-li-sub">${escapeHtml(sub || "—")}</div></div>`;
    ul.appendChild(li);
  });
  if (hint) {
    hint.textContent = importTracks.length ? `共 ${importTracks.length} 条` : "解析结果将显示在下方";
  }
  updateImportActionState();
}

async function refreshImportMergeSelect() {
  const sel = document.getElementById("cp-m-import-merge-pl");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";
  let pls = [];
  try {
    pls = await invoke("list_playlists");
  } catch (e) {
    console.warn("list_playlists", e);
  }
  for (const p of pls) {
    const o = document.createElement("option");
    o.value = String(p.id);
    o.textContent = p.name?.trim() || `歌单 ${p.id}`;
    sel.appendChild(o);
  }
  const hasPl = pls.length > 0;
  sel.disabled = !hasPl;
  if (hasPl && prev) {
    const still = [...sel.options].some((o) => o.value === prev);
    if (still) sel.value = prev;
  }
  updateImportActionState();
}

function openImportPanel() {
  document.getElementById("cp-m-import-panel")?.classList.remove("hidden");
  void refreshImportMergeSelect();
}

function closeImportPanel() {
  document.getElementById("cp-m-import-panel")?.classList.add("hidden");
}

function wireImportPanel() {
  document.getElementById("cp-m-import-close")?.addEventListener("click", () => closeImportPanel());

  document.getElementById("cp-m-import-parse-btn")?.addEventListener("click", async () => {
    const raw = document.getElementById("cp-m-import-text")?.value?.trim() ?? "";
    if (!raw) {
      alert("请先粘贴文本。");
      return;
    }
    const fmt = document.getElementById("cp-m-import-fmt")?.value ?? "auto";
    try {
      const rows = await invoke("parse_import_text", { text: raw, fmt });
      importTracks = rows || [];
      importShareSuggestedName = "";
      const st = document.getElementById("cp-m-import-share-status");
      if (st) st.textContent = "";
      renderImportResultList();
      await refreshImportMergeSelect();
      alert(`共解析 ${importTracks.length} 条。`);
    } catch (e) {
      console.warn("parse_import_text", e);
      alert(`解析失败：${errText(e)}`);
    }
  });

  document.getElementById("cp-m-import-share-btn")?.addEventListener("click", async () => {
    const input = document.getElementById("cp-m-import-share-url");
    const url = input?.value?.trim() ?? "";
    const st = document.getElementById("cp-m-import-share-status");
    const btn = document.getElementById("cp-m-import-share-btn");
    if (!url) {
      alert("请先粘贴分享链接。");
      return;
    }
    if (st) st.textContent = "正在拉取歌单，请稍候…";
    if (btn) btn.disabled = true;
    try {
      const res = await invoke("fetch_share_playlist", { url });
      importTracks = res.tracks || [];
      importShareSuggestedName = res.playlist_name || res.playlistName || "";
      renderImportResultList();
      await refreshImportMergeSelect();
      const n = importTracks.length;
      const pn = importShareSuggestedName || "—";
      if (st) st.textContent = `已拉取 ${n} 首 · ${pn}`;
      alert(`已拉取「${pn}」共 ${n} 首。`);
    } catch (e) {
      if (st) st.textContent = "";
      console.warn("fetch_share_playlist", e);
      alert(`拉取失败：${errText(e)}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById("cp-m-import-share-url")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("cp-m-import-share-btn")?.click();
    }
  });

  document.getElementById("cp-m-import-export-txt")?.addEventListener("click", () => {
    if (!importTracks.length) return;
    triggerBlobDownload("playlist.txt", buildImportTxtBlob(importTracks));
  });

  document.getElementById("cp-m-import-export-csv")?.addEventListener("click", () => {
    if (!importTracks.length) return;
    triggerBlobDownload("playlist.csv", buildImportCsvBlobUtf8(importTracks));
  });

  document.getElementById("cp-m-import-save-new")?.addEventListener("click", async () => {
    if (!importTracks.length) return;
    const defaultName = (importShareSuggestedName && importShareSuggestedName.trim()) || "导入歌单";
    const name = window.prompt("歌单名称（将写入资料库）", defaultName);
    if (!name || !name.trim()) return;
    try {
      const id = await invoke("create_playlist", { name: name.trim() });
      await invoke("replace_playlist_import_items", {
        playlistId: id,
        items: importTracks.map((t) => ({
          title: t.title,
          artist: t.artist,
          album: t.album || "",
        })),
      });
      alert(`已创建歌单「${name.trim()}」，共 ${importTracks.length} 首。`);
      await refreshImportMergeSelect();
      void refreshPlaylists();
    } catch (e) {
      console.warn("save new playlist", e);
      alert(`保存失败：${errText(e)}`);
    }
  });

  document.getElementById("cp-m-import-merge-btn")?.addEventListener("click", async () => {
    if (!importTracks.length) return;
    const sel = document.getElementById("cp-m-import-merge-pl");
    const pid = sel && sel.value ? Number(sel.value) : NaN;
    if (!Number.isFinite(pid)) {
      alert("请先通过「保存为新歌单」创建歌单，或选择合并目标。");
      return;
    }
    try {
      await invoke("append_playlist_import_items", {
        playlistId: pid,
        items: importTracks.map((t) => ({
          title: t.title,
          artist: t.artist,
          album: t.album || "",
        })),
      });
      alert(`已向所选歌单追加 ${importTracks.length} 首。`);
      void refreshPlaylists();
    } catch (e) {
      console.warn("append_playlist_import_items", e);
      alert(`合并失败：${errText(e)}`);
    }
  });
}

/** 歌单列表：长按删除后抑制紧随其后的 click 打开详情 */
let playlistRowLongPressHandled = false;
let playlistRowLongPressTimer = 0;

async function confirmDeletePlaylistRow(p, displayName) {
  const name = displayName || `歌单 ${p.id}`;
  if (!window.confirm(`确定删除歌单「${name}」？`)) {
    playlistRowLongPressHandled = false;
    return;
  }
  try {
    await invoke("delete_playlist", { playlistId: Number(p.id) });
    if (openPlaylistCtx && openPlaylistCtx.id === Number(p.id)) {
      closePlaylistDetail();
    }
    await refreshPlaylists();
  } catch (e) {
    console.warn("delete_playlist", e);
    alert(`删除失败：${errText(e)}`);
  } finally {
    playlistRowLongPressHandled = false;
  }
}

function wirePlaylistRowInteractions(li, p, displayName) {
  const pid = Number(p.id);
  const openDetail = () => {
    if (playlistRowLongPressHandled) {
      playlistRowLongPressHandled = false;
      return;
    }
    void openPlaylistDetail(pid, displayName);
  };

  const LONG_MS = 520;
  const clearTimer = () => {
    if (playlistRowLongPressTimer) {
      window.clearTimeout(playlistRowLongPressTimer);
      playlistRowLongPressTimer = 0;
    }
  };

  li.addEventListener(
    "touchstart",
    () => {
      clearTimer();
      playlistRowLongPressTimer = window.setTimeout(() => {
        playlistRowLongPressTimer = 0;
        playlistRowLongPressHandled = true;
        void confirmDeletePlaylistRow(p, displayName);
      }, LONG_MS);
    },
    { passive: true },
  );
  li.addEventListener("touchend", clearTimer);
  li.addEventListener("touchmove", clearTimer);
  li.addEventListener("touchcancel", clearTimer);

  li.addEventListener("click", openDetail);

  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    playlistRowLongPressHandled = true;
    void confirmDeletePlaylistRow(p, displayName);
  });
}

async function refreshPlaylists() {
  const ul = document.getElementById("cp-m-playlist-ul");
  const empty = document.getElementById("cp-m-pl-empty");
  if (!ul) return;
  ul.innerHTML = "";
  let rows = [];
  try {
    rows = await invoke("list_playlists_summary");
  } catch (e) {
    console.warn("list_playlists_summary", e);
    if (empty) {
      empty.hidden = false;
      empty.textContent = errText(e);
    }
    return;
  }
  if (!rows.length) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = "暂无歌单。点上方「导入歌单」解析链接或文本后保存即可。";
    }
    return;
  }
  if (empty) empty.hidden = true;
  for (const p of rows) {
    const n = Number(p.track_count) || 0;
    const cover = ((p.cover_url || "") + "").trim() || PLACEHOLDER_COVER;
    const displayName = String(p.name || "").trim() || `歌单 ${p.id}`;
    const li = document.createElement("li");
    li.className = "cp-m-pl-row";
    const thumb = document.createElement("div");
    thumb.className = "cp-m-pl-thumb";
    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = cover;
    if (cover !== PLACEHOLDER_COVER) {
      img.addEventListener("error", () => {
        img.src = PLACEHOLDER_COVER;
      });
    }
    thumb.appendChild(img);
    const meta = document.createElement("div");
    meta.className = "cp-m-pl-card-meta";
    meta.innerHTML = `<div class="cp-m-li-title">${escapeHtml(p.name || `歌单 ${p.id}`)}</div>
      <div class="cp-m-li-sub">歌单 · ${n} 首 · 长按删除</div>`;
    li.appendChild(thumb);
    li.appendChild(meta);
    wirePlaylistRowInteractions(li, p, displayName);
    ul.appendChild(li);
  }
}

function recentRowToQueueItem(r) {
  const kind = (r.kind || "").trim();
  if (kind === "local") {
    const fp = (r.file_path || "").trim();
    if (!fp) return null;
    return {
      local_path: fp,
      title: r.title || "本地音频",
      artist: r.artist || "",
      album: "",
      cover_url: r.cover_url || null,
    };
  }
  const sid = (r.catalog_id || "").trim();
  if (!sid) return null;
  return {
    source_id: sid,
    title: r.title || "—",
    artist: r.artist || "",
    album: "",
    cover_url: r.cover_url || null,
  };
}

async function refreshRecent() {
  const row = document.getElementById("cp-m-recent-row");
  const empty = document.getElementById("cp-m-recent-empty");
  if (!row) return;
  row.innerHTML = "";
  let rows = [];
  try {
    rows = await invoke("list_recent_plays");
  } catch (e) {
    console.warn("list_recent_plays", e);
    if (empty) {
      empty.hidden = false;
      empty.textContent = errText(e);
    }
    return;
  }
  const originals = rows || [];
  const queue = originals.map((x) => recentRowToQueueItem(x)).filter(Boolean);
  if (!queue.length) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  queue.forEach((item, j) => {
    const card = document.createElement("div");
    card.className = "cp-m-recent-card";
    const cover = item.cover_url || PLACEHOLDER_COVER;
    card.innerHTML = `<div class="cp-m-recent-cover"></div>
      <p class="cp-m-recent-title">${escapeHtml(item.title)}</p>
      <p class="cp-m-recent-artist">${escapeHtml(item.artist || "—")}</p>`;
    const img = document.createElement("img");
    img.alt = "";
    img.src = cover;
    img.referrerPolicy = "no-referrer";
    card.querySelector(".cp-m-recent-cover")?.appendChild(img);
    card.addEventListener("click", () => {
      invalidateMobilePrefetch();
      playQueue = queue;
      void playFromQueueIndex(j);
      void saveQueueToSettings();
    });
    row.appendChild(card);
  });
}

function exitDetailSelectMode() {
  detailSelectMode = false;
  selectedDetailIds.clear();
  const detail = document.getElementById("cp-m-pl-detail");
  const bar = document.getElementById("cp-m-pl-detail-bar");
  const head = document.getElementById("cp-m-pl-select-head");
  detail?.classList.remove("cp-m-pl-detail--select");
  bar?.classList.add("hidden");
  head?.classList.add("hidden");
  document.querySelectorAll("#cp-m-pl-tracks-ul .cp-m-pl-track").forEach((el) => {
    el.classList.remove("is-selected");
  });
  syncDetailBarDisabled();
}

function updateDetailSelectUi() {
  const nEl = document.getElementById("cp-m-pl-select-n");
  const allBtn = document.getElementById("cp-m-pl-select-all");
  const n = selectedDetailIds.size;
  if (nEl) nEl.textContent = String(n);
  const allIds = playlistDetailRows.map((r) => Number(r.id)).filter((id) => id > 0);
  const allOn = allIds.length > 0 && allIds.every((id) => selectedDetailIds.has(id));
  if (allBtn) allBtn.textContent = allOn ? "全不选" : "全选";
  syncDetailBarDisabled();
}

function syncDetailBarDisabled() {
  const empty = selectedDetailIds.size === 0;
  for (const id of ["cp-m-pl-act-delete", "cp-m-pl-act-addto", "cp-m-pl-act-download", "cp-m-pl-act-like"]) {
    document.getElementById(id)?.toggleAttribute("disabled", empty);
  }
}

function refreshDetailRowSelectionClasses() {
  document.querySelectorAll("#cp-m-pl-tracks-ul li.cp-m-pl-track").forEach((li) => {
    const id = Number(li.dataset.itemId);
    if (!Number.isFinite(id)) return;
    li.classList.toggle("is-selected", selectedDetailIds.has(id));
  });
}

function enterDetailSelectMode(firstItemId) {
  detailSelectMode = true;
  selectedDetailIds.clear();
  if (firstItemId > 0) selectedDetailIds.add(firstItemId);
  const detail = document.getElementById("cp-m-pl-detail");
  const bar = document.getElementById("cp-m-pl-detail-bar");
  const head = document.getElementById("cp-m-pl-select-head");
  detail?.classList.add("cp-m-pl-detail--select");
  bar?.classList.remove("hidden");
  head?.classList.remove("hidden");
  refreshDetailRowSelectionClasses();
  updateDetailSelectUi();
}

function toggleDetailRowSelection(itemId, li) {
  if (itemId <= 0) return;
  if (selectedDetailIds.has(itemId)) selectedDetailIds.delete(itemId);
  else selectedDetailIds.add(itemId);
  li.classList.toggle("is-selected", selectedDetailIds.has(itemId));
  updateDetailSelectUi();
}

function toggleDetailSelectAll() {
  const allIds = playlistDetailRows.map((r) => Number(r.id)).filter((id) => id > 0);
  const allOn = allIds.length > 0 && allIds.every((id) => selectedDetailIds.has(id));
  if (allOn) {
    selectedDetailIds.clear();
  } else {
    allIds.forEach((id) => selectedDetailIds.add(id));
  }
  refreshDetailRowSelectionClasses();
  updateDetailSelectUi();
}

function getSelectedDetailRows() {
  return playlistDetailRows.filter((r) => selectedDetailIds.has(Number(r.id)));
}

function isSearchPanelActiveForBatch() {
  const p = document.getElementById("cp-m-search-panel");
  return searchSelectMode && !!p && !p.classList.contains("hidden");
}

function getSelectedRowsForBatch() {
  if (isSearchPanelActiveForBatch()) return getSelectedSearchRows();
  return getSelectedDetailRows();
}

/** 当前播放队列 → 与歌单导入行相近的结构，供整队「下载 / 添加到」 */
function playQueueToBatchRows() {
  return playQueue.map((it) => {
    const sid = String(it.source_id ?? "").trim();
    return {
      title: it.title,
      artist: it.artist || "",
      album: it.album || "",
      catalog_id: sid,
      source_id: sid,
      id: it.import_item_id != null ? it.import_item_id : null,
      cover_url: it.cover_url,
      import_playlist_id: it.import_playlist_id != null ? it.import_playlist_id : null,
    };
  });
}

function mapRowsToAppendItems(rows) {
  return rows.map((row) => ({
    title: row.title || "",
    artist: row.artist || "",
    album: row.album || "",
    source_id: String(row.source_id ?? row.catalog_id ?? row.catalogId ?? "").trim(),
    cover_url: String(row.cover_url ?? row.coverUrl ?? "").trim(),
    duration_ms: Math.max(0, Number(row.duration_ms ?? row.durationMs ?? 0) || 0),
    play_url: String(row.play_url ?? row.playUrl ?? "").trim(),
  }));
}

function wirePlaylistDetailTrackRow(li, r, i, rows) {
  const itemId = Number(r.id);
  li.dataset.itemId = String(itemId);

  const clearTimer = () => {
    if (detailTrackLongPressTimer) {
      window.clearTimeout(detailTrackLongPressTimer);
      detailTrackLongPressTimer = 0;
    }
  };

  const onLongPress = () => {
    detailTrackLongPressTimer = 0;
    detailTrackLongPressSuppressClick = true;
    if (!detailSelectMode) {
      enterDetailSelectMode(itemId);
    } else {
      toggleDetailRowSelection(itemId, li);
    }
  };

  li.addEventListener(
    "touchstart",
    () => {
      clearTimer();
      detailTrackLongPressTimer = window.setTimeout(onLongPress, DETAIL_LONG_MS);
    },
    { passive: true },
  );
  li.addEventListener("touchend", clearTimer);
  li.addEventListener("touchmove", clearTimer);
  li.addEventListener("touchcancel", clearTimer);

  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    clearTimer();
    onLongPress();
  });

  li.addEventListener("click", () => {
    if (detailTrackLongPressSuppressClick) {
      detailTrackLongPressSuppressClick = false;
      return;
    }
    if (detailSelectMode) {
      toggleDetailRowSelection(itemId, li);
      return;
    }
    const pid = openPlaylistCtx?.id;
    if (pid == null) return;
    /** 与桌面 `openSidebarPlaylistContextMenu` / `playlistImportRowToQueueItem` 一致：可无 source_id，播放时 `try_fill` */
    invalidateMobilePrefetch();
    playQueue = rows.map((row) => ({
      source_id: (row.catalog_id || "").trim(),
      title: row.title,
      artist: row.artist || "",
      album: row.album || "",
      cover_url: (row.cover_url || "").trim() || null,
      import_playlist_id: Number(pid),
      import_item_id: row.id != null ? row.id : null,
    }));
    void playFromQueueIndex(i);
    void saveQueueToSettings();
  });
}

function closeDlQualityPanel() {
  pendingDownloadRows = null;
  document.getElementById("cp-m-dl-quality-panel")?.classList.add("hidden");
}

function hideDlQualityPanelOnly() {
  document.getElementById("cp-m-dl-quality-panel")?.classList.add("hidden");
}

function openDlQualityPanel(rowsOverride = null) {
  pendingDownloadRows = rowsOverride;
  document.getElementById("cp-m-dl-quality-panel")?.classList.remove("hidden");
}

function closeAddToPanel() {
  addToPanelPinnedRows = null;
  document.getElementById("cp-m-addto-panel")?.classList.add("hidden");
}

function openAddToPage() {
  const page = document.getElementById("cp-m-addto-page");
  const songsUl = document.getElementById("cp-m-addto-page-songs");
  const plsUl = document.getElementById("cp-m-addto-page-pls");
  if (!page || !songsUl || !plsUl) return;

  const rows = playQueueToBatchRows();
  if (!rows.length) {
    alert("播放列表为空。");
    return;
  }

  // Render song checklist (all checked by default)
  songsUl.innerHTML = "";
  rows.forEach((r, i) => {
    const li = document.createElement("li");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.index = String(i);
    const info = document.createElement("div");
    info.className = "cp-m-addto-page-song-info";
    const title = document.createElement("div");
    title.className = "cp-m-addto-page-song-title";
    title.textContent = r.title || "—";
    const sub = document.createElement("div");
    sub.className = "cp-m-addto-page-song-sub";
    sub.textContent = r.artist || "";
    info.appendChild(title);
    info.appendChild(sub);
    li.appendChild(cb);
    li.appendChild(info);
    songsUl.appendChild(li);
  });

  // Toggle all button
  const toggleBtn = document.getElementById("cp-m-addto-page-toggle");
  if (toggleBtn) {
    toggleBtn.textContent = "全不选";
    toggleBtn.onclick = () => {
      const checkboxes = songsUl.querySelectorAll('input[type="checkbox"]');
      const allChecked = Array.from(checkboxes).every((cb) => cb.checked);
      checkboxes.forEach((cb) => { cb.checked = !allChecked; });
      toggleBtn.textContent = allChecked ? "全选" : "全不选";
    };
  }

  // Fetch and render playlists
  plsUl.innerHTML = "";
  void (async () => {
    let pls = [];
    try {
      pls = await invoke("list_playlists");
    } catch (e) {
      console.warn("list_playlists", e);
      return;
    }
    const cur = openPlaylistCtx?.id;
    for (const p of pls) {
      const pid = Number(p.id);
      if (!Number.isFinite(pid)) continue;
      if (cur != null && pid === cur) continue;
      const li = document.createElement("li");
      const plName = String(p.name || "").trim() || `歌单 ${pid}`;
      li.textContent = plName;
      li.addEventListener("click", async () => {
        const checkedIndices = [];
        songsUl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
          if (cb.checked) checkedIndices.push(Number(cb.dataset.index));
        });
        if (!checkedIndices.length) {
          alert("请至少选择一首歌曲。");
          return;
        }
        const selectedRows = checkedIndices.map((i) => rows[i]).filter(Boolean);
        const items = mapRowsToAppendItems(selectedRows);
        if (!items.length) return;
        try {
          await invoke("append_playlist_import_items", { playlistId: pid, items });
          closeAddToPage();
          alert(`已添加 ${items.length} 首到「${plName}」`);
          void refreshPlaylists();
        } catch (e) {
          console.warn("append_playlist_import_items", e);
          alert(`添加失败：${errText(e)}`);
        }
      });
      plsUl.appendChild(li);
    }
    if (!plsUl.children.length) {
      const li = document.createElement("li");
      li.textContent = "暂无其它歌单";
      li.style.cursor = "default";
      plsUl.appendChild(li);
    }
  })();

  page.classList.remove("hidden");
}

function closeAddToPage() {
  document.getElementById("cp-m-addto-page")?.classList.add("hidden");
}

function getAddToPanelRows() {
  return addToPanelPinnedRows != null ? addToPanelPinnedRows : getSelectedRowsForBatch();
}

async function openAddToPanel(opts = {}) {
  const panel = document.getElementById("cp-m-addto-panel");
  const ul = document.getElementById("cp-m-addto-ul");
  if (!panel || !ul) return;
  addToPanelPinnedRows = opts.rows != null ? opts.rows : null;
  const rawRows = addToPanelPinnedRows != null ? addToPanelPinnedRows : getSelectedRowsForBatch();
  const items = mapRowsToAppendItems(rawRows);
  if (!items.length) {
    addToPanelPinnedRows = null;
    alert(opts.rows != null ? "没有可添加的曲目。" : "请先选择曲目。");
    return;
  }
  ul.innerHTML = "";
  let pls = [];
  try {
    pls = await invoke("list_playlists");
  } catch (e) {
    console.warn("list_playlists", e);
    alert(`读取歌单失败：${errText(e)}`);
    return;
  }
  const cur = openPlaylistCtx?.id;
  for (const p of pls) {
    const pid = Number(p.id);
    if (!Number.isFinite(pid)) continue;
    if (cur != null && pid === cur) continue;
    const li = document.createElement("li");
    li.textContent = String(p.name || "").trim() || `歌单 ${pid}`;
    li.addEventListener("click", async () => {
      const batchItems = mapRowsToAppendItems(getAddToPanelRows());
      if (!batchItems.length) return;
      try {
        await invoke("append_playlist_import_items", { playlistId: pid, items: batchItems });
        closeAddToPanel();
        alert(`已添加 ${batchItems.length} 首到「${li.textContent}」`);
        void refreshPlaylists();
      } catch (e) {
        console.warn("append_playlist_import_items", e);
        alert(`添加失败：${errText(e)}`);
      }
    });
    ul.appendChild(li);
  }
  if (!ul.children.length) {
    const li = document.createElement("li");
    li.textContent = "暂无其它歌单（可点「新建歌单并添加」）";
    li.style.cursor = "default";
    ul.appendChild(li);
  }
  panel.classList.remove("hidden");
}

async function runDetailDelete() {
  const rows = getSelectedDetailRows();
  if (!rows.length || !openPlaylistCtx) {
    alert("请先选择曲目。");
    return;
  }
  if (!window.confirm(`从当前歌单删除 ${rows.length} 首？`)) return;
  const pid = openPlaylistCtx.id;
  let fail = 0;
  for (const r of rows) {
    const itemId = Number(r.id);
    if (itemId <= 0) continue;
    try {
      await invoke("delete_playlist_import_item", { playlistId: pid, itemId });
    } catch (e) {
      console.warn("delete_playlist_import_item", e);
      fail++;
    }
  }
  exitDetailSelectMode();
  await openPlaylistDetail(pid, openPlaylistCtx.name);
  if (fail) alert(`部分删除失败（${fail} 条）`);
}

async function runBatchDownloadWithQuality(quality) {
  const usePending = pendingDownloadRows != null;
  const rows = usePending
    ? pendingDownloadRows
    : isSearchPanelActiveForBatch()
      ? getSelectedSearchRows()
      : getSelectedDetailRows();
  const fromSearch = !usePending && isSearchPanelActiveForBatch();
  pendingDownloadRows = null;
  hideDlQualityPanelOnly();
  if (!rows.length) {
    alert(usePending ? "列表为空。" : "请先选择曲目。");
    return;
  }
  let ok = 0;
  let skip = 0;
  for (const r of rows) {
    let sid = fromSearch ? String(r.source_id ?? "").trim() : String(r.catalog_id ?? "").trim();
    const playlistIdForFill =
      r.import_playlist_id != null && Number.isFinite(Number(r.import_playlist_id))
        ? Number(r.import_playlist_id)
        : openPlaylistCtx?.id;
    if (!fromSearch && !sid && r.id && playlistIdForFill) {
      try {
        const filled = await invoke("try_fill_playlist_item_source_id", {
          playlistId: playlistIdForFill,
          itemId: r.id,
        });
        if (filled && String(filled).trim()) {
          sid = String(filled).trim();
          r.catalog_id = sid;
        }
      } catch (e) {
        console.warn("try_fill_playlist_item_source_id", e);
      }
    }
    if (!sid) {
      skip++;
      continue;
    }
    try {
      await invoke("enqueue_download", {
        job: {
          source_id: sid,
          title: r.title || "",
          artist: r.artist || "",
          quality,
        },
      });
      ok++;
    } catch (e) {
      console.warn("enqueue_download", e);
      skip++;
    }
  }
  alert(`已加入下载队列 ${ok} 首${skip ? `，跳过 ${skip} 首` : ""}。`);
}

function runBatchLike() {
  const fromSearch = isSearchPanelActiveForBatch();
  const rows = fromSearch ? getSelectedSearchRows() : getSelectedDetailRows();
  if (!rows.length) {
    alert("请先选择曲目。");
    return;
  }
  const likedIds = loadLikedSet();
  let n = 0;
  let skip = 0;
  for (const r of rows) {
    const sid = fromSearch
      ? String(r.source_id ?? "").trim()
      : String(r.catalog_id ?? "").trim();
    if (!sid) {
      skip++;
      continue;
    }
    likedIds.add(sid);
    n++;
  }
  saveLikedSet(likedIds);
  alert(`已标记喜欢 ${n} 首${skip ? `，${skip} 首无曲库 id 已跳过` : ""}。`);
}

async function openPlaylistDetail(id, name) {
  exitDetailSelectMode();
  exitSearchSelectMode();
  openPlaylistCtx = { id, name };
  const root = document.getElementById("mobile-app");
  const titleEl = document.getElementById("cp-m-page-title");
  const detail = document.getElementById("cp-m-pl-detail");
  const ul = document.getElementById("cp-m-pl-tracks-ul");
  if (root) root.classList.add("cp-mobile-library--detail");
  if (titleEl) titleEl.textContent = name;
  if (!ul || !detail) return;
  ul.innerHTML = "";
  detail.classList.remove("hidden");
  let rows = [];
  try {
    rows = await invoke("list_playlist_import_items", { playlistId: id });
  } catch (e) {
    console.warn("list_playlist_import_items", e);
  }
  playlistDetailRows = rows;
  const heroCover = document.getElementById("cp-m-pl-hero-cover");
  const heroTitle = document.getElementById("cp-m-pl-hero-title");
  const heroSub = document.getElementById("cp-m-pl-hero-sub");
  const firstCover =
    rows.map((r) => ((r.cover_url || "") + "").trim()).find((u) => u.length > 0) || PLACEHOLDER_COVER;
  if (heroCover) {
    heroCover.referrerPolicy = "no-referrer";
    heroCover.src = firstCover;
    heroCover.onerror = () => {
      heroCover.onerror = null;
      heroCover.src = PLACEHOLDER_COVER;
    };
  }
  if (heroTitle) heroTitle.textContent = name;
  const missing = rows.filter((r) => !(r.catalog_id || "").trim()).length;
  if (heroSub) {
    heroSub.textContent = missing > 0
      ? `共 ${rows.length} 首 · 自动补全中 (${missing} 待处理)`
      : `共 ${rows.length} 首导入曲目`;
  }
  if (missing > 0 && hasTauriIpc()) {
    try { await invoke("start_import_enrich", { playlistId: id }); } catch (_) {}
  }

  rows.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = "cp-m-pl-track";
    const sid = (r.catalog_id || "").trim();
    const ok = !!sid;
    li.innerHTML = `<span class="cp-m-pl-track-check" aria-hidden="true"></span><div class="cp-m-pl-track-main"><div class="cp-m-li-title">${escapeHtml(r.title || "—")}</div><div class="cp-m-li-sub">${escapeHtml(r.artist || "")}${ok ? "" : " · 无曲库 id"}</div></div>`;
    if (!ok) li.style.opacity = "0.5";
    wirePlaylistDetailTrackRow(li, r, i, rows);
    ul.appendChild(li);
  });
}

function closePlaylistDetail() {
  exitDetailSelectMode();
  playlistDetailRows = [];
  openPlaylistCtx = null;
  const root = document.getElementById("mobile-app");
  const titleEl = document.getElementById("cp-m-page-title");
  const detail = document.getElementById("cp-m-pl-detail");
  if (root) root.classList.remove("cp-mobile-library--detail");
  if (titleEl) titleEl.textContent = "我的音乐";
  if (detail) detail.classList.add("hidden");
}

function wireSearchResultRow(li, r, i, results) {
  li.dataset.rowIndex = String(i);
  const clearTimer = () => {
    if (searchRowLongPressTimer) {
      window.clearTimeout(searchRowLongPressTimer);
      searchRowLongPressTimer = 0;
    }
  };
  const onLongPress = () => {
    searchRowLongPressTimer = 0;
    searchRowLongPressSuppressClick = true;
    if (!searchSelectMode) {
      enterSearchSelectMode(i);
    } else {
      toggleSearchRowSelection(i, li);
    }
  };
  li.addEventListener(
    "touchstart",
    () => {
      clearTimer();
      searchRowLongPressTimer = window.setTimeout(onLongPress, DETAIL_LONG_MS);
    },
    { passive: true },
  );
  li.addEventListener("touchend", clearTimer);
  li.addEventListener("touchmove", clearTimer);
  li.addEventListener("touchcancel", clearTimer);
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    clearTimer();
    onLongPress();
  });
  li.addEventListener("click", () => {
    if (searchRowLongPressSuppressClick) {
      searchRowLongPressSuppressClick = false;
      return;
    }
    if (searchSelectMode) {
      toggleSearchRowSelection(i, li);
      return;
    }
    invalidateMobilePrefetch();
    playQueue = results.map((x) => ({
      source_id: x.source_id,
      title: x.title,
      artist: x.artist || "",
      album: x.album || "",
      cover_url: x.cover_url || null,
    }));
    void playFromQueueIndex(i);
    void saveQueueToSettings();
    closeSearchPanel();
  });
}

async function runDiscoverSearch() {
  exitSearchSelectMode();
  const inp = document.getElementById("cp-m-search");
  const kw = (inp?.value || "").trim();
  const ul = document.getElementById("cp-m-discover-ul");
  const hint = document.getElementById("cp-m-discover-hint");
  if (!kw || !ul) return;
  if (hint) hint.textContent = "搜索中…";
  ul.innerHTML = "";
  searchResultRows = [];
  try {
    const res = await invoke("search_songs", { keyword: kw, page: 1 });
    const results = res.results || [];
    searchResultRows = results;
    if (hint) hint.textContent = results.length ? `共 ${results.length} 条` : "无结果";
    results.forEach((r, i) => {
      const li = document.createElement("li");
      li.className = "cp-m-search-row";
      li.innerHTML = `<span class="cp-m-pl-track-check" aria-hidden="true"></span><div class="cp-m-pl-track-main"><div class="cp-m-li-title">${escapeHtml(r.title)}</div><div class="cp-m-li-sub">${escapeHtml(r.artist || "")}</div></div>`;
      wireSearchResultRow(li, r, i, results);
      ul.appendChild(li);
    });
  } catch (e) {
    console.warn("search_songs", e);
    if (hint) hint.textContent = `搜索失败：${errText(e)}`;
    searchResultRows = [];
  }
}

async function playFromQueueIndex(idx, opts = {}) {
  const forceRefresh = !!opts.forceRefresh;
  if (!playQueue.length || idx < 0 || idx >= playQueue.length) return;
  const fromBefore = playIndex;
  const genBefore = playLoadGeneration;
  prefetchJobId += 1;
  const pf = prefetchedNextPlay;
  const usePrefetch =
    !forceRefresh && pf && pf.nextIdx === idx && pf.fromIdx === fromBefore && pf.listeningGen === genBefore;
  const generation = ++playLoadGeneration;
  prefetchedNextPlay = null;
  /** @type {typeof pf | null} */
  let prefetchedPayload = usePrefetch ? pf : null;
  revokeMobileAudioObjectUrl();
  playIndex = idx;
  // 抽屉若已打开，则同步高亮当前曲目
  const sheet = document.getElementById("cp-m-queue-sheet");
  if (sheet && !sheet.classList.contains("hidden")) renderQueueSheet();
  let item = playQueue[idx];
  if (prefetchedPayload && !prefetchPayloadMatchesQueue(prefetchedPayload, idx, item)) {
    prefetchedPayload = null;
  }
  setChrome({
    title: item.title,
    sub: item.local_path ? `${item.artist || ""} · 本地` : `${item.artist || ""} · 在线`,
    coverUrl: item.cover_url || null,
  });
  const a = audioEl();
  /** 在线且最终走直链时写入最近播放，供 `resolve_online_play` 的 recent 分支 */
  let onlineResolvedPlayUrl = null;
  /** @type {Record<string, unknown> | null} */
  let playLogExtra = null;
  try {
    let assetUrl;
    if (item.local_path) {
      const pathOk = await invoke("local_path_accessible", { path: item.local_path });
      if (!pathOk) {
        alert("本地文件不可用");
        return;
      }
      assetUrl = await playableUrlFromLocalPath(item.local_path);
      playLogExtra = { local: true };
    } else {
      let songId = (item.source_id || "").trim();
      if (!songId && prefetchedPayload?.songId) songId = prefetchedPayload.songId;
      const iPl = item.import_playlist_id;
      const iRow = item.import_item_id;
      if (!songId && iPl != null && iRow != null) {
        setChrome({
          title: item.title,
          sub: "正在匹配曲库 id…",
          coverUrl: item.cover_url || null,
        });
        try {
          const filled = await invoke("try_fill_playlist_item_source_id", {
            playlistId: iPl,
            itemId: iRow,
          });
          if (generation !== playLoadGeneration) return;
          if (filled && String(filled).trim()) {
            const fid = String(filled).trim();
            item = { ...item, source_id: fid };
            playQueue[idx] = item;
            songId = fid;
            const match = playlistDetailRows.find((row) => Number(row.id) === Number(iRow));
            if (match) match.catalog_id = fid;
            patchPlaylistDetailRowAfterFill(Number(iRow), fid);
          }
        } catch (e) {
          console.warn("try_fill_playlist_item_source_id", e);
        }
      }
      if (generation !== playLoadGeneration) return;
      if (!songId) {
        setChrome({
          title: item.title,
          sub: "无法播放：未匹配到曲库 id",
          coverUrl: item.cover_url || null,
        });
        alert("无法匹配曲库 id。请在「发现」中搜索该曲，或确认歌名/歌手是否正确。");
        return;
      }
      let resolved = null;
      if (prefetchedPayload && prefetchedPayload.songId === songId) {
        resolved = prefetchedPayload.resolved;
      } else {
        const r = await resolveOnlinePlayWithRetryMobile(songId, item.title, item.artist, () => {
          return generation !== playLoadGeneration;
        }, { skipRecentUrl: forceRefresh });
        if (generation !== playLoadGeneration) return;
        if (!r.ok) {
          if (r.cancelled) return;
          throw r.lastErr ?? new Error("resolve_online_play failed");
        }
        resolved = r.resolved;
      }
      if (generation !== playLoadGeneration) return;
      if (!resolved) throw new Error("resolve_online_play failed");
      if (resolved.kind === "url" && resolved.url) {
        /** 仍记录直链，供 record_recent_play / 桌面端逻辑一致；与桌面 main.js 一致：直链赋给 `<audio>` */
        onlineResolvedPlayUrl = resolved.url;
        assetUrl = resolved.url;
      } else if (resolved.kind === "file" && resolved.path) {
        assetUrl = await playableUrlFromLocalPath(resolved.path);
      } else {
        throw new Error("resolve_online_play: 无效结果");
      }
      playLogExtra = {
        sid: songId,
        kind: resolved.kind,
        via: resolved.via,
      };
    }
    if (generation !== playLoadGeneration) return;
    await logPlayEventMobile("play_start", {
      url: assetUrl,
      extra: playLogExtra,
    });
    a.pause();
    a.removeAttribute("src");
    a.load();
    a.src = assetUrl;
    audioSourceGeneration = generation;
    await a.play();
    if (generation !== playLoadGeneration) return;
    pushMobileRecentFromCurrentTrack(onlineResolvedPlayUrl);
    setChrome({
      title: item.title,
      sub: item.local_path ? `${item.artist || ""} · 本地` : `${item.artist || ""} · 在线`,
      coverUrl: item.cover_url || null,
    });
    syncPlayBtnUi();
    syncMobilePlayerNav();
    prefetchNearEndLastTs = 0;
    void runPrefetchNextTrack();
    mediaNotifUpdate({
      title: item.title,
      artist: item.artist || "",
      coverUrl: item.cover_url || null,
      durationMs: a.duration ? Math.round(a.duration * 1000) : 0,
    });
    mediaNotifSetState({ playing: true, positionMs: 0 });
  } catch (e) {
    console.warn("playFromQueueIndex", e);
    setChrome({
      title: item.title,
      sub: "请求失败",
      coverUrl: item.cover_url || null,
    });
    alert(`无法播放：${errText(e)}`);
  }
}

function wirePlayer() {
  const a = audioEl();
  const playBtn = document.getElementById("cp-m-play");
  const seek = document.getElementById("cp-m-seek");

  let mediaNotifPosLastTs = 0;
  a.addEventListener("timeupdate", () => {
    syncSeekUi();
    maybePrefetchNextNearEnd(a);
    const now = Date.now();
    if (now - mediaNotifPosLastTs >= 1000) {
      mediaNotifPosLastTs = now;
      mediaNotifSetState({ playing: !a.paused, positionMs: Math.round((a.currentTime || 0) * 1000) });
    }
  });
  a.addEventListener("loadedmetadata", () => {
    syncSeekUi();
    if (audioSourceGeneration === playLoadGeneration) {
      void logPlayEventMobile("audio_loadedmetadata", {
        url: a.src || null,
        extra: audioDiagPayload(a),
      });
    }
  });
  a.addEventListener("progress", () => {
    if (audioSourceGeneration !== playLoadGeneration) return;
    const now = Date.now();
    if (now - audioProgressLogLastTs < 1000) return;
    audioProgressLogLastTs = now;
    void logPlayEventMobile("audio_progress", {
      url: a.src || null,
      extra: audioDiagPayload(a),
    });
  });
  a.addEventListener("stalled", () => {
    if (audioSourceGeneration !== playLoadGeneration) return;
    void logPlayEventMobile("audio_stalled", {
      url: a.src || null,
      extra: audioDiagPayload(a),
    });
  });
  a.addEventListener("ended", () => {
    if (audioSourceGeneration === playLoadGeneration) {
      void logPlayEventMobile("audio_ended", {
        url: a.src || null,
        extra: audioDiagPayload(a),
      });
    }
    const n = playQueue.length;
    const mode = PLAY_MODES[playModeIndex].key;
    if (!n) {
      syncSeekUi();
      return;
    }
    if (mode === "one") {
      a.currentTime = 0;
      void a.play().catch(() => {});
      syncSeekUi();
      return;
    }
    /* 防止部分 WebView 对 ended 连发，导致并发 resolve */
    const t = Date.now();
    if (t - mobileAudioEndedAt < 400) {
      syncSeekUi();
      return;
    }
    mobileAudioEndedAt = t;
    const pfNext =
      prefetchedNextPlay &&
      prefetchedNextPlay.fromIdx === playIndex &&
      prefetchedNextPlay.listeningGen === playLoadGeneration
        ? prefetchedNextPlay.nextIdx
        : null;
    if (mode === "loop_list") {
      schedulePlayFromQueueIndex(pfNext != null ? pfNext : (playIndex + 1) % n);
      syncSeekUi();
      return;
    }
    if (mode === "shuffle") {
      schedulePlayFromQueueIndex(pfNext != null ? pfNext : randomNextIndex());
      syncSeekUi();
      return;
    }
    if (playIndex < n - 1) {
      schedulePlayFromQueueIndex(pfNext != null ? pfNext : playIndex + 1);
    } else {
      syncPlayBtnUi();
      mediaNotifClear();
    }
    syncSeekUi();
  });
  /** 与桌面一致：丢弃切歌过程中的 error；4 = SRC_NOT_SUPPORTED（直链/WebView 策略） */
  a.addEventListener("error", () => {
    const err = a.error;
    if (err && err.code === 1) return;
    if (audioSourceGeneration !== playLoadGeneration) return;
    void logPlayEventMobile("audio_error", {
      url: a.src || null,
      error_code: err ? err.code : null,
      message: err && err.message ? err.message : null,
      extra: audioDiagPayload(a),
    });
    const sub = document.getElementById("cp-m-dock-sub");
    if (sub && err && err.code === 4) {
      sub.textContent = "无法加载音频（可重试）";
    }
    // 兜底：当前流报错时，仅自动强制刷新一次链接（绕过 recent_play_url），避免死循环。
    const n = playQueue.length;
    if (!n || playIndex < 0 || playIndex >= n) return;
    const now = Date.now();
    if (playIndex === lastAutoRetryTrackIdx && now - lastAutoRetryAt < 10_000) return;
    lastAutoRetryTrackIdx = playIndex;
    lastAutoRetryAt = now;
    if (sub) sub.textContent = "链接异常，正在重试…";
    window.setTimeout(() => {
      void playFromQueueIndex(playIndex, { forceRefresh: true });
    }, 120);
  });
  a.addEventListener("play", () => {
    syncPlayBtnUi();
    mediaNotifSetState({ playing: true, positionMs: Math.round((a.currentTime || 0) * 1000) });
  });
  a.addEventListener("pause", () => {
    syncPlayBtnUi();
    mediaNotifSetState({ playing: false, positionMs: Math.round((a.currentTime || 0) * 1000) });
  });

  const togglePlay = async () => {
    if (!a.src) {
      if (playQueue.length) void playFromQueueIndex(playIndex);
      return;
    }
    try {
      if (a.paused) await a.play();
      else a.pause();
    } catch (e) {
      console.warn(e);
    }
  };
  const gotoPrev = () => {
    const n = playQueue.length;
    if (!n) return;
    const mode = PLAY_MODES[playModeIndex].key;
    if (mode === "shuffle") {
      void playFromQueueIndex((playIndex - 1 + n) % n);
      return;
    }
    if (mode === "loop_list" && playIndex === 0) {
      void playFromQueueIndex(n - 1);
      return;
    }
    if (playIndex > 0) void playFromQueueIndex(playIndex - 1);
  };
  const gotoNext = () => {
    const n = playQueue.length;
    if (!n) return;
    const mode = PLAY_MODES[playModeIndex].key;
    if (mode === "shuffle") {
      void playFromQueueIndex(randomNextIndex());
      return;
    }
    if (mode === "loop_list" && playIndex === n - 1) {
      void playFromQueueIndex(0);
      return;
    }
    if (playIndex < n - 1) void playFromQueueIndex(playIndex + 1);
  };

  playBtn?.addEventListener("click", togglePlay);
  document.getElementById("cp-m-prev")?.addEventListener("click", gotoPrev);
  document.getElementById("cp-m-next")?.addEventListener("click", gotoNext);
  // Now Playing 页上的同名控件与底部 dock 共享同一 <audio> 实例
  document.getElementById("cp-m-np-play")?.addEventListener("click", togglePlay);
  document.getElementById("cp-m-np-prev")?.addEventListener("click", gotoPrev);
  document.getElementById("cp-m-np-next")?.addEventListener("click", gotoNext);

  const seekInput = (el) => {
    if (!el) return;
    el.addEventListener("pointerdown", () => {
      seekDragging = true;
    });
    el.addEventListener("pointerup", () => {
      seekDragging = false;
      syncSeekUi();
    });
    el.addEventListener("input", () => {
      const d = a.duration;
      if (d && Number.isFinite(d) && d > 0) {
        a.currentTime = (Number(el.value) / 1000) * d;
      }
    });
  };
  seekInput(seek);
  seekInput(document.getElementById("cp-m-np-seek"));
}

/** —— Now Playing 页 开关 —— */
function openNowPlayingPage() {
  const page = document.getElementById("cp-m-np-page");
  if (!page) return;
  if (!playQueue.length) return; // 未播放时不展开
  page.classList.remove("hidden");
  page.setAttribute("aria-hidden", "false");
  syncSeekUi();
  syncPlayBtnUi();
  syncPlayModeUi();
  syncMobilePlayerNav();
}

function closeNowPlayingPage() {
  const page = document.getElementById("cp-m-np-page");
  if (!page) return;
  page.classList.add("hidden");
  page.setAttribute("aria-hidden", "true");
}

/** —— 播放列表抽屉 —— */
function renderQueueSheet() {
  const ul = document.getElementById("cp-m-queue-ul");
  const empty = document.getElementById("cp-m-queue-empty");
  const count = document.getElementById("cp-m-queue-count");
  if (!ul) return;
  ul.innerHTML = "";
  if (count) count.textContent = String(playQueue.length);
  if (!playQueue.length) {
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");
  playQueue.forEach((it, i) => {
    const li = document.createElement("li");
    if (i === playIndex) li.classList.add("is-current");
    const title = it.title || "—";
    const sub = it.local_path
      ? `${it.artist || ""}${it.artist ? " · " : ""}本地`
      : it.artist || "";
    li.innerHTML = `
      <span class="cp-m-queue-idx">${i + 1}</span>
      <div class="cp-m-queue-main">
        <div class="cp-m-queue-main-title">${escapeHtml(title)}</div>
        <div class="cp-m-queue-main-sub">${escapeHtml(sub || "—")}</div>
      </div>
      ${i === playIndex ? '<span class="cp-m-queue-badge">播放中</span>' : ""}
    `;
    li.addEventListener("click", () => {
      if (i !== playIndex) {
        void playFromQueueIndex(i);
      } else {
        const a = audioEl();
        if (a && a.paused && a.src) {
          void a.play().catch(() => {});
        }
      }
      closeQueueSheet();
    });
    ul.appendChild(li);
  });
}

function openQueueSheet() {
  const sheet = document.getElementById("cp-m-queue-sheet");
  const back = document.getElementById("cp-m-queue-backdrop");
  if (!sheet || !back) return;
  renderQueueSheet();
  sheet.classList.remove("hidden");
  back.classList.remove("hidden");
  sheet.setAttribute("aria-hidden", "false");
  back.setAttribute("aria-hidden", "false");
}

function closeQueueSheet() {
  const sheet = document.getElementById("cp-m-queue-sheet");
  const back = document.getElementById("cp-m-queue-backdrop");
  if (!sheet || !back) return;
  sheet.classList.add("hidden");
  back.classList.add("hidden");
  sheet.setAttribute("aria-hidden", "true");
  back.setAttribute("aria-hidden", "true");
}

async function saveQueueToSettings() {
  try {
    const json = JSON.stringify(playQueue);
    await invoke("save_settings", {
      patch: { last_play_queue_json: json, last_play_index: playIndex },
    });
  } catch (e) {
    console.warn("saveQueueToSettings", e);
  }
}

function clearQueue() {
  if (!playQueue.length) return;
  if (!window.confirm("确定清空播放列表？当前曲目仍会继续播放，直到结束。")) return;
  invalidateMobilePrefetch();
  mediaNotifClear();
  // 保留当前曲目，避免直接中断音频
  const cur = playQueue[playIndex];
  if (cur) {
    playQueue = [cur];
    playIndex = 0;
  } else {
    playQueue = [];
    playIndex = 0;
  }
  renderQueueSheet();
  syncMobilePlayerNav();
  void saveQueueToSettings();
}

function wireNowPlayingAndQueue() {
  document.getElementById("cp-m-dock-open")?.addEventListener("click", () => {
    openNowPlayingPage();
  });
  document.getElementById("cp-m-np-close")?.addEventListener("click", () => {
    closeNowPlayingPage();
  });
  document.getElementById("cp-m-np-open-queue")?.addEventListener("click", () => {
    openQueueSheet();
  });
  document.getElementById("cp-m-np-play-mode")?.addEventListener("click", () => {
    cyclePlayMode();
  });
  document.getElementById("cp-m-queue-play-mode")?.addEventListener("click", () => {
    cyclePlayMode();
  });
  document.getElementById("cp-m-queue-download")?.addEventListener("click", () => {
    const rows = playQueueToBatchRows();
    if (!rows.length) {
      alert("播放列表为空。");
      return;
    }
    openDlQualityPanel(rows);
  });
  document.getElementById("cp-m-queue-addto")?.addEventListener("click", () => {
    openAddToPage();
  });
  document.getElementById("cp-m-dock-queue")?.addEventListener("click", () => {
    openQueueSheet();
  });
  document.getElementById("cp-m-queue-close")?.addEventListener("click", () => {
    closeQueueSheet();
  });
  document.getElementById("cp-m-queue-clear")?.addEventListener("click", () => {
    clearQueue();
  });
  document.getElementById("cp-m-queue-backdrop")?.addEventListener("click", () => {
    closeQueueSheet();
  });
  // 键盘 Escape / 安卓物理返回键：统一走 androidBackInternal
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (androidBackInternal()) e.preventDefault();
  });
}

export function startMobileApp() {
  setChrome({ title: "未播放", sub: "选择曲目开始", coverUrl: null });
  const c = document.getElementById("cp-m-dock-cover");
  if (c) c.src = PLACEHOLDER_COVER;

  // Restore persisted play queue (do NOT auto-play)
  void (async () => {
    try {
      const s = await invoke("get_settings");
      if (s?.last_play_queue_json && typeof s.last_play_queue_json === "string" && s.last_play_queue_json.trim()) {
        const parsed = JSON.parse(s.last_play_queue_json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          playQueue = parsed;
          const idx = Number(s.last_play_index) || 0;
          playIndex = Math.max(0, Math.min(idx, parsed.length - 1));
          renderQueueSheet();
          syncMobilePlayerNav();
          // Update player chrome to show the current track
          const cur = parsed[playIndex];
          if (cur) {
            setChrome({ title: cur.title, sub: cur.artist || "", coverUrl: cur.cover_url || null });
          }
        }
      }
    } catch (e) {
      console.warn("restore play queue", e);
    }
  })();

  document.getElementById("cp-m-pl-back")?.addEventListener("click", () => {
    if (detailSelectMode) exitDetailSelectMode();
    else closePlaylistDetail();
  });
  document.getElementById("cp-m-pl-select-all")?.addEventListener("click", () => toggleDetailSelectAll());
  document.getElementById("cp-m-pl-act-delete")?.addEventListener("click", () => void runDetailDelete());
  document.getElementById("cp-m-pl-act-addto")?.addEventListener("click", () => void openAddToPanel());
  document.getElementById("cp-m-pl-act-download")?.addEventListener("click", () => {
    if (selectedDetailIds.size === 0) {
      alert("请先选择曲目。");
      return;
    }
    openDlQualityPanel();
  });
  document.getElementById("cp-m-pl-act-like")?.addEventListener("click", () => runBatchLike());
  document.getElementById("cp-m-search-select-all")?.addEventListener("click", () => toggleSearchSelectAll());
  document.getElementById("cp-m-search-act-addto")?.addEventListener("click", () => void openAddToPanel());
  document.getElementById("cp-m-search-act-download")?.addEventListener("click", () => {
    if (selectedSearchIndices.size === 0) {
      alert("请先选择曲目。");
      return;
    }
    openDlQualityPanel();
  });
  document.getElementById("cp-m-search-act-like")?.addEventListener("click", () => runBatchLike());
  document.getElementById("cp-m-addto-close")?.addEventListener("click", () => closeAddToPanel());
  document.getElementById("cp-m-addto-new")?.addEventListener("click", async () => {
    const items = mapRowsToAppendItems(getAddToPanelRows());
    if (!items.length) {
      alert("请先选择曲目。");
      return;
    }
    const name = window.prompt("新歌单名称", "新歌单");
    if (!name || !name.trim()) return;
    try {
      const pid = await invoke("create_playlist", { name: name.trim() });
      await invoke("append_playlist_import_items", { playlistId: pid, items });
      closeAddToPanel();
      alert(`已创建「${name.trim()}」并添加 ${items.length} 首。`);
      void refreshPlaylists();
    } catch (e) {
      console.warn("create_playlist / append", e);
      alert(`失败：${errText(e)}`);
    }
  });
  document.getElementById("cp-m-addto-page-back")?.addEventListener("click", () => closeAddToPage());
  document.getElementById("cp-m-addto-page-new")?.addEventListener("click", async () => {
    const name = window.prompt("新歌单名称", "新歌单");
    if (!name || !name.trim()) return;
    try {
      const pid = await invoke("create_playlist", { name: name.trim() });
      closeAddToPage();
      openAddToPage();
      alert(`已创建「${name.trim()}」，请点击歌单名称添加歌曲。`);
    } catch (e) {
      console.warn("create_playlist", e);
      alert(`失败：${errText(e)}`);
    }
  });
  document.getElementById("cp-m-dl-quality-cancel")?.addEventListener("click", () => closeDlQualityPanel());
  document.querySelectorAll(".cp-m-dl-quality-btn[data-cp-quality]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const q = btn.getAttribute("data-cp-quality") || "128";
      void runBatchDownloadWithQuality(q);
    });
  });
  document.getElementById("cp-m-nav-search")?.addEventListener("click", () => openSearchPanel());
  document.getElementById("cp-m-search-close")?.addEventListener("click", () => {
    if (searchSelectMode) exitSearchSelectMode();
    else closeSearchPanel();
  });
  document.getElementById("cp-m-nav-settings")?.addEventListener("click", () => {
    alert("偏好设置请在桌面端 CloudPlayer 中修改。");
  });

  document.getElementById("cp-m-qa-dl")?.addEventListener("click", () => {
    alert("下载目录与队列请在桌面端管理。");
  });
  document.getElementById("cp-m-qa-fav")?.addEventListener("click", () => {
    alert("收藏功能即将与桌面端同步。");
  });
  document.getElementById("cp-m-qa-local")?.addEventListener("click", () => {
    alert("本地音乐扫描请在桌面端「本地和下载」中操作。");
  });
  document.getElementById("cp-m-qa-import")?.addEventListener("click", () => openImportPanel());

  document.getElementById("cp-m-search-go")?.addEventListener("click", () => void runDiscoverSearch());
  document.getElementById("cp-m-search")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runDiscoverSearch();
    }
  });

  wireImportPanel();
  wirePlayer();
  wireNowPlayingAndQueue();
  syncPlayModeUi();
  syncMobilePlayerNav();
  wireEnrichListeners();
  mediaNotifRequestPermission();
  void refreshPlaylists();
  void refreshRecent();
}
