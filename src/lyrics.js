/** 歌词引擎：LRC 解析、桌面歌词窗口管理、歌词替换弹窗 */
import { appState } from "./state.js";
import {
  escapeHtml,
  isSamePlayableIdentity,
  setTableMutedMessage,
  alertRequestFailed,
} from "./utils.js";
import { LYRICS_WW_TARGET } from "./constants.js";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** @type {{ renderQueuePanel: Function, refreshFavButton: Function }} */
let _deps = {};

export function initLyrics(deps) {
  _deps = deps;
}

function audioEl() {
  return document.getElementById("audio-player");
}

// ── LRC 解析 ──

/** 歌词：与 Rust `eprintln!("[lyrics] …")` 对应，便于在控制台过滤 */
export function lyricsLog(...args) {
  console.info("[lyrics]", ...args);
}

export function parseLrc(text) {
  const lines = [];
  const timeRe = /\[(\d+):(\d{1,2})(?:[.,](\d{1,3}))?\]/;
  const raw = String(text || "").replace(/^﻿/, "");
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    const m = line.match(timeRe);
    if (!m) continue;
    const min = parseInt(m[1], 10);
    let sec = parseInt(m[2], 10);
    if (sec > 59) sec = 59;
    const frac = m[3] ? m[3].padEnd(3, "0").slice(0, 3) : "000";
    const ms = parseInt(frac, 10);
    const t = min * 60 + sec + ms / 1000;
    const afterTag = line.slice(line.indexOf(m[0]) + m[0].length).trim();
    let rest = afterTag.replace(/^\[[^\]]+\]\s*/g, "").trim();
    if (!rest) rest = afterTag;
    lines.push({ t, text: rest });
  }
  lines.sort((a, b) => a.t - b.t);
  lyricsLog("parseLrc: timed lines", lines.length, "raw length", (text && text.length) || 0);
  return lines;
}

// ── 桌面歌词显示逻辑 ──

/** 桌面歌词：左上 / 右下两行布局 */
export function lyricDisplayForDesktop(ct) {
  const cur = appState.playQueue[appState.playIndex];
  const t = Number(ct) || 0;
  if (!cur) {
    return {
      line1: "—", line2: "—", activeSlot: 1,
      line1StartT: 0, line1EndT: 1, line2StartT: 0, line2EndT: 1,
      line1Words: null, line2Words: null, audioNow: t,
    };
  }
  if (!appState.lrcEntries.length) {
    return {
      line1: cur.title || "—", line2: cur.artist || "在线试听", activeSlot: 1,
      line1StartT: 0, line1EndT: 1, line2StartT: 0, line2EndT: 1,
      line1Words: null, line2Words: null, audioNow: t,
    };
  }
  let idx = 0;
  for (let k = 0; k < appState.lrcEntries.length; k++) {
    const nextT = k + 1 < appState.lrcEntries.length ? appState.lrcEntries[k + 1].t : Infinity;
    if (t + 0.12 >= nextT) { idx = k + 1; continue; }
    if (appState.lrcEntries[k].t <= t + 0.12) idx = k;
    else break;
  }
  const curLine = appState.lrcEntries[idx];
  const nextLine = appState.lrcEntries[idx + 1];
  const startT = curLine?.t ?? 0;
  const endT = nextLine ? nextLine.t : startT + 4;
  const wl = appState.wordLines;

  if (idx % 2 === 0) {
    const line1 = curLine?.text || "—";
    const line2 = nextLine?.text || " ";
    const nextNextLine = appState.lrcEntries[idx + 2];
    const line2EndT = nextNextLine ? nextNextLine.t : endT + 4;
    return {
      line1, line2, activeSlot: 1,
      line1StartT: startT, line1EndT: endT, line2StartT: endT, line2EndT,
      line1Words: wl?.[idx] ?? null,
      line2Words: nextLine ? wl?.[idx + 1] ?? null : null,
      audioNow: t,
    };
  }
  const line2 = curLine?.text || "—";
  const line1 = nextLine?.text || " ";
  const nextNextLine = appState.lrcEntries[idx + 2];
  const line1EndT = nextNextLine ? nextNextLine.t : endT + 4;
  return {
    line1, line2, activeSlot: 2,
    line1StartT: endT, line1EndT,
    line2StartT: startT, line2EndT: endT,
    line1Words: nextLine ? wl?.[idx + 1] ?? null : null,
    line2Words: wl?.[idx] ?? null,
    audioNow: t,
  };
}

