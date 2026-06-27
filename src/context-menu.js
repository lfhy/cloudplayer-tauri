/** 右键菜单系统（对齐 Py sidebar / import_track_context_menu） */
import { appState } from "./state.js";
import {
  escapeHtml,
  alertRequestFailed,
  searchResultToQueueItem,
  playlistImportRowToQueueItem,
  localLibraryRowToQueueItem,
  downloadedSongRowToQueueItem,
  buildPlaylistImportItem,
  listPlaylistsCached,
  enqueueDownloadForTrack,
  catalogIdFromRow,
} from "./utils.js";
import { saveQueueToSettings } from "./player.js";

/** @type {{ playFromQueueIndex: Function, renderQueuePanel: Function, refreshSidebarPlaylists: Function, refreshPlaylistSelect: Function, loadPlaylistDetail: Function, refreshDownloadedSongsTable: Function, setPage: Function }} */
let _deps = {};

/**
 * 初始化右键菜单依赖注入（在 main.js boot 时调用）
 * @param {object} deps
 */
export function initContextMenu(deps) {
  _deps = deps;
}

export function closeContextMenu() {
  if (appState.contextMenuCleanup) {
    appState.contextMenuCleanup();
    appState.contextMenuCleanup = null;
  }
}

export function mountContextMenuAt(clientX, clientY, rootEl) {
  closeContextMenu();
  rootEl.classList.add("ctx-menu");
  Object.assign(rootEl.style, {
    position: "fixed",
    zIndex: "300",
    left: "0px",
    top: "0px",
  });
  document.body.appendChild(rootEl);
  const pad = 8;
  const place = () => {
    const r = rootEl.getBoundingClientRect();
    const left = Math.max(pad, Math.min(clientX, window.innerWidth - r.width - pad));
    const top = Math.max(pad, Math.min(clientY, window.innerHeight - r.height - pad));
    rootEl.style.left = `${left}px`;
    rootEl.style.top = `${top}px`;
  };
  place();

  const onDown = (e) => {
    if (rootEl.contains(e.target)) return;
    closeContextMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeContextMenu();
  };
  const tid = window.setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
  appState.contextMenuCleanup = () => {
    window.clearTimeout(tid);
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    rootEl.remove();
  };
}

export function cmSep() {
  const d = document.createElement("div");
  d.className = "ctx-menu__sep";
  return d;
}

export function cmBtn(label, onClick, disabled) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ctx-menu__item";
  b.textContent = label;
  if (disabled) b.disabled = true;
  else {
    b.addEventListener("click", () => {
      closeContextMenu();
      try {
        const ret = onClick();
        if (ret != null && typeof ret.then === "function") ret.catch((e) => alertRequestFailed(e, "ctx-menu"));
      } catch (e) {
        alertRequestFailed(e, "ctx-menu");
      }
    });
  }
  return b;
}

async function copyImportTrackInfoToClipboard({ title, artist, album, sourceId, coverUrl, localPath }) {
  const lines = [];
  if ((title || "").trim()) lines.push((title || "").trim());
  if ((artist || "").trim()) lines.push((artist || "").trim());
  if ((album || "").trim()) lines.push(`专辑：${(album || "").trim()}`);
  const sid = (sourceId || "").trim();
  if (sid) lines.push(`曲库 ID：${sid}`);
  const lp = (localPath || "").trim();
  if (lp) lines.push(`本地路径：${lp}`);
  const cu = (coverUrl || "").trim();
  if (cu) lines.push(`封面：${cu}`);
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.prompt("复制以下内容：", text);
  }
}

