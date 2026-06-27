/** 核心播放引擎 */
import { appState } from "./state.js";
import { PLAY_MODES, RECENT_SESSION_MAX, MSG_REQUEST_FAILED } from "./constants.js";
import {
  formatTime,
  alertRequestFailed,
  logPlayEventDesktop,
  audioDiagPayload,
  randomNextIndex,
  isSamePlayableIdentity,
  formatNowPlayingSubtitle,
  formatLoadingSubtitle,
  searchResultToQueueItem,
  playlistImportRowToQueueItem,
} from "./utils.js";
import { ensureLrcLoadedForCurrentTrack, syncDesktopLyrics } from "./lyrics.js";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/** @type {{ renderRecentPlaysTable: Function, renderPlaylistDetailTable: Function }} */
let _deps = {};

export function initPlayer(deps) {
  _deps = deps;
}

export function audioEl() {
  return document.getElementById("audio-player");
}

// ── Queue Panel ──

export function renderQueuePanel() {
  const ul = document.getElementById("queue-list");
  if (!ul) return;
  ul.innerHTML = "";
  if (!appState.playQueue.length) {
    const li = document.createElement("li");
    li.textContent = "（空）在「发现」搜索并双击曲目加入队列";
    ul.appendChild(li);
    return;
  }
  appState.playQueue.forEach((it, i) => {
    const li = document.createElement("li");
    if (i === appState.playIndex) li.classList.add("is-current");
    const label = it.local_path
      ? `${it.title}${it.artist ? ` — ${it.artist}` : ""}`
      : it.artist
        ? `${it.title} — ${it.artist}`
        : it.title;
    li.textContent = label;
    const sid = (it.source_id || "").trim();
    li.title = it.local_path
      ? String(it.local_path)
      : sid
        ? `id=${sid} · 双击播放`
        : "无曲库 id · 双击尝试匹配并播放";
    li.addEventListener("dblclick", () => playFromQueueIndex(i));
    ul.appendChild(li);
  });
}

// ── Queue Persistence ──

export async function saveQueueToSettings() {
  try {
    const json = JSON.stringify(appState.playQueue);
    await invoke("save_settings", {
      patch: {
        last_play_queue_json: json,
        last_play_index: appState.playIndex,
        last_play_mode_index: appState.playModeIndex,
      },
    });
  } catch (e) {
    console.warn("saveQueueToSettings", e);
  }
}

// ── Fav Button ──

export function refreshFavButton() {
  const btn = document.getElementById("btn-dock-fav");
  if (!btn) return;
  const svgHeart = (filled) => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style="display:block"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${filled ? '0' : '1.5'}"/></svg>`;
  const cur = appState.playQueue[appState.playIndex];
  if (!cur) {
    btn.classList.remove("is-on");
    btn.innerHTML = svgHeart(false);
    btn.disabled = false;
    btn.title = "喜欢";
    return;
  }
  const sid = (cur.source_id || "").trim();
  const canFav = !!sid && !cur.local_path;
  btn.disabled = !canFav;
  btn.title = canFav ? "喜欢" : "本地文件无曲库 id，不支持喜欢";
  const on = canFav && appState.likedIds.has(sid);
  btn.classList.toggle("is-on", on);
  btn.innerHTML = svgHeart(on);
}

// ── Player Chrome ──

export function updatePlayerChrome(patch = {}) {
  const { title, sub, coverUrl, touchCover = true } = patch;
  const tEl = document.getElementById("dock-title");
  const sEl = document.getElementById("dock-sub");
  const cov = document.getElementById("dock-cover");
  if (title !== undefined && tEl) tEl.textContent = title;
  if (sub !== undefined && sEl) sEl.textContent = sub;
  if (touchCover && cov && coverUrl !== undefined && coverUrl) cov.src = coverUrl;
  const ov = document.getElementById("immersive-player");
  if (ov && !ov.hidden) {
    if (title !== undefined) {
      const it = document.getElementById("immersive-title");
      if (it) it.textContent = title;
    }
    if (sub !== undefined) {
      const is2 = document.getElementById("immersive-sub");
      if (is2) is2.textContent = sub;
    }
    if (touchCover && coverUrl !== undefined && coverUrl) {
      const ic = document.getElementById("immersive-cover");
      if (ic) ic.src = coverUrl;
    }
  }
}