// ── 桌面歌词窗口通信 ──

export async function broadcastDesktopLyricsLock() {
  if (appState.desktopLyricsOpen) {
    try {
      await emitTo(LYRICS_WW_TARGET, "desktop-lyrics-lock", { locked: appState.desktopLyricsLocked });
    } catch (e) {
      console.warn("emit desktop-lyrics-lock", e);
    }
  }
}

export async function broadcastDesktopLyricsColors() {
  if (!appState.desktopLyricsOpen) return;
  try {
    const s = await invoke("get_settings");
    await emitTo(LYRICS_WW_TARGET, "desktop-lyrics-colors", {
      base: s.desktop_lyrics_color_base || s.desktopLyricsColorBase || "#ffffff",
      highlight: s.desktop_lyrics_color_highlight || s.desktopLyricsColorHighlight || "#ffb7d4",
    });
  } catch (e) {
    console.warn("emit desktop-lyrics-colors", e);
  }
}

export async function broadcastDesktopLyricsFont() {
  if (!appState.desktopLyricsOpen) return;
  try {
    const s = await invoke("get_settings");
    await emitTo(LYRICS_WW_TARGET, "desktop-lyrics-font", {
      fontFamily: s.desktop_lyrics_font_family ?? s.desktopLyricsFontFamily ?? "",
    });
  } catch (e) {
    console.warn("emit desktop-lyrics-font", e);
  }
}

export function refreshLyricsLockMenuLabel() {
  const btn = document.getElementById("btn-more-lyrics-lock");
  if (!btn) return;
  btn.textContent = appState.desktopLyricsLocked
    ? "桌面歌词：已锁定（穿透点击）— 点此解锁"
    : "桌面歌词：未锁定（可拖动）— 点此锁定";
}

export async function pushDesktopLyricsLines({
  line1, line2, activeSlot = 1,
  line1StartT, line1EndT, line2StartT, line2EndT,
  line1Words = null, line2Words = null, audioNow,
}) {
  if (!appState.desktopLyricsOpen) return;
  try {
    const win = appState.desktopLyricsWindow || (await WebviewWindow.getByLabel("lyrics"));
    if (win) appState.desktopLyricsWindow = win;
    await emitTo(LYRICS_WW_TARGET, "desktop-lyrics-lines", {
      line1: line1 || "—", line2: line2 || "—",
      activeSlot: activeSlot === 2 ? 2 : 1,
      line1StartT: Number(line1StartT) || 0,
      line1EndT: Number(line1EndT) || 0,
      line2StartT: Number(line2StartT) || 0,
      line2EndT: Number(line2EndT) || 0,
      line1Words: line1Words ?? null,
      line2Words: line2Words ?? null,
      audioNow: Number(audioNow) || 0,
    });
  } catch (e) {
    console.warn("emit lyrics", e);
    appState.desktopLyricsOpen = false;
    appState.desktopLyricsWindow = null;
    document.getElementById("btn-dock-lyrics")?.classList.remove("is-on");
  }
}

// ── 歌词加载 ──

/**
 * @param {number | undefined} loadGen 传入发起播放时的 `playLoadGeneration`，用于丢弃过期异步结果
 */