/** @param {{ sourceId?: string, title?: string, artist?: string }} track */
export function buildDownloadSubmenu(track) {
  const dlRow = document.createElement("div");
  dlRow.className = "ctx-menu__row--sub";
  const dlFly = document.createElement("div");
  dlFly.className = "ctx-menu__fly";
  dlFly.textContent = "下载";
  const dlSub = document.createElement("div");
  dlSub.className = "ctx-menu__subpanel";
  for (const [label, q] of [
    ["FLAC", "flac"],
    ["高品质 320", "320"],
    ["标准 128", "128"],
  ]) {
    dlSub.appendChild(
      cmBtn(label, () => {
        void enqueueDownloadForTrack(track, q);
      })
    );
  }
  dlRow.appendChild(dlFly);
  dlRow.appendChild(dlSub);
  return dlRow;
}

/**
 * @param {{ title: string, artist: string, album?: string, sourceId?: string, source_id?: string, catalog_id?: string, coverUrl?: string | null, cover_url?: string | null, playUrl?: string, play_url?: string, durationMs?: number, duration_ms?: number }} t
 */
export function buildAddToSubmenu(t) {
  const addRow = document.createElement("div");
  addRow.className = "ctx-menu__row--sub";
  const fly = document.createElement("div");
  fly.className = "ctx-menu__fly";
  fly.textContent = "添加到";
  const sub = document.createElement("div");
  sub.className = "ctx-menu__subpanel";
  sub.appendChild(
    cmBtn("播放队列", () => {
      const qItem = {
        source_id: t.sourceId,
        title: t.title,
        artist: t.artist || "",
        album: t.album || "",
        cover_url: t.coverUrl || null,
      };
      if (!(qItem.source_id || "").trim()) {
        alert("该条没有曲库 id，无法加入播放队列。");
        return;
      }
      appState.playQueue.push(qItem);
      _deps.renderQueuePanel();
      void saveQueueToSettings();
    })
  );
  sub.appendChild(
    cmBtn("试听列表", () => {
      const qItem = {
        source_id: t.sourceId,
        title: t.title,
        artist: t.artist || "",
        album: t.album || "",
        cover_url: t.coverUrl || null,
      };
      if (!(qItem.source_id || "").trim()) {
        alert("该条没有曲库 id，无法加入播放队列。");
        return;
      }
      appState.playQueue.push(qItem);
      _deps.renderQueuePanel();
      void saveQueueToSettings();
    })
  );
  sub.appendChild(cmSep());
  sub.appendChild(
    cmBtn("添加到新歌单", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const name = window.prompt("歌单名称（将写入 library.db）", "新歌单");
      if (!name || !name.trim()) return;
      const pid = await invoke("create_playlist", { name: name.trim() });
      await invoke("append_playlist_import_items", {
        playlistId: pid,
        items: [buildPlaylistImportItem(t)],
      });
      await _deps.refreshSidebarPlaylists();
      await _deps.refreshPlaylistSelect();
    })
  );
  sub.appendChild(cmSep());
  return { addRow, fly, sub };
}