// ── Seek / Nav ──

export function syncSeekUi() {
  const a = audioEl();
  const seek = document.getElementById("seek");
  const cur = document.getElementById("time-current");
  const tot = document.getElementById("time-total");
  if (!a || !seek || !cur || !tot) return;
  const d = a.duration;
  if (d && isFinite(d) && d > 0) {
    tot.textContent = formatTime(d);
    if (!appState.seekDragging) {
      seek.value = String(Math.min(1000, Math.floor((a.currentTime / d) * 1000)));
    }
    cur.textContent = formatTime(a.currentTime);
    seek.disabled = false;
  } else {
    cur.textContent = "0:00";
    tot.textContent = "0:00";
    seek.value = "0";
    seek.disabled = !a.src;
  }
}

export function setPlayerNavEnabled() {
  const prev = document.getElementById("btn-player-prev");
  const next = document.getElementById("btn-player-next");
  const n = appState.playQueue.length;
  const mode = PLAY_MODES[appState.playModeIndex].key;
  if (!n) {
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    return;
  }
  if (mode === "loop_list" || mode === "shuffle") {
    if (prev) prev.disabled = false;
    if (next) next.disabled = false;
    return;
  }
  if (mode === "one") {
    const dis = n <= 1;
    if (prev) prev.disabled = dis;
    if (next) next.disabled = dis;
    return;
  }
  if (prev) prev.disabled = appState.playIndex <= 0;
  if (next) next.disabled = appState.playIndex >= n - 1;
}

// ── Queue Panel Toggle ──

export function toggleQueuePanel() {
  const panel = document.getElementById("queue-panel");
  const btn = document.getElementById("queue-toggle");
  panel.classList.toggle("collapsed");
  btn.textContent = panel.classList.contains("collapsed") ? "展开" : "收起";
  renderQueuePanel();
}

// ── Recent Plays ──

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

export function pushSessionRecentFromCurrentTrack(onlinePlayUrl = null) {
  const it = appState.playQueue[appState.playIndex];
  if (!it) return;
  let snap;
  if (it.local_path) {
    snap = { title: it.title, artist: it.artist || "", local_path: it.local_path };
  } else {
    const sid = (it.source_id || "").trim();
    if (!sid) return;
    const pu = onlinePlayUrl && String(onlinePlayUrl).trim() ? String(onlinePlayUrl).trim() : "";
    snap = {
      source_id: sid,
      title: it.title,
      artist: it.artist || "",
      album: it.album || "",
      cover_url: it.cover_url || null,
      ...(pu ? { play_url: pu } : {}),
    };
  }
  const key = snap.local_path ? `L:${snap.local_path}` : `O:${snap.source_id}`;
  appState.sessionRecentPlays = appState.sessionRecentPlays.filter((x) => {
    const k = x.local_path ? `L:${x.local_path}` : `O:${(x.source_id || "").trim()}`;
    return k !== key;
  });
  appState.sessionRecentPlays.unshift(snap);
  if (appState.sessionRecentPlays.length > RECENT_SESSION_MAX) appState.sessionRecentPlays.length = RECENT_SESSION_MAX;
  void persistRecentPlaySnapshot(snap);
  if (document.querySelector('.page[data-page="recent"]')?.classList.contains("page-active")) {
    _deps.renderRecentPlaysTable();
  }
}

// ── Cover Fill ──

async function maybeFillCoverFromLrcCx(generation, queueIndex) {
  if (generation !== appState.playLoadGeneration) return;
  const it = appState.playQueue[queueIndex];
  if (!it) return;
  if ((it.cover_url || "").trim()) return;
  try {
    const url = await invoke("fetch_lrc_cx_cover", {
      title: it.title || "",
      artist: it.artist || "",
      album: it.album ?? null,
    });
    if (generation !== appState.playLoadGeneration) return;
    const cur = appState.playQueue[queueIndex];
    if (!cur) return;
    if (cur.title !== it.title) return;
    if (!isSamePlayableIdentity(cur, it)) return;
    if (url && typeof url === "string" && url.trim()) {
      cur.cover_url = url.trim();
      if (queueIndex === appState.playIndex) {
        const sub = formatNowPlayingSubtitle(cur);
        updatePlayerChrome({ title: cur.title, sub, coverUrl: cur.cover_url });
      }
      renderQueuePanel();
    }
  } catch (e) {
    console.warn("fetch_lrc_cx_cover", e);
  }
}