export async function ensureLrcLoadedForCurrentTrack(loadGen) {
  const cur = appState.playQueue[appState.playIndex];
  if (!cur) {
    lyricsLog("ensureLrc: no current track");
    const a = audioEl();
    await pushDesktopLyricsLines({
      line1: "—", line2: "—", activeSlot: 1,
      line1StartT: 0, line1EndT: 1, line2StartT: 0, line2EndT: 0,
      audioNow: a?.currentTime ?? 0,
    });
    return;
  }
  const cacheKey = cur.local_path ? `local:${cur.local_path}` : (cur.source_id || "").trim();
  if (appState.lrcCacheKey === cacheKey) {
    lyricsLog("ensureLrc: cache hit", cacheKey);
    return;
  }
  try {
    const a = audioEl();
    const dur = a && a.duration && isFinite(a.duration) && a.duration > 0 ? a.duration : null;
    lyricsLog("ensureLrc: fetching", {
      cacheKey, title: cur.title, artist: cur.artist,
      sourceId: (cur.source_id || "").trim() || null,
      localPath: cur.local_path || null,
      durationSeconds: dur,
      loadGen: loadGen ?? "(omit)",
    });
    const raw = await invoke("fetch_song_lrc_enriched", {
      req: {
        catalogId: cur.local_path ? null : (cur.source_id || "").trim() || null,
        title: cur.title || "",
        artist: cur.artist || "",
        album: cur.album || "",
        localPath: cur.local_path || null,
        durationSeconds: dur,
      },
    });
    if (loadGen !== undefined && loadGen !== appState.playLoadGeneration) return;
    const cur2 = appState.playQueue[appState.playIndex];
    if (!isSamePlayableIdentity(cur2, cur)) {
      lyricsLog("ensureLrc: stale generation or track changed after fetch, discard");
      return;
    }
    if (raw && typeof raw === "object" && raw.lrcText != null) {
      const lt = String(raw.lrcText);
      lyricsLog("ensureLrc: got payload chars", lt.length, "wordLines", raw.wordLines?.length ?? 0);
      appState.lrcEntries = parseLrc(lt);
      appState.wordLines = Array.isArray(raw.wordLines) ? raw.wordLines : null;
      lyricsLog("ensureLrc: lrcEntries length", appState.lrcEntries.length);
      if (appState.lrcEntries.length > 0) {
        appState.lrcCacheKey = cacheKey;
      } else {
        appState.wordLines = null;
        lyricsLog("ensureLrc: parse produced 0 lines, not caching");
      }
    } else if (raw && typeof raw === "string") {
      lyricsLog("ensureLrc: got raw string chars", raw.length);
      appState.lrcEntries = parseLrc(raw);
      appState.wordLines = null;
      lyricsLog("ensureLrc: lrcEntries length", appState.lrcEntries.length);
      if (appState.lrcEntries.length > 0) {
        appState.lrcCacheKey = cacheKey;
      } else {
        lyricsLog("ensureLrc: parse produced 0 lines, not caching");
      }
    } else {
      appState.lrcCacheKey = cacheKey;
      appState.lrcEntries = [];
      appState.wordLines = null;
      lyricsLog("ensureLrc: no raw lyrics (null/empty)");
    }
  } catch (e) {
    console.warn("[lyrics] fetch_song_lrc_enriched", e);
    if (loadGen !== undefined && loadGen !== appState.playLoadGeneration) return;
    const cur2 = appState.playQueue[appState.playIndex];
    if (!isSamePlayableIdentity(cur2, cur)) {
      lyricsLog("ensureLrc: error path discard (track changed)");
      return;
    }
    appState.lrcCacheKey = cacheKey;
    appState.lrcEntries = [];
    appState.wordLines = null;
    lyricsLog("ensureLrc: error, cleared lrcEntries");
  }
}

// ── 同步 ──

export async function syncDesktopLyrics() {
  if (!appState.desktopLyricsOpen) return;
  const ct = audioEl()?.currentTime ?? 0;
  const data = lyricDisplayForDesktop(ct);
  await pushDesktopLyricsLines(data);
}

export async function setDockLyricsActive(on) {
  document.getElementById("btn-dock-lyrics")?.classList.toggle("is-on", on);
}