export async function openSearchRowContextMenu(ev, rowIdx) {
  const { invoke } = await import("@tauri-apps/api/core");
  ev.preventDefault();
  if (rowIdx < 0 || rowIdx >= appState.searchState.results.length) return;
  const r = appState.searchState.results[rowIdx];
  const qItem = searchResultToQueueItem(r);
  const pls = await listPlaylistsCached();

  const root = document.createElement("div");
  root.appendChild(cmBtn("播放", () => _deps.playFromSearchRow(rowIdx)));
  root.appendChild(
    cmBtn("下一首播放", () => {
      if (!appState.playQueue.length) {
        appState.playQueue = [qItem];
        void _deps.playFromQueueIndex(0);
      } else {
        appState.playQueue.splice(appState.playIndex + 1, 0, qItem);
      }
      _deps.renderQueuePanel();
      void saveQueueToSettings();
    })
  );
  root.appendChild(cmSep());

  const { addRow, fly, sub } = buildAddToSubmenu({
    title: r.title,
    artist: r.artist,
    album: r.album,
    sourceId: r.source_id,
    coverUrl: r.cover_url,
  });
  let any = false;
  for (const p of pls) {
    const pid = p.id;
    if (pid == null) continue;
    any = true;
    const name = (p.name || "").trim() || `#${pid}`;
    sub.appendChild(
      cmBtn(name, async () => {
        await invoke("append_playlist_import_items", {
          playlistId: pid,
          items: [
            buildPlaylistImportItem({
              title: r.title,
              artist: r.artist || "",
              album: r.album || "",
              sourceId: r.source_id,
              coverUrl: r.cover_url || "",
            }),
          ],
        });
        await _deps.refreshSidebarPlaylists();
      })
    );
  }
  if (!any) sub.appendChild(cmBtn("（暂无歌单，请先新建）", () => {}, true));
  addRow.appendChild(fly);
  addRow.appendChild(sub);
  root.appendChild(addRow);

  root.appendChild(
    buildDownloadSubmenu({ sourceId: r.source_id, title: r.title, artist: r.artist })
  );
  root.appendChild(cmBtn("分享", () => {}, true));
  root.appendChild(cmBtn("查看评论", () => {}, true));
  root.appendChild(cmSep());
  root.appendChild(
    cmBtn("复制歌曲信息", () =>
      copyImportTrackInfoToClipboard({
        title: r.title,
        artist: r.artist,
        album: r.album,
        sourceId: r.source_id,
        coverUrl: r.cover_url,
      })
    )
  );

  mountContextMenuAt(ev.clientX, ev.clientY, root);
}

export async function openSidebarPlaylistContextMenu(ev, pl) {
  const { invoke } = await import("@tauri-apps/api/core");
  ev.preventDefault();
  const isFav = !!pl.is_favorites;
  const root = document.createElement("div");
  root.appendChild(
    cmBtn("播放", async () => {
      const rows = await invoke("list_playlist_import_items", { playlistId: pl.id });
      if (!rows || !rows.length) {
        alert("歌单为空。");
        return;
      }
      const pid = pl.id;
      appState.playQueue = rows.map((row) => ({
        source_id: catalogIdFromRow(row),
        title: row.title,
        artist: row.artist || "",
        album: row.album || "",
        cover_url: (row.cover_url || "").trim() || null,
        import_playlist_id: pid != null ? Number(pid) : null,
        import_item_id: row.id != null ? row.id : null,
      }));
      _deps.playFromQueueIndex(0);
      _deps.renderQueuePanel();
      void saveQueueToSettings();
    })
  );
  if (!isFav) {
    root.appendChild(
      cmBtn("重命名", async () => {
        const name = window.prompt("歌单名称", pl.name || "");
        if (!name || !name.trim()) return;
        await invoke("rename_playlist", { playlistId: pl.id, name: name.trim() });
        if (appState.selectedPlaylistId === pl.id) appState.selectedPlaylistName = name.trim();
        await _deps.refreshSidebarPlaylists();
        await _deps.refreshPlaylistSelect();
      })
    );
    root.appendChild(
      cmBtn("删除歌单", async () => {
        if (!window.confirm(`确定删除歌单「${(pl.name || "").trim() || pl.id}」？`)) return;
        await invoke("delete_playlist", { playlistId: pl.id });
        if (appState.selectedPlaylistId === pl.id) {
          appState.selectedPlaylistId = null;
          appState.selectedPlaylistName = "";
        }
        await _deps.refreshSidebarPlaylists();
        await _deps.refreshPlaylistSelect();
        const plPage = document.querySelector('.page[data-page="playlist"]');
        if (plPage?.classList.contains("page-active")) _deps.setPage("discover");
      })
    );
  }
  mountContextMenuAt(ev.clientX, ev.clientY, root);
}