// ── Remove Current ──

export function removeCurrentFromQueue() {
  if (!appState.playQueue.length) return;
  appState.playQueue.splice(appState.playIndex, 1);
  const a = audioEl();
  if (!appState.playQueue.length) {
    appState.playIndex = 0;
    appState.playLoadGeneration += 1;
    if (a) {
      a.pause();
      a.removeAttribute("src");
    }
    updatePlayerChrome({ title: "未播放", sub: "队列已空", coverUrl: null });
    document.getElementById("btn-player-play").textContent = "▶";
  } else {
    if (appState.playIndex >= appState.playQueue.length) appState.playIndex = appState.playQueue.length - 1;
    playFromQueueIndex(appState.playIndex);
  }
  renderQueuePanel();
  setPlayerNavEnabled();
  refreshFavButton();
}

// ── Hotkey helpers ──

export async function togglePlayPauseFromHotkey() {
  const a = audioEl();
  if (!a?.src) return;
  try {
    if (a.paused) {
      await a.play();
    } else {
      a.pause();
    }
  } catch (err) {
    alertRequestFailed(err, "audio play()");
  }
}

export async function adjustPlayerVolumeDelta(delta) {
  const vol = document.getElementById("volume");
  if (!vol) return;
  let next = Number(vol.value) / 100 + delta;
  next = Math.min(1, Math.max(0, next));
  vol.value = String(Math.round(next * 100));
  const a = audioEl();
  if (a) a.volume = next;
  try {
    await invoke("save_settings", { patch: { volume: next } });
  } catch (e) {
    console.warn("save_settings volume (hotkey)", e);
  }
}

// ── Play From Row helpers ──

export function playFromSearchRow(rowIdx) {
  appState.playQueue = appState.searchState.results.map((r) => ({
    source_id: r.source_id,
    title: r.title,
    artist: r.artist || "",
    album: r.album || "",
    cover_url: r.cover_url || null,
  }));
  playFromQueueIndex(rowIdx);
  renderQueuePanel();
  void saveQueueToSettings();
}

export function playFromPlaylistRow(rowIdx) {
  if (!appState.playlistDetailRows[rowIdx]) return;
  const queue = appState.playlistDetailRows.map((row) => playlistImportRowToQueueItem(row));
  appState.playQueue = queue;
  playFromQueueIndex(rowIdx);
  renderQueuePanel();
  void saveQueueToSettings();
}

export function playFromRecentRow(rowIdx) {
  const snap = appState.sessionRecentPlays[rowIdx];
  if (!snap) return;
  if (snap.local_path) {
    appState.playQueue = [{ title: snap.title, artist: snap.artist || "", local_path: snap.local_path, cover_url: null }];
  } else {
    appState.playQueue = [
      {
        source_id: snap.source_id,
        title: snap.title,
        artist: snap.artist || "",
        album: snap.album || "",
        cover_url: snap.cover_url || null,
      },
    ];
  }
  void playFromQueueIndex(0);
  renderQueuePanel();
  void saveQueueToSettings();
}

// ── Core Play ──