export function scheduleDesktopLyricsStyleSync() {
  queueMicrotask(() => {
    void broadcastDesktopLyricsLock();
    void broadcastDesktopLyricsColors();
    void broadcastDesktopLyricsFont();
  });
}

// ── 桌面歌词窗口管理 ──

export function defaultDesktopLyricsBounds() {
  const width = Math.min(720, window.screen.availWidth - 40);
  const x = Math.max(0, Math.floor((window.screen.availWidth - width) / 2));
  return { x, y: 48, width, height: 132 };
}

export function desktopLyricsBoundsFromSettings(s) {
  const d = defaultDesktopLyricsBounds();
  let x = typeof s?.desktop_lyrics_x === "number" ? s.desktop_lyrics_x : d.x;
  let y = typeof s?.desktop_lyrics_y === "number" ? s.desktop_lyrics_y : d.y;
  let width = typeof s?.desktop_lyrics_width === "number" ? s.desktop_lyrics_width : d.width;
  let height = typeof s?.desktop_lyrics_height === "number" ? s.desktop_lyrics_height : d.height;
  const maxW = Math.max(320, window.screen.availWidth - 8);
  const maxH = Math.max(88, window.screen.availHeight - 8);
  width = Math.max(320, Math.min(Math.round(width), maxW));
  height = Math.max(88, Math.min(Math.round(height), maxH));
  x = Math.min(Math.max(0, Math.round(x)), Math.max(0, window.screen.availWidth - 48));
  y = Math.min(Math.max(0, Math.round(y)), Math.max(0, window.screen.availHeight - 48));
  return { x, y, width, height };
}

export async function persistDesktopLyricsVisible(visible) {
  try {
    await invoke("save_settings", { patch: { desktop_lyrics_visible: visible } });
  } catch (e) {
    console.warn("save_settings desktop_lyrics_visible", e);
  }
}

export function desktopLyricsWindowOptions(bounds) {
  return {
    url: "/desktop_lyrics.html",
    title: "桌面歌词",
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    resizable: true,
    maximizable: false,
    alwaysOnTop: true,
    decorations: false,
    transparent: true,
    shadow: false,
    skipTaskbar: true,
    focus: true,
  };
}

export async function onDesktopLyricsShown(persistVisible) {
  appState.desktopLyricsOpen = true;
  await setDockLyricsActive(true);
  if (persistVisible) {
    await persistDesktopLyricsVisible(true);
  }
  appState.lrcCacheKey = null;
  await ensureLrcLoadedForCurrentTrack(appState.playLoadGeneration);
  await syncDesktopLyrics();
  scheduleDesktopLyricsStyleSync();
}

export function bindDesktopLyricsWindowLifecycle(
  win,
  { persistVisibleOnCreate = false, showCreateAlert = false } = {}
) {
  win.once("tauri://error", (e) => {
    console.error(e);
    if (showCreateAlert) {
      alert("无法创建桌面歌词窗口（请确认已授予 webview 创建权限）。");
    }
  });
  win.once("tauri://created", async () => {
    appState.desktopLyricsWindow = win;
    win.once("tauri://destroyed", async () => {
      appState.desktopLyricsOpen = false;
      appState.desktopLyricsWindow = null;
      await setDockLyricsActive(false);
      await persistDesktopLyricsVisible(false);
    });
    await onDesktopLyricsShown(persistVisibleOnCreate);
  });
}

export async function openDesktopLyricsFromSettingsIfNeeded(s) {
  if (!s?.desktop_lyrics_visible) return;
  const existing = await WebviewWindow.getByLabel("lyrics");
  if (existing) {
    appState.desktopLyricsWindow = existing;
    const vis = await existing.isVisible();
    if (!vis) await existing.show();
    await existing.setFocus();
    await onDesktopLyricsShown(false);
    return;
  }
  const b = desktopLyricsBoundsFromSettings(s);
  const win = new WebviewWindow("lyrics", desktopLyricsWindowOptions(b));
  bindDesktopLyricsWindowLifecycle(win, { persistVisibleOnCreate: false });
}