export async function openPlaylistDetailRowContextMenu(ev, rowIdx) {
  const { invoke } = await import("@tauri-apps/api/core");
  ev.preventDefault();
  const r = appState.playlistDetailRows[rowIdx];
  if (!r) return;
  const item = playlistImportRowToQueueItem(r);
  const pls = await listPlaylistsCached();
  const ex = appState.selectedPlaylistId;

  const root = document.createElement("div");
  root.appendChild(
    cmBtn("播放", () => {
      appState.playQueue = [item];
      void _deps.playFromQueueIndex(0);
      _deps.renderQueuePanel();
      void saveQueueToSettings();
    })
  );
  root.appendChild(
    cmBtn("下一首播放", () => {
      if (!appState.playQueue.length) {
        appState.playQueue = [item];
        void _deps.playFromQueueIndex(0);
      } else {
        appState.playQueue.splice(appState.playIndex + 1, 0, item);
        _deps.renderQueuePanel();
        void saveQueueToSettings();
      }
    })
  );
  root.appendChild(cmSep());

  const { addRow, fly, sub } = buildAddToSubmenu({
    title: r.title,
    artist: r.artist,
    album: r.album,
    sourceId: catalogIdFromRow(r),
    coverUrl: r.cover_url,
    durationMs: r.duration_ms,
  });
  let any = false;
  for (const p of pls) {
    const pid = p.id;
    if (pid == null) continue;
    if (ex != null && Number(pid) === Number(ex)) continue;
    any = true;
    const name = (p.name || "").trim() || `#${pid}`;
    sub.appendChild(
      cmBtn(name, async () => {
        await invoke("append_playlist_import_items", {
          playlistId: pid,
          items: [
            buildPlaylistImportItem({
              title: r.title,
              artist: r.artist || "",
              album: r.album || "",
              sourceId: catalogIdFromRow(r),
              coverUrl: r.cover_url || "",
              durationMs: r.duration_ms,
            }),
          ],
        });
        await _deps.refreshSidebarPlaylists();
      })
    );
  }
  if (!any) sub.appendChild(cmBtn("（暂无其它歌单）", () => {}, true));
  addRow.appendChild(fly);
  addRow.appendChild(sub);
  root.appendChild(addRow);

  root.appendChild(
    buildDownloadSubmenu({ sourceId: catalogIdFromRow(r), title: r.title, artist: r.artist })
  );
  root.appendChild(cmBtn("分享", () => {}, true));
  root.appendChild(cmBtn("查看评论", () => {}, true));
  root.appendChild(cmSep());
  root.appendChild(
    cmBtn("复制歌曲信息", () =>
      copyImportTrackInfoToClipboard({
        title: r.title,
        artist: r.artist,
        album: r.album,
        sourceId: catalogIdFromRow(r),
        coverUrl: r.cover_url,
      })
    )
  );

  if (r.id != null && r.id > 0 && appState.selectedPlaylistId != null) {
    root.appendChild(cmSep());
    root.appendChild(
      cmBtn("删除", async () => {
        if (!window.confirm("从当前歌单中删除该条目？")) return;
        await invoke("delete_playlist_import_item", {
          playlistId: appState.selectedPlaylistId,
          itemId: r.id,
        });
        await _deps.loadPlaylistDetail(appState.selectedPlaylistId, appState.selectedPlaylistName);
        await _deps.refreshPlaylistSelect();
      })
    );
  }

  mountContextMenuAt(ev.clientX, ev.clientY, root);
}