export async function playFromQueueIndex(idx) {
  if (!appState.playQueue.length || idx < 0 || idx >= appState.playQueue.length) return;
  const generation = ++appState.playLoadGeneration;
  appState.playIndex = idx;
  let item = appState.playQueue[idx];
  updatePlayerChrome({
    title: item.title,
    sub: formatLoadingSubtitle(item),
    touchCover: false,
  });
  const playBtn = document.getElementById("btn-player-play");
  const a = audioEl();
  let onlineResolvedPlayUrl = null;
  let playLogExtra = null;
  try {
    let assetUrl;
    if (item.local_path) {
      let pathOk = false;
      try {
        pathOk = await invoke("local_path_accessible", { path: item.local_path });
      } catch (e) {
        console.warn("local_path_accessible", e);
      }
      if (!pathOk) {
        if (generation !== appState.playLoadGeneration) return;
        updatePlayerChrome({
          title: item.title,
          sub: `${item.artist ? `${item.artist} · ` : ""}本地文件不可用`,
          touchCover: false,
        });
        alert(`本地文件不存在或无法访问：\n${String(item.local_path || "").trim() || "（路径为空）"}`);
        return;
      }
      assetUrl = convertFileSrc(item.local_path);
      playLogExtra = { local: true };
    } else {
      let songId = (item.source_id || "").trim();
      const iPl = item.import_playlist_id;
      const iRow = item.import_item_id;
      if (!songId && iPl != null && iRow != null) {
        updatePlayerChrome({
          title: item.title,
          sub: "正在匹配曲库 id…",
          touchCover: false,
        });
        try {
          const filled = await invoke("try_fill_playlist_item_source_id", {
            playlistId: iPl,
            itemId: iRow,
          });
          if (generation !== appState.playLoadGeneration) return;
          if (filled && String(filled).trim()) {
            const fid = String(filled).trim();
            item = { ...item, source_id: fid };
            appState.playQueue[idx] = item;
            songId = fid;
            if (appState.selectedPlaylistId != null && Number(iPl) === Number(appState.selectedPlaylistId)) {
              const match = appState.playlistDetailRows.find((row) => row.id === iRow);
              if (match) match.catalog_id = fid;
              _deps.renderPlaylistDetailTable();
            }
          }
        } catch (e) {
          console.warn("try_fill_playlist_item_source_id", e);
        }
      }
      if (generation !== appState.playLoadGeneration) return;
      if (!songId) {
        updatePlayerChrome({
          title: item.title,
          sub: "无法播放：未匹配到曲库 id",
          touchCover: false,
        });
        alert("无法匹配曲库 id。请在「发现」中搜索该曲，或确认歌名/歌手是否正确。");
        return;
      }
      const resolveRetryBudgetMs = 5000;
      const resolveRetryGapMs = 200;
      const resolveT0 = Date.now();
      let resolved = null;
      let lastErr = null;
      for (;;) {
        if (generation !== appState.playLoadGeneration) return;
        if (Date.now() - resolveT0 >= resolveRetryBudgetMs) break;
        try {
          resolved = await invoke("resolve_online_play", {
            songId: songId,
            title: item.title || "",
            artist: item.artist || "",
          });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (Date.now() - resolveT0 >= resolveRetryBudgetMs) break;
          const wait = Math.min(resolveRetryGapMs, resolveRetryBudgetMs - (Date.now() - resolveT0));
          if (wait > 0) {
            await new Promise((r) => setTimeout(r, wait));
          }
        }
      }
      if (generation !== appState.playLoadGeneration) return;
      if (!resolved) throw lastErr ?? new Error("resolve_online_play failed");
      if (resolved.kind === "url" && resolved.url) {
        assetUrl = resolved.url;
        onlineResolvedPlayUrl = resolved.url;
      } else if (resolved.kind === "file" && resolved.path) {
        assetUrl = convertFileSrc(resolved.path);
      } else {
        throw new Error("resolve_online_play: 无效结果");
      }
      playLogExtra = { sid: songId, kind: resolved.kind, via: resolved.via };
    }
    if (generation !== appState.playLoadGeneration) return;
    await logPlayEventDesktop("play_start", { url: assetUrl, extra: playLogExtra });
    a.pause();
    a.removeAttribute("src");
    a.load();
    a.src = assetUrl;
    appState.audioSourceGeneration = generation;
    await a.play();
    if (generation !== appState.playLoadGeneration) return;
    pushSessionRecentFromCurrentTrack(onlineResolvedPlayUrl);
    updatePlayerChrome({
      title: item.title,
      sub: formatNowPlayingSubtitle(item),
      coverUrl: item.cover_url || null,
    });
    void maybeFillCoverFromLrcCx(generation, idx);
    if (playBtn) {
      playBtn.textContent = "⏸";
      playBtn.disabled = false;
    }
    setPlayerNavEnabled();
    syncSeekUi();
    renderQueuePanel();
    refreshFavButton();
    appState.lrcCacheKey = null;
    if (appState.desktopLyricsOpen) {
      void ensureLrcLoadedForCurrentTrack(generation).then(() => {
        if (generation !== appState.playLoadGeneration) return;
        void syncDesktopLyrics();
      });
    }
  } catch (e) {
    if (generation !== appState.playLoadGeneration) return;
    updatePlayerChrome({
      title: item.title,
      sub: MSG_REQUEST_FAILED,
      touchCover: false,
    });
    alertRequestFailed(e, "playFromQueueIndex");
  }
}