export async function toggleDesktopLyrics() {
  const existing = appState.desktopLyricsWindow || (await WebviewWindow.getByLabel("lyrics"));
  if (existing) appState.desktopLyricsWindow = existing;
  if (existing) {
    const vis = await existing.isVisible();
    if (vis) {
      await existing.hide();
      appState.desktopLyricsOpen = false;
      await setDockLyricsActive(false);
      await persistDesktopLyricsVisible(false);
      return;
    }
    await existing.show();
    await existing.setFocus();
    await onDesktopLyricsShown(true);
    return;
  }

  let bounds = defaultDesktopLyricsBounds();
  try {
    const s = await invoke("get_settings");
    bounds = desktopLyricsBoundsFromSettings(s);
  } catch (e) {
    console.warn("get_settings for lyrics bounds", e);
  }

  const win = new WebviewWindow("lyrics", desktopLyricsWindowOptions(bounds));
  bindDesktopLyricsWindowLifecycle(win, { persistVisibleOnCreate: true, showCreateAlert: true });
}

// ── 歌词替换弹窗 ──

export function openLyricsReplaceModal() {
  const modal = document.getElementById("lyrics-replace-modal");
  if (!modal) return;
  appState.lyricsReplaceCandidates = [];
  appState.lyricsReplaceSelectedIndex = -1;
  appState.lyricsReplacePreviewPayload = null;
  appState.lyricsReplaceFetchGen = 0;
  const tbody = document.querySelector("#lyrics-replace-table tbody");
  if (tbody) tbody.innerHTML = "";
  const preview = document.getElementById("lyrics-replace-preview");
  if (preview) preview.textContent = "";
  const titleInput = document.getElementById("lyrics-replace-title");
  const artistInput = document.getElementById("lyrics-replace-artist");
  const cur = appState.playQueue[appState.playIndex];
  if (titleInput) titleInput.value = cur?.title || "";
  if (artistInput) artistInput.value = cur?.artist || "";
  modal.hidden = false;
}

export async function searchLyricsReplaceCandidates() {
  const title = document.getElementById("lyrics-replace-title")?.value?.trim() || "";
  const artist = document.getElementById("lyrics-replace-artist")?.value?.trim() || "";
  if (!title) {
    alert("请输入歌曲标题。");
    return;
  }
  const gen = ++appState.lyricsReplaceFetchGen;
  appState.lyricsReplaceCandidates = [];
  appState.lyricsReplaceSelectedIndex = -1;
  renderLyricsReplaceTable();
  const tbody = document.querySelector("#lyrics-replace-table tbody");
  setTableMutedMessage(tbody, 4, "搜索中…");
  try {
    const results = await invoke("search_lyrics_replace", { title, artist, album: "" });
    if (gen !== appState.lyricsReplaceFetchGen) return;
    appState.lyricsReplaceCandidates = Array.isArray(results) ? results : [];
    renderLyricsReplaceTable();
  } catch (e) {
    if (gen !== appState.lyricsReplaceFetchGen) return;
    alertRequestFailed(e, "search_lyrics_replace");
    setTableMutedMessage(tbody, 4, "搜索失败");
  }
}

export function renderLyricsReplaceTable() {
  const tbody = document.querySelector("#lyrics-replace-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const list = appState.lyricsReplaceCandidates;
  if (!list.length) {
    setTableMutedMessage(tbody, 4, "无结果，请尝试搜索。");
    return;
  }
  list.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.innerHTML = `
      <td class="col-idx">${i + 1}</td>
      <td>${escapeHtml(r.title || "—")}</td>
      <td>${escapeHtml(r.artist || "—")}</td>
      <td class="muted">${escapeHtml(r.source || r.provider || "—")}</td>`;
    tr.addEventListener("click", () => selectLyricsReplaceRow(i));
    if (i === appState.lyricsReplaceSelectedIndex) tr.classList.add("is-selected");
    tbody.appendChild(tr);
  });
}