export async function openDownloadedSongRowContextMenu(ev, rowIdx) {
  const { invoke } = await import("@tauri-apps/api/core");
  ev.preventDefault();
  const r = appState.downloadedSongsRows[rowIdx];
  if (!r) return;
  const item = downloadedSongRowToQueueItem(r);
  const pathOk = !!(item.local_path || "").trim();
  const pls = await listPlaylistsCached();

  const root = document.createElement("div");
  root.appendChild(
    cmBtn(
      "播放",
      () => {
        if (!pathOk) {
          alert("无有效本地文件路径。");
          return;
        }
        appState.playQueue = [item];
        void _deps.playFromQueueIndex(0);
        _deps.renderQueuePanel();
        void saveQueueToSettings();
      },
      !pathOk
    )
  );
  root.appendChild(
    cmBtn(
      "下一首播放",
      () => {
        if (!pathOk) {
          alert("无有效本地文件路径，无法插播。");
          return;
        }
        if (!appState.playQueue.length) {
          appState.playQueue = [item];
          void _deps.playFromQueueIndex(0);
        } else {
          appState.playQueue.splice(appState.playIndex + 1, 0, item);
        }
        _deps.renderQueuePanel();
        void saveQueueToSettings();
      },
      !pathOk
    )
  );
  root.appendChild(cmSep());

  const addRow = document.createElement("div");
  addRow.className = "ctx-menu__row--sub";
  const fly = document.createElement("div");
  fly.className = "ctx-menu__fly";
  fly.textContent = "添加到";
  const sub = document.createElement("div");
  sub.className = "ctx-menu__subpanel";
  sub.appendChild(
    cmBtn("播放队列", () => {
      if (!pathOk) {
        alert("无有效本地文件路径。");
        return;
      }
      appState.playQueue.push(item);
      _deps.renderQueuePanel();
      void saveQueueToSettings();
    })
  );
  sub.appendChild(
    cmBtn("试听列表", () => {
      if (!pathOk) {
        alert("无有效本地文件路径。");
        return;
      }
      appState.playQueue.push(item);
      _deps.renderQueuePanel();
      void saveQueueToSettings();
    })
  );
  sub.appendChild(cmSep());
  sub.appendChild(
    cmBtn("添加到新歌单", async () => {
      const name = window.prompt("歌单名称（将写入 library.db）", "新歌单");
      if (!name || !name.trim()) return;
      const pid = await invoke("create_playlist", { name: name.trim() });
      await invoke("append_playlist_import_items", {
        playlistId: pid,
        items: [
          buildPlaylistImportItem({
            title: r.title,
            artist: r.artist || "",
            album: r.album || "",
            sourceId: catalogIdFromRow(r),
          }),
        ],
      });
      await _deps.refreshSidebarPlaylists();
      await _deps.refreshPlaylistSelect();
    })
  );
  sub.appendChild(cmSep());
  let any = false;
  for (const p of pls) {
    const pid = p.id;
    if (pid == null) continue;
    any = true;
    const name = (p.name || "").trim() || `#${pid}`;
    sub.appendChild(
      cmBtn(name, async () => {
        await invoke("append_playlist_import_items", {
          playlistId: pid,
          items: [
            buildPlaylistImportItem({
              title: r.title,
              artist: r.artist || "",
              album: r.album || "",
              sourceId: catalogIdFromRow(r),
            }),
          ],
        });
        await _deps.refreshSidebarPlaylists();
      })
    );
  }
  if (!any) sub.appendChild(cmBtn("（暂无歌单，请先新建）", () => {}, true));
  addRow.appendChild(fly);
  addRow.appendChild(sub);
  root.appendChild(addRow);

  root.appendChild(cmSep());
  root.appendChild(
    cmBtn("复制歌曲信息", () =>
      copyImportTrackInfoToClipboard({
        title: r.title,
        artist: r.artist,
        album: r.album,
        sourceId: catalogIdFromRow(r),
        coverUrl: null,
        localPath: r.file_path ?? r.filePath,
      })
    )
  );

  root.appendChild(cmSep());
  root.appendChild(
    cmBtn("删除本地文件…", async () => {
      const fp = String(r.file_path ?? r.filePath ?? "").trim();
      if (!fp) return;
      if (!window.confirm("将删除磁盘上的文件，并从「下载歌曲」列表中移除。确定？")) return;
      try {
        await invoke("delete_downloaded_song", { file_path: fp });
        await _deps.refreshDownloadedSongsTable();
      } catch (e) {
        alertRequestFailed(e, "delete_downloaded_song");
      }
    })
  );

  mountContextMenuAt(ev.clientX, ev.clientY, root);
}

