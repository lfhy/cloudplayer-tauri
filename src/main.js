/** 桌面端入口：组装模块、初始化依赖注入、启动 */
import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { appState } from "./state.js";
import { alertRequestFailed, refreshDownloadedSourceIdSet } from "./utils.js";
import { initContextMenu } from "./context-menu.js";
import { openCloseConfirmModal, wirePreferencesModals } from "./settings.js";
import {
  refreshLyricsLockMenuLabel,
  broadcastDesktopLyricsLock,
} from "./lyrics.js";
import {
  openImmersivePlayer,
  closeImmersivePlayer,
  syncImmersiveSeek,
  wireImmersiveOverlay,
  initImmersiveOverlay,
} from "./immersive.js";
import { initPlayer, renderQueuePanel, toggleQueuePanel, playFromQueueIndex, audioEl } from "./player.js";
import { wireAudio, wireVolume, wireGlobalHotkeyListener } from "./audio-bindings.js";
import { initDockBar, wireDockBar } from "./dock-bar.js";
import {
  renderSidebar,
  refreshPlaylistSelect,
  refreshSidebarPlaylists,
  setPage,
  updateSearchToolbar,
  renderSearchTable,
  wireDiscoverToolbar,
  wireGlobalSearch,
  loadPlaylistDetail,
  renderPlaylistDetailTable,
  renderPlaylistBatchTable,
  wirePlaylistPage,
  renderImportTable,
  wireImportPage,
  loadRecentPlaysFromDb,
  renderRecentPlaysTable,
  renderDownloadTables,
  refreshDownloadedSongsTable,
  wireDownloadPage,
  loadSettings,
} from "./pages.js";
import { wireWindowChrome } from "./window-chrome.js";

// ── 依赖注入 ──

initPlayer({ renderRecentPlaysTable, renderPlaylistDetailTable });
initDockBar({ refreshSidebarPlaylists });
initImmersiveOverlay({ refreshSidebarPlaylists });

// ── Boot ──

function bootDesktop() {
  initContextMenu({
    playFromQueueIndex,
    renderQueuePanel,
    refreshSidebarPlaylists,
    refreshPlaylistSelect,
    loadPlaylistDetail,
    refreshDownloadedSongsTable,
    setPage,
    playFromSearchRow: (i) => {
      appState.playQueue = appState.searchState.results.map((r) => ({
        source_id: r.source_id, title: r.title, artist: r.artist || "", album: r.album || "", cover_url: r.cover_url || null,
      }));
      playFromQueueIndex(i);
      renderQueuePanel();
    },
  });
  void wireWindowChrome();
  setPage("discover");
  invoke("ensure_favorites_playlist")
    .then((id) => { console.log("[boot] favorites playlist id:", id); })
    .catch((err) => { console.warn("[boot] ensure_favorites_playlist failed:", err); })
    .finally(() => {
      renderSidebar();
    });
  // 曲库源切换后，自动为缺少 source_id 的歌单条目重新富化
  invoke("re_enrich_all_playlists")
    .then(() => { console.log("[boot] re_enrich_all_playlists triggered"); })
    .catch((err) => { console.warn("[boot] re_enrich_all_playlists failed:", err); });
  document.getElementById("queue-toggle")?.addEventListener("click", () => toggleQueuePanel());
  wireDockBar();
  wireDownloadPage();
  wireImportPage();
  wirePlaylistPage();
  wireVolume();
  wirePreferencesModals();
  document.getElementById("btn-settings-back")?.addEventListener("click", () => setPage("discover"));
  wireGlobalSearch();
  wireDiscoverToolbar();
  wireAudio();
  wireGlobalHotkeyListener();
  updateSearchToolbar();
  renderQueuePanel();
  refreshLyricsLockMenuLabel();
  let enrichReloadTimer = null;
  listen("import-enrich-item-done", (e) => {
    const p = e.payload;
    const pid = p?.playlistId ?? p?.playlist_id;
    if (pid == null || pid !== appState.selectedPlaylistId) return;
    if (enrichReloadTimer) clearTimeout(enrichReloadTimer);
    enrichReloadTimer = setTimeout(() => {
      enrichReloadTimer = null;
      void loadPlaylistDetail(appState.selectedPlaylistId, appState.selectedPlaylistName);
    }, 450);
  });
  listen("import-enrich-finished", (e) => {
    const p = e.payload;
    const pid = p?.playlistId ?? p?.playlist_id;
    if (pid == null || pid !== appState.selectedPlaylistId) return;
    void loadPlaylistDetail(appState.selectedPlaylistId, appState.selectedPlaylistName);
  });
  listen("desktop-lyrics-lock-sync", async (e) => {
    const locked = e?.payload?.locked;
    if (typeof locked !== "boolean") return;
    appState.desktopLyricsLocked = locked;
    refreshLyricsLockMenuLabel();
  });
  listen("download-task-changed", (e) => {
    const p = e?.payload;
    const sid = p?.source_id ?? p?.sourceId;
    if (sid != null && String(sid) !== "") {
      appState.downloadTasksBySourceId.set(String(sid), p);
    }
    renderDownloadTables();
    void refreshDownloadedSourceIdSet().then(() => {
      renderSearchTable();
      if (appState.playlistDetailRows.length) {
        renderPlaylistDetailTable();
        renderPlaylistBatchTable();
      }
    });
  });
  listen("desktop-lyrics-request-lock", async (e) => {
    const locked = e?.payload?.locked;
    if (typeof locked !== "boolean") return;
    appState.desktopLyricsLocked = locked;
    refreshLyricsLockMenuLabel();
    try {
      await invoke("save_settings", { patch: { desktop_lyrics_locked: locked } });
    } catch (err) {
      console.warn("save_settings desktop_lyrics_locked (request-lock)", err);
    }
    await broadcastDesktopLyricsLock();
  });
  listen("main-close-requested", async () => {
    const a = appState.mainWindowCloseAction;
    if (a === "quit") {
      try {
        await invoke("quit_app");
      } catch (e) {
        alertRequestFailed(e, "close flow");
      }
      return;
    }
    if (a === "tray") {
      try {
        await invoke("hide_main_window");
      } catch (e) {
        alertRequestFailed(e, "close flow");
      }
      return;
    }
    openCloseConfirmModal();
  });
  void loadRecentPlaysFromDb();
  loadSettings();

  // 沉浸播放页：箭头 SVG + 点击封面打开
  const artEl = document.querySelector(".dock-player__art");
  if (artEl && !artEl.querySelector(".dock-player__art-arrows")) {
    const arrows = document.createElement("div");
    arrows.className = "dock-player__art-arrows";
    arrows.innerHTML =
      `<svg viewBox="0 0 14 14" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,2 2,2 2,4"/><line x1="2" y1="2" x2="5.5" y2="5.5"/></svg>` +
      `<svg viewBox="0 0 14 14" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="10,12 12,12 12,10"/><line x1="12" y1="12" x2="8.5" y2="8.5"/></svg>`;
    artEl.appendChild(arrows);
  }
  artEl?.addEventListener("click", openImmersivePlayer);
  wireImmersiveOverlay();
}

export function startDesktop() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootDesktop);
  } else {
    bootDesktop();
  }
}