export async function selectLyricsReplaceRow(idx) {
  appState.lyricsReplaceSelectedIndex = idx;
  renderLyricsReplaceTable();
  const r = appState.lyricsReplaceCandidates[idx];
  if (!r) return;
  const gen = appState.lyricsReplaceFetchGen;
  const preview = document.getElementById("lyrics-replace-preview");
  if (preview) preview.textContent = "加载预览中…";
  try {
    const payload = await invoke("fetch_lyrics_replace_preview", {
      title: r.title || "",
      artist: r.artist || "",
      source: r.source || r.provider || "",
      sourceId: r.source_id || r.sourceId || "",
    });
    if (gen !== appState.lyricsReplaceFetchGen) return;
    appState.lyricsReplacePreviewPayload = payload;
    if (preview) {
      if (payload && typeof payload === "object" && payload.lrcText) {
        const lines = String(payload.lrcText).split(/\r?\n/).slice(0, 20);
        preview.textContent = lines.join("\n") + (String(payload.lrcText).split(/\r?\n/).length > 20 ? "\n…" : "");
      } else if (typeof payload === "string") {
        const lines = payload.split(/\r?\n/).slice(0, 20);
        preview.textContent = lines.join("\n") + (payload.split(/\r?\n/).length > 20 ? "\n…" : "");
      } else {
        preview.textContent = "无预览内容";
      }
    }
  } catch (e) {
    if (gen !== appState.lyricsReplaceFetchGen) return;
    if (preview) preview.textContent = "预览加载失败";
    appState.lyricsReplacePreviewPayload = null;
  }
}

export async function applyLyricsReplace() {
  const idx = appState.lyricsReplaceSelectedIndex;
  const r = appState.lyricsReplaceCandidates[idx];
  if (!r) {
    alert("请先选择一条歌词。");
    return;
  }
  const cur = appState.playQueue[appState.playIndex];
  if (!cur) return;
  const sid = (cur.source_id || "").trim();
  if (!sid) {
    alert("当前曲目无曲库 id，无法保存替换歌词。");
    return;
  }
  try {
    await invoke("save_lyrics_replace", {
      sourceId: sid,
      title: r.title || "",
      artist: r.artist || "",
      source: r.source || r.provider || "",
      sourceIdLyrics: r.source_id || r.sourceId || "",
    });
    appState.lrcCacheKey = null;
    appState.lrcEntries = [];
    appState.wordLines = null;
    await ensureLrcLoadedForCurrentTrack(appState.playLoadGeneration);
    if (appState.desktopLyricsOpen) await syncDesktopLyrics();
    _deps.renderQueuePanel();
    alert("歌词已替换并缓存。");
    const modal = document.getElementById("lyrics-replace-modal");
    if (modal) modal.hidden = true;
  } catch (e) {
    alertRequestFailed(e, "save_lyrics_replace");
  }
}

export function wireLyricsReplaceModal() {
  document.getElementById("lyrics-replace-search-btn")?.addEventListener("click", () => {
    void searchLyricsReplaceCandidates();
  });
  document.getElementById("lyrics-replace-apply")?.addEventListener("click", () => {
    void applyLyricsReplace();
  });
  document.getElementById("lyrics-replace-cancel")?.addEventListener("click", () => {
    const modal = document.getElementById("lyrics-replace-modal");
    if (modal) modal.hidden = true;
  });
  document.getElementById("lyrics-replace-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "lyrics-replace-modal") {
      const modal = document.getElementById("lyrics-replace-modal");
      if (modal) modal.hidden = true;
    }
  });
  document.getElementById("lyrics-replace-keyword")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void searchLyricsReplaceCandidates();
    }
  });
  document.addEventListener("keydown", (e) => {
    const modal = document.getElementById("lyrics-replace-modal");
    if (!modal || modal.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      modal.hidden = true;
    }
  });
}