export async function openLocalLibraryRowContextMenu(ev, rowIdx) {
  const { invoke } = await import("@tauri-apps/api/core");
  ev.preventDefault();
  const r = appState.localLibraryRows[rowIdx];
  if (!r) return;
  const item = localLibraryRowToQueueItem(r);
  const pathOk = !!(item.local_path || "").trim();
  const pls = await listPlaylistsCached();

  const root = document.createElement("div");
  root.appendChild(
    cmBtn(
      "播放",
      () => {
        if (!pathOk) {
          alert("无有效本地文件路径。");
          return;
        }
        appState.playQueue = [item];
        void _deps.playFromQueueIndex(0);
        _deps.renderQueuePanel();
        void saveQueueToSettings();
      },
      !pathOk
    )
  );
  root.appendChild(
    cmBtn(
      "下一首播放",
      () => {
        if (!pathOk) {
          alert("无有效本地文件路径，无法插播。");
          return;
        }
        if (!appState.playQueue.length) {
          appState.playQueue = [item];
          void _deps.playFromQueueIndex(0);
        } else {
          appState.playQueue.splice(appState.playIndex + 1, 0, item);
        }
        _deps.renderQueuePanel();
        void saveQueueToSettings();
      },
      !pathOk
    )
  );
  root.appendChild(cmSep());

  const addRow = document.createElement("div");
  addRow.className = "ctx-menu__row--sub";
  const fly = document.createElement("div");
  fly.className = "ctx-menu__fly";
  fly.textContent = "添加到";
  const sub = document.createElement("div");
  sub.className = "ctx-menu__subpanel";
  sub.appendChild(
    cmBtn("播放队列", () => {
      if (!pathOk) {
        alert("无有效本地文件路径。");
        return;
      }
      appState.playQueue.push(item);
      _deps.renderQueuePanel();
      void saveQueueToSettings();
    })
  );
  sub.appendChild(
    cmBtn("试听列表", () => {
      if (!pathOk) {
        alert("无有效本地文件路径。");
        return;
      }
      appState.playQueue.push(item);
      _deps.renderQueuePanel();
      void saveQueueToSettings();
    })
  );
  sub.appendChild(cmSep());
  sub.appendChild(
    cmBtn("添加到新歌单", async () => {
      const name = window.prompt("歌单名称（将写入 library.db）", "新歌单");
      if (!name || !name.trim()) return;
      const pid = await invoke("create_playlist", { name: name.trim() });
      await invoke("append_playlist_import_items", {
        playlistId: pid,
        items: [
          buildPlaylistImportItem({
            title: r.title,
            artist: r.artist || "",
            album: r.album || "",
          }),
        ],
      });
      await _deps.refreshSidebarPlaylists();
      await _deps.refreshPlaylistSelect();
    })
  );
  sub.appendChild(cmSep());
  let any = false;
  for (const p of pls) {
    const pid = p.id;
    if (pid == null) continue;
    any = true;
    const name = (p.name || "").trim() || `#${pid}`;
    sub.appendChild(
      cmBtn(name, async () => {
        await invoke("append_playlist_import_items", {
          playlistId: pid,
          items: [
            buildPlaylistImportItem({
              title: r.title,
              artist: r.artist || "",
              album: r.album || "",
            }),
          ],
        });
        await _deps.refreshSidebarPlaylists();
      })
    );
  }
  if (!any) sub.appendChild(cmBtn("（暂无歌单，请先新建）", () => {}, true));
  addRow.appendChild(fly);
  addRow.appendChild(sub);
  root.appendChild(addRow);

  root.appendChild(cmBtn("下载", () => {}, true));
  root.appendChild(cmBtn("分享", () => {}, true));
  root.appendChild(cmBtn("查看评论", () => {}, true));
  root.appendChild(cmSep());
  root.appendChild(
    cmBtn("复制歌曲信息", () =>
      copyImportTrackInfoToClipboard({
        title: r.title,
        artist: r.artist,
        album: r.album,
        sourceId: "",
        coverUrl: null,
        localPath: r.file_path,
      })
    )
  );

  mountContextMenuAt(ev.clientX, ev.clientY, root);
}
