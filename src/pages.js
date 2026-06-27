/** 页面级模块：发现搜索、歌单详情、导入歌单、最近播放、本地和下载 */
import { appState } from "./state.js";
import {
  NAV,
  MSG_REQUEST_FAILED,
  MAIN_NAV_PAGE_IDS,
  PLAY_MODES,
} from "./constants.js";
import {
  escapeHtml,
  formatDurationMs,
  formatFileSize,
  setTableMutedMessage,
  warnRequestFailed,
  alertRequestFailed,
  normalizeCloseAction,
  discoverPlaylistTitleCellHtml,
  playlistImportRowToQueueItem,
  listPlaylistsCached,
  buildPlaylistImportItem,
  refreshDownloadedSourceIdSet,
  catalogIdFromRow,
} from "./utils.js";
import {
  openSearchRowContextMenu,
  openSidebarPlaylistContextMenu,
  openPlaylistDetailRowContextMenu,
  openLocalLibraryRowContextMenu,
  openDownloadedSongRowContextMenu,
} from "./context-menu.js";
import { fillSettingsFormFromSettings } from "./settings.js";
import {
  playFromQueueIndex,
  playFromSearchRow,
  playFromPlaylistRow,
  playFromRecentRow,
  renderQueuePanel,
  updatePlayerChrome,
  setPlayerNavEnabled,
  audioEl,
} from "./player.js";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  buildImportCsvBlobUtf8,
  buildImportTxtBlob,
  triggerBlobDownload,
} from "./export-playlist.js";

// ── Sidebar ──

export function renderSidebar() {
  const el = document.getElementById("sidebar");
  el.innerHTML = "";
  const logo = document.createElement("div");
  logo.className = "sidebar-logo";
  const logoImg = document.createElement("img");
  logoImg.className = "sidebar-logo__mark";
  logoImg.src = "/logo.svg";
  logoImg.width = 28;
  logoImg.height = 28;
  logoImg.alt = "";
  logoImg.setAttribute("aria-hidden", "true");
  const logoText = document.createElement("span");
  logoText.className = "sidebar-logo__text";
  logoText.textContent = "CloudPlayer";
  logo.appendChild(logoImg);
  logo.appendChild(logoText);
  el.appendChild(logo);
  for (const item of NAV) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-item";
    btn.dataset.page = item.id;
    btn.textContent = item.label;
    btn.addEventListener("click", () => setPage(item.id));
    el.appendChild(btn);
  }
  const div = document.createElement("div");
  div.className = "sidebar-divider";
  el.appendChild(div);
  const plWrap = document.createElement("div");
  plWrap.className = "sidebar-playlist-section";
  const plHead = document.createElement("div");
  plHead.className = "sidebar-playlist-header";
  const plTitle = document.createElement("div");
  plTitle.className = "sidebar-playlist-title";
  plTitle.textContent = "我的歌单";
  const btnAdd = document.createElement("button");
  btnAdd.type = "button";
  btnAdd.id = "btn-sidebar-new-playlist";
  btnAdd.className = "sidebar-pl-add";
  btnAdd.title = "新建歌单";
  btnAdd.setAttribute("aria-label", "新建歌单");
  btnAdd.textContent = "+";
  btnAdd.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const name = window.prompt("新歌单名称", "新歌单");
    if (name == null || !String(name).trim()) return;
    try {
      await invoke("create_playlist", { name: name.trim() });
      await refreshSidebarPlaylists();
    } catch (err) {
      alertRequestFailed(err, "create_playlist sidebar");
    }
  });
  plHead.appendChild(plTitle);
  plHead.appendChild(btnAdd);
  const ul = document.createElement("ul");
  ul.id = "sidebar-playlist-list";
  ul.className = "sidebar-playlist-list";
  plWrap.appendChild(plHead);
  plWrap.appendChild(ul);
  el.appendChild(plWrap);
  void refreshSidebarPlaylists();
}

function clearSidebarPlaylistHighlight() {
  document.querySelectorAll(".sidebar-pl-item.is-active").forEach((el) => el.classList.remove("is-active"));
}

// ── Playlist Helpers ──

export async function refreshPlaylistSelect() {
  const sel = document.getElementById("import-merge-playlist");
  const mergeBtn = document.getElementById("btn-import-merge");
  if (!sel) {
    await refreshSidebarPlaylists();
    return;
  }
  sel.innerHTML = "";
  const pls = await listPlaylistsCached();
  for (const p of pls) {
    const o = document.createElement("option");
    o.value = String(p.id);
    o.textContent = `${p.name} (id=${p.id})`;
    sel.appendChild(o);
  }
  const hasPl = pls.length > 0;
  sel.disabled = !hasPl;
  if (mergeBtn) mergeBtn.disabled = !hasPl || appState.importTracks.length === 0;
  await refreshSidebarPlaylists();
}

export async function refreshSidebarPlaylists() {
  const ul = document.getElementById("sidebar-playlist-list");
  if (!ul) return;
  ul.innerHTML = "";
  let pls = [];
  try {
    pls = await invoke("list_playlists");
  } catch (e) {
    warnRequestFailed(e, "list_playlists sidebar");
    const li = document.createElement("li");
    li.className = "sidebar-pl-empty muted";
    li.textContent = MSG_REQUEST_FAILED;
    ul.appendChild(li);
    return;
  }
  if (!pls.length) {
    const li = document.createElement("li");
    li.className = "sidebar-pl-empty muted";
    li.textContent = "暂无歌单 · 与 Py 版共用 ~/.cloudplayer/library.db · 在此页「保存为新歌单」即可出现";
    ul.appendChild(li);
    return;
  }
  for (const p of pls) {
    const li = document.createElement("li");
    li.className = "sidebar-pl-item";
    if (appState.selectedPlaylistId === p.id) li.classList.add("is-active");
    if (p.is_favorites) {
      const heart = document.createElement("span");
      heart.textContent = "♥ ";
      heart.style.color = "var(--accent)";
      li.appendChild(heart);
    }
    li.appendChild(document.createTextNode(p.name?.trim() || `歌单 ${p.id}`));
    li.title = `id=${p.id} · 查看导入曲目`;
    li.addEventListener("click", () => {
      appState.selectedPlaylistId = p.id;
      appState.selectedPlaylistName = p.name || "";
      ul.querySelectorAll(".sidebar-pl-item").forEach((x) => x.classList.remove("is-active"));
      li.classList.add("is-active");
      setPage("playlist");
    });
    li.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      void openSidebarPlaylistContextMenu(ev, p);
    });
    ul.appendChild(li);
  }
}

// ── Page Routing ──

export function setPage(pageId) {
  if (pageId !== "playlist") {
    clearSidebarPlaylistHighlight();
    if (MAIN_NAV_PAGE_IDS.has(pageId)) {
      appState.selectedPlaylistId = null;
      appState.selectedPlaylistName = "";
    }
  }
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.page === pageId);
  });
  document.querySelectorAll(".page").forEach((p) => {
    p.classList.toggle("page-active", p.dataset.page === pageId);
  });
  if (pageId === "recent") {
    renderRecentPlaysTable();
  }
  if (pageId === "download") {
    const activeTab = document.querySelector("[data-download-tab].page-tab--active");
    const tid = activeTab?.getAttribute("data-download-tab") || "local";
    if (tid === "local") void refreshLocalLibraryTable();
    if (tid === "saved") void refreshDownloadedSongsTable();
    if (tid === "active") renderDownloadActiveTable();
  }
  if (pageId === "import") {
    void refreshPlaylistSelect();
  }
  if (pageId === "settings") {
    void (async () => {
      try {
        const s = await invoke("get_settings");
        appState.mainWindowCloseAction = normalizeCloseAction(s?.main_window_close_action ?? s?.mainWindowCloseAction);
        fillSettingsFormFromSettings(s);
      } catch (e) {
        console.warn("get_settings", e);
      }
    })();
  }
  if (pageId === "playlist") {
    if (appState.selectedPlaylistId == null) {
      appState.selectedPlaylistName = "";
      const titleEl = document.getElementById("playlist-page-title");
      if (titleEl) titleEl.textContent = "歌单";
      appState.playlistDetailRows = [];
      renderPlaylistDetailTable();
    } else {
      void loadPlaylistDetail(appState.selectedPlaylistId, appState.selectedPlaylistName);
    }
  }
}

// ── Discover / Search ──

export function updateSearchToolbar() {
  const n = appState.searchState.results.length;
  const info = document.getElementById("search-page-info");
  const prev = document.getElementById("btn-prev-page");
  const next = document.getElementById("btn-next-page");
  const playAll = document.getElementById("btn-play-all");
  if (info) {
    info.textContent =
      !appState.searchState.keyword.trim()
        ? ""
        : `共 ${n} 条 · 第 ${appState.searchState.page} 页${appState.searchState.hasNext ? " · 有下一页" : " · 已到末页"}`;
  }
  if (prev) prev.disabled = appState.searchState.page <= 1 || appState.searchState.busy;
  if (next) next.disabled = !appState.searchState.hasNext || appState.searchState.busy;
  if (playAll) playAll.disabled = !n || appState.searchState.busy;
}

export function renderSearchTable() {
  const tbody = document.querySelector("#search-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const rows = appState.searchState.results;
  if (!rows.length) {
    setTableMutedMessage(tbody, 5, "无结果（或站点 HTML 已变化）。");
    return;
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tr = document.createElement("tr");
    const coverHtml = r.cover_url
      ? `<img class="row-cover" src="${escapeHtml(r.cover_url)}" alt="" width="40" height="40" loading="lazy" />`
      : `<div class="row-cover-ph" aria-hidden="true"></div>`;
    const titleBlock = discoverPlaylistTitleCellHtml(r);
    tr.innerHTML = `
      <td class="col-idx">${i + 1}</td>
      <td class="col-cover">${coverHtml}</td>
      <td>${titleBlock}</td>
      <td class="muted">${escapeHtml(r.album || "—")}</td>
      <td class="muted col-dur">—</td>
    `;
    tr.style.cursor = "pointer";
    tr.title = "双击试听";
    tr.addEventListener("dblclick", () => playFromSearchRow(i));
    tr.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      void openSearchRowContextMenu(ev, i);
    });
    tbody.appendChild(tr);
  }
}

export async function fetchSearchPage() {
  const kw = appState.searchState.keyword.trim();
  if (!kw) return;
  appState.searchState.busy = true;
  updateSearchToolbar();
  const tbody = document.querySelector("#search-table tbody");
  setTableMutedMessage(tbody, 5, "搜索中…");
  try {
    const res = await invoke("search_songs", { keyword: kw, page: appState.searchState.page });
    appState.searchState.results = res.results || [];
    appState.searchState.hasNext = !!res.has_next;
    await refreshDownloadedSourceIdSet();
    renderSearchTable();
  } catch (e) {
    warnRequestFailed(e, "search_songs");
    setTableMutedMessage(tbody, 5, MSG_REQUEST_FAILED);
    appState.searchState.results = [];
    appState.searchState.hasNext = false;
  } finally {
    appState.searchState.busy = false;
    updateSearchToolbar();
  }
}

export function wireDiscoverToolbar() {
  document.getElementById("btn-prev-page")?.addEventListener("click", () => {
    if (appState.searchState.page <= 1 || appState.searchState.busy) return;
    if (!appState.searchState.keyword.trim()) return;
    appState.searchState.page -= 1;
    fetchSearchPage();
  });
  document.getElementById("btn-next-page")?.addEventListener("click", () => {
    if (appState.searchState.busy || !appState.searchState.hasNext) return;
    if (!appState.searchState.keyword.trim()) return;
    appState.searchState.page += 1;
    fetchSearchPage();
  });
  document.getElementById("btn-play-all")?.addEventListener("click", () => {
    if (!appState.searchState.results.length) return;
    appState.playQueue = appState.searchState.results.map((r) => ({
      source_id: r.source_id,
      title: r.title,
      artist: r.artist || "",
      album: r.album || "",
      cover_url: r.cover_url || null,
    }));
    playFromQueueIndex(0);
  });
}

// ── Global Search ──

export function submitGlobalSearch() {
  const gs = document.getElementById("global-search");
  if (!gs) return;
  const v = gs.value.trim();
  setPage("discover");
  if (!v) {
    appState.searchState.keyword = "";
    appState.searchState.page = 1;
    appState.searchState.results = [];
    appState.searchState.hasNext = false;
    const tbody = document.querySelector("#search-table tbody");
    if (tbody) tbody.innerHTML = "";
    updateSearchToolbar();
    return;
  }
  appState.searchState.keyword = v;
  appState.searchState.page = 1;
  fetchSearchPage();
}

export function wireGlobalSearch() {
  const gs = document.getElementById("global-search");
  if (!gs) return;
  gs.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submitGlobalSearch();
  });
  document.getElementById("btn-global-search")?.addEventListener("click", () => submitGlobalSearch());
}

// ── Playlist Detail ──

export async function loadPlaylistDetail(id, name) {
  appState.selectedPlaylistId = id;
  appState.selectedPlaylistName = name || "";
  const titleEl = document.getElementById("playlist-page-title");
  if (titleEl) titleEl.textContent = name || "歌单";
  try {
    const rows = await invoke("list_playlist_import_items", { playlistId: id });
    appState.playlistDetailRows = rows || [];
  } catch (e) {
    appState.playlistDetailRows = [];
    alertRequestFailed(e, "list_playlist_import_items");
  }
  await refreshDownloadedSourceIdSet();
  setPlaylistBatchView(false);
  renderPlaylistDetailTable();
}

export function renderPlaylistDetailTable() {
  const tbody = document.querySelector("#playlist-detail-table tbody");
  const btnAll = document.getElementById("btn-playlist-play-all");
  const btnBatch = document.getElementById("btn-playlist-batch-open");
  const coverEl = document.getElementById("playlist-hero-cover");
  const countEl = document.getElementById("playlist-track-count");
  const hintEl = document.getElementById("playlist-page-hint");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (btnAll) btnAll.disabled = appState.playlistDetailRows.length === 0;
  if (btnBatch) btnBatch.disabled = appState.playlistDetailRows.length === 0;
  if (countEl) countEl.textContent = `共 ${appState.playlistDetailRows.length} 首导入曲目`;
  if (hintEl) hintEl.textContent = `CloudPlayer · ${appState.selectedPlaylistName || "导入歌单"}`;
  const heroCover =
    appState.playlistDetailRows.find((r) => (r.cover_url || "").trim())?.cover_url ||
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Crect fill='%23d1d5db' width='120' height='120' rx='12'/%3E%3C/svg%3E";
  if (coverEl) coverEl.src = heroCover;

  if (!appState.playlistDetailRows.length) {
    setTableMutedMessage(tbody, 5, "暂无导入曲目，或请从左侧选择其它歌单。");
    return;
  }

  appState.playlistDetailRows.forEach((r, i) => {
    const tr = document.createElement("tr");
    const sid = catalogIdFromRow(r);
    const ok = !!sid;
    const cover = (r.cover_url || "").trim();
    const liked = ok && appState.likedIds.has(sid);
    const dur = formatDurationMs(r.duration_ms);
    const titleHtml = discoverPlaylistTitleCellHtml(r);
    const coverHtml = cover
      ? `<img class="row-cover" src="${escapeHtml(cover)}" alt="" width="40" height="40" loading="lazy" />`
      : `<div class="row-cover-ph" aria-hidden="true"></div>`;
    tr.innerHTML = `
      <td class="col-cover">${coverHtml}</td>
      <td>${titleHtml}</td>
      <td class="muted">${escapeHtml(r.album || "—")}</td>
      <td class="col-like muted" data-idx="${i}">${liked ? "♥" : "♡"}</td>
      <td class="muted col-dur">${dur}</td>`;
    tr.style.cursor = "pointer";
    tr.title = ok
      ? "双击从该曲起播整单（缺 id 的条目会先尝试匹配曲库）"
      : "无曲库 id：双击将尝试匹配并播放";
    tr.addEventListener("dblclick", () => playFromPlaylistRow(i));
    tr.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      void openPlaylistDetailRowContextMenu(ev, i);
    });
    const likeTd = tr.querySelector(".col-like");
    if (likeTd) {
      likeTd.style.cursor = "pointer";
      likeTd.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!ok) { alert("无曲库 id，无法标记喜欢。"); return; }
        const wasLiked = appState.likedIds.has(sid);
        if (wasLiked) {
          appState.likedIds.delete(sid);
          try { await invoke("remove_from_favorites", { sourceId: sid }); } catch (_) {}
        } else {
          appState.likedIds.add(sid);
          try {
            await invoke("add_to_favorites", {
              title: r.title || "",
              artist: r.artist || "",
              album: r.album || "",
              sourceId: sid,
              coverUrl: r.cover_url || "",
              playUrl: r.play_url || "",
              durationMs: r.duration_ms || 0,
            });
          } catch (_) {}
        }
        const { saveLikedSet } = await import("./utils.js");
        saveLikedSet(appState.likedIds);
        likeTd.textContent = wasLiked ? "♡" : "♥";
        // refreshFavButton is in player.js — import dynamically to avoid circular
        const { refreshFavButton } = await import("./player.js");
        refreshFavButton();
        void refreshSidebarPlaylists();
      });
    }
    tbody.appendChild(tr);
  });
}

function setPlaylistBatchView(on) {
  const normal = document.getElementById("playlist-view-normal");
  const batch = document.getElementById("playlist-view-batch");
  if (normal) normal.hidden = !!on;
  if (batch) batch.hidden = !on;
}

async function getEffectiveDownloadRootPath() {
  try {
    const s = await invoke("get_settings");
    const custom = ((s?.download_folder || s?.downloadFolder) || "").trim();
    if (custom) return custom;
    return await invoke("get_default_download_dir");
  } catch {
    return "";
  }
}

async function downloadFolderDialogDefaultPath() {
  const p = await getEffectiveDownloadRootPath();
  const t = p && String(p).trim();
  return t || undefined;
}

async function refreshPlaylistBatchFolderLabel() {
  const el = document.getElementById("playlist-batch-folder-display");
  if (!el) return;
  try {
    const p = await getEffectiveDownloadRootPath();
    el.textContent = p && p.trim() ? p : "—";
  } catch {
    el.textContent = "—";
  }
}

function syncPlaylistBatchSummary() {
  const sum = document.getElementById("playlist-batch-summary");
  const total = appState.playlistDetailRows.length;
  const n = document.querySelectorAll("#playlist-batch-table .batch-row-check:checked").length;
  if (sum) {
    sum.textContent = total
      ? `已选 ${n} / ${total} 首 · 无曲库 id 的将尝试自动匹配后加入队列`
      : "";
  }
  const checkAll = document.getElementById("playlist-batch-check-all");
  if (checkAll && total) {
    const allOn = n === total;
    const allOff = n === 0;
    checkAll.checked = allOn;
    checkAll.indeterminate = !allOn && !allOff;
  }
}

export function renderPlaylistBatchTable() {
  const tbody = document.querySelector("#playlist-batch-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!appState.playlistDetailRows.length) {
    setTableMutedMessage(tbody, 5, "暂无曲目");
    syncPlaylistBatchSummary();
    return;
  }
  appState.playlistDetailRows.forEach((r, i) => {
    const tr = document.createElement("tr");
    const sid = catalogIdFromRow(r);
    const dur = formatDurationMs(r.duration_ms);
    const cover = (r.cover_url || "").trim();
    const coverHtml = cover
      ? `<img class="row-cover" src="${escapeHtml(cover)}" alt="" width="40" height="40" loading="lazy" />`
      : `<div class="row-cover-ph" aria-hidden="true"></div>`;
    const titleHtml = discoverPlaylistTitleCellHtml(r);
    const tagNoId = sid ? "" : ` <span class="tag-no-id">无ID</span>`;
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="batch-row-check" data-row-index="${i}" checked /></td>
      <td class="col-cover">${coverHtml}</td>
      <td>${titleHtml}${tagNoId}</td>
      <td class="muted">${escapeHtml(r.album || "—")}</td>
      <td class="muted col-dur">${dur}</td>`;
    tbody.appendChild(tr);
  });
  syncPlaylistBatchSummary();
}

function getBatchDownloadQuality() {
  const r = document.querySelector('input[name="batch-dl-quality"]:checked');
  return r ? r.value : "128";
}

async function runPlaylistBatchDownload() {
  const boxes = [...document.querySelectorAll("#playlist-batch-table .batch-row-check:checked")];
  if (!boxes.length) {
    alert("请至少选择一首歌曲。");
    return;
  }
  const q = getBatchDownloadQuality();
  let ok = 0;
  let skip = 0;
  const indices = boxes
    .map((b) => Number(b.getAttribute("data-row-index")))
    .filter((n) => !Number.isNaN(n));
  const pid = appState.selectedPlaylistId;
  for (const i of indices) {
    const r = appState.playlistDetailRows[i];
    if (!r) continue;
    let sid = catalogIdFromRow(r);
    if (!sid && pid != null && r.id) {
      try {
        const filled = await invoke("try_fill_playlist_item_source_id", {
          playlistId: pid,
          itemId: r.id,
        });
        if (filled && String(filled).trim()) {
          sid = String(filled).trim();
          r.catalog_id = sid;
        }
      } catch (e) {
        console.warn("batch try_fill", e);
      }
    }
    if (!sid) { skip++; continue; }
    try {
      await invoke("enqueue_download", {
        job: { source_id: sid, title: r.title || "", artist: r.artist || "", quality: q },
      });
      ok++;
    } catch (e) {
      console.warn("enqueue_download", e);
      skip++;
    }
  }
  renderPlaylistDetailTable();
  renderPlaylistBatchTable();
  alert(`已加入下载队列 ${ok} 首${skip ? `，跳过 ${skip} 首（无曲库 id 或失败）` : ""}。`);
}

function wirePlaylistBatchPage() {
  document.getElementById("btn-playlist-batch-open")?.addEventListener("click", async () => {
    if (!appState.playlistDetailRows.length) return;
    setPlaylistBatchView(true);
    await refreshPlaylistBatchFolderLabel();
    renderPlaylistBatchTable();
  });
  document.getElementById("btn-playlist-batch-exit")?.addEventListener("click", () => {
    setPlaylistBatchView(false);
  });
  document.getElementById("playlist-batch-check-all")?.addEventListener("change", (ev) => {
    const on = ev.target.checked;
    document.querySelectorAll("#playlist-batch-table .batch-row-check").forEach((c) => { c.checked = on; });
    syncPlaylistBatchSummary();
  });
  document.getElementById("playlist-batch-table")?.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t && t.classList && t.classList.contains("batch-row-check")) {
      syncPlaylistBatchSummary();
    }
  });
  document.getElementById("btn-batch-pick-folder")?.addEventListener("click", async () => {
    try {
      const def = await downloadFolderDialogDefaultPath();
      const picked = await open({ directory: true, multiple: false, defaultPath: def, title: "选择下载保存目录" });
      if (picked == null) return;
      const folder = Array.isArray(picked) ? picked[0] : picked;
      if (!folder || !String(folder).trim()) return;
      await invoke("save_settings", { patch: { download_folder: String(folder).trim() } });
      await refreshPlaylistBatchFolderLabel();
      await refreshDownloadFolderHint();
    } catch (e) {
      alertRequestFailed(e, "pick download folder");
    }
  });
  document.getElementById("btn-batch-download-run")?.addEventListener("click", async () => {
    await runPlaylistBatchDownload();
  });
}

export function wirePlaylistPage() {
  document.getElementById("btn-playlist-back")?.addEventListener("click", () => {
    setPlaylistBatchView(false);
    setPage("discover");
  });
  document.getElementById("btn-playlist-play-all")?.addEventListener("click", () => {
    if (!appState.playlistDetailRows.length) {
      alert("当前歌单没有导入曲目。");
      return;
    }
    appState.playQueue = appState.playlistDetailRows.map((r) => playlistImportRowToQueueItem(r));
    playFromQueueIndex(0);
    renderQueuePanel();
  });
  wirePlaylistBatchPage();
}

// ── Import Page ──

export function renderImportTable() {
  const tbody = document.querySelector("#import-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  appState.importTracks.forEach((t, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-idx">${i + 1}</td>
      <td>${escapeHtml(t.title)}</td>
      <td>${escapeHtml(t.artist)}</td>
      <td class="muted">${escapeHtml(t.album || "—")}</td>`;
    tbody.appendChild(tr);
  });
  const has = appState.importTracks.length > 0;
  document.getElementById("btn-import-export-txt")?.toggleAttribute("disabled", !has);
  document.getElementById("btn-import-export-csv")?.toggleAttribute("disabled", !has);
  document.getElementById("btn-import-save-new")?.toggleAttribute("disabled", !has);
  const mergeBtn = document.getElementById("btn-import-merge");
  const sel = document.getElementById("import-merge-playlist");
  const nOpt = sel && sel.options ? sel.options.length : 0;
  if (mergeBtn) mergeBtn.disabled = !has || !nOpt;
}

export function wireImportPage() {
  document.getElementById("btn-import-parse")?.addEventListener("click", async () => {
    const raw = document.getElementById("import-text")?.value?.trim() ?? "";
    if (!raw) return;
    const fmt = document.getElementById("import-fmt")?.value ?? "auto";
    try {
      const rows = await invoke("parse_import_text", { text: raw, fmt });
      appState.importTracks = rows || [];
      appState.importShareSuggestedName = "";
      const shareSt = document.getElementById("import-share-status");
      if (shareSt) shareSt.textContent = "";
      renderImportTable();
      await refreshPlaylistSelect();
      alert(`共解析 ${appState.importTracks.length} 条。`);
    } catch (e) {
      alertRequestFailed(e, "parse_import_text");
    }
  });
  document.getElementById("btn-import-export-txt")?.addEventListener("click", () => {
    if (!appState.importTracks.length) return;
    triggerBlobDownload("playlist.txt", buildImportTxtBlob(appState.importTracks));
  });
  document.getElementById("btn-import-export-csv")?.addEventListener("click", () => {
    if (!appState.importTracks.length) return;
    triggerBlobDownload("playlist.csv", buildImportCsvBlobUtf8(appState.importTracks));
  });
  document.getElementById("btn-import-save-new")?.addEventListener("click", async () => {
    if (!appState.importTracks.length) return;
    const defaultName = (appState.importShareSuggestedName && appState.importShareSuggestedName.trim()) || "导入歌单";
    const name = window.prompt("歌单名称（将写入 library.db）", defaultName);
    if (!name || !name.trim()) return;
    try {
      const id = await invoke("create_playlist", { name: name.trim() });
      await invoke("replace_playlist_import_items", {
        playlistId: id,
        items: appState.importTracks.map((t) => ({ title: t.title, artist: t.artist, album: t.album || "" })),
      });
      alert(`已创建歌单「${name.trim()}」，共 ${appState.importTracks.length} 首导入条目。`);
      await refreshPlaylistSelect();
    } catch (e) {
      alertRequestFailed(e, "import save playlist");
    }
  });
  document.getElementById("btn-import-share")?.addEventListener("click", async () => {
    const input = document.getElementById("import-share-url");
    const url = input?.value?.trim() ?? "";
    const st = document.getElementById("import-share-status");
    const btn = document.getElementById("btn-import-share");
    if (!url) { alert("请先粘贴分享链接。"); return; }
    if (st) st.textContent = "正在拉取歌单，请稍候…";
    if (btn) btn.disabled = true;
    try {
      const res = await invoke("fetch_share_playlist", { url });
      appState.importTracks = res.tracks || [];
      appState.importShareSuggestedName = res.playlist_name || res.playlistName || "";
      renderImportTable();
      await refreshPlaylistSelect();
      const n = appState.importTracks.length;
      const pn = appState.importShareSuggestedName || "—";
      if (st) st.textContent = `已拉取 ${n} 首 · ${pn}`;
      alert(`已拉取「${pn}」共 ${n} 首。可导出、保存为新歌单或合并到已有歌单。`);
    } catch (e) {
      if (st) st.textContent = "";
      alertRequestFailed(e, "fetch_share_playlist");
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  document.getElementById("import-share-url")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("btn-import-share")?.click();
    }
  });
  document.getElementById("btn-import-merge")?.addEventListener("click", async () => {
    if (!appState.importTracks.length) return;
    const sel = document.getElementById("import-merge-playlist");
    const pid = sel && sel.value ? Number(sel.value) : NaN;
    if (!Number.isFinite(pid)) {
      alert("请先用「保存为新歌单」创建歌单，或检查合并目标下拉框。");
      return;
    }
    try {
      await invoke("append_playlist_import_items", {
        playlistId: pid,
        items: appState.importTracks.map((t) => ({ title: t.title, artist: t.artist, album: t.album || "" })),
      });
      alert(`已向所选歌单追加 ${appState.importTracks.length} 首。`);
      await refreshSidebarPlaylists();
      if (appState.selectedPlaylistId === pid) {
        void loadPlaylistDetail(pid, appState.selectedPlaylistName);
      }
    } catch (e) {
      alertRequestFailed(e, "append_playlist_import_items");
    }
  });
}

// ── Recent Plays ──

export async function loadRecentPlaysFromDb() {
  try {
    const rows = await invoke("list_recent_plays");
    if (!Array.isArray(rows) || !rows.length) return;
    appState.sessionRecentPlays = rows.map((r) => {
      const fp = r.filePath || r.file_path;
      if ((r.kind || "") === "local" && fp) {
        return { title: r.title, artist: r.artist || "", local_path: fp };
      }
      return {
        source_id: catalogIdFromRow(r),
        title: r.title,
        artist: r.artist || "",
        cover_url: r.coverUrl ?? r.cover_url ?? null,
      };
    });
    if (document.querySelector('.page[data-page="recent"]')?.classList.contains("page-active")) {
      renderRecentPlaysTable();
    }
  } catch (e) {
    console.warn("list_recent_plays", e);
  }
}

export function renderRecentPlaysTable() {
  const tbody = document.querySelector("#recent-plays-table tbody");
  if (!tbody) return;
  if (!appState.sessionRecentPlays.length) {
    setTableMutedMessage(tbody, 4, "暂无记录。在「发现」或「本地」播放曲目后将显示在此处。");
    return;
  }
  tbody.innerHTML = "";
  appState.sessionRecentPlays.forEach((snap, i) => {
    const tr = document.createElement("tr");
    const title = snap.title || "—";
    const artist = snap.artist || "—";
    const src = snap.local_path ? "本地" : "在线";
    tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(title)}</td><td>${escapeHtml(artist)}</td><td>${escapeHtml(src)}</td>`;
    tr.addEventListener("dblclick", () => playFromRecentRow(i));
    tbody.appendChild(tr);
  });
}

// ── Download Page ──

export function renderDownloadActiveTable() {
  const tbody = document.querySelector("#download-active-table tbody");
  if (!tbody) return;
  const list = [...appState.downloadTasksBySourceId.values()].filter((t) => {
    const st = t.status || "";
    return st === "queued" || st === "downloading" || st === "failed";
  });
  if (!list.length) {
    setTableMutedMessage(tbody, 4, "当前没有进行中的下载。在「发现」或歌单右键选择「下载」。");
    return;
  }
  tbody.innerHTML = "";
  for (const t of list) {
    const tr = document.createElement("tr");
    const pct = Math.round((t.progress ?? 0) * 100);
    const tit = t.title || "";
    const art = t.artist || "";
    const qu = t.quality || "";
    const st = t.status || "";
    const rawMsg = (t.message && String(t.message)) || "";
    if (st === "failed" && rawMsg) {
      const sid = t.sourceId ?? t.source_id;
      console.error("[download] failed", { sourceId: sid, title: tit, message: rawMsg });
    }
    const msg = st === "failed" && rawMsg ? `${MSG_REQUEST_FAILED}（见日志文件）` : rawMsg;
    tr.title = st === "failed" && rawMsg ? rawMsg : "";
    tr.innerHTML = `<td>${escapeHtml(st)}</td><td>${escapeHtml(`${tit} — ${art}`)}</td><td>${escapeHtml(qu)}</td><td>${escapeHtml(String(pct))}%${msg ? ` · ${escapeHtml(msg)}` : ""}</td>`;
    tbody.appendChild(tr);
  }
}

export async function refreshDownloadedSongsTable() {
  const tbody = document.querySelector("#download-completed-table tbody");
  if (!tbody) return;
  setTableMutedMessage(tbody, 4, "加载中…");
  try {
    const rows = await invoke("list_downloaded_songs");
    appState.downloadedSongsRows = Array.isArray(rows) ? rows : [];
    appState.downloadedSourceIds = new Set(
      appState.downloadedSongsRows
        .map((r) => catalogIdFromRow(r))
        .filter(Boolean),
    );
    tbody.innerHTML = "";
    if (!appState.downloadedSongsRows.length) {
      setTableMutedMessage(tbody, 4, "暂无记录。成功下载的歌曲会出现在这里（重启后仍会保留）。");
      return;
    }
    appState.downloadedSongsRows.forEach((r, i) => {
      const tr = document.createElement("tr");
      const titleHtml = r.artist
        ? `<span class="t-title">${escapeHtml(r.title || "—")}</span><span class="t-art">${escapeHtml(r.artist)}</span>`
        : `<span class="t-title">${escapeHtml(r.title || "—")}</span>`;
      const dur = formatDurationMs(r.durationMs ?? r.duration_ms);
      const sz = formatFileSize(r.fileSize ?? r.file_size);
      const fp = String(r.filePath || r.file_path || "").trim();
      tr.title = fp || "";
      tr.style.cursor = "pointer";
      tr.innerHTML = `<td>${titleHtml}</td><td class="muted">${escapeHtml(r.album || "—")}</td><td class="muted col-dur">${escapeHtml(dur)}</td><td class="muted col-size">${escapeHtml(sz)}</td>`;
      tr.addEventListener("dblclick", () => {
        if (!fp) return;
        appState.playQueue = [{ title: r.title, artist: r.artist || "", local_path: fp, cover_url: null }];
        void playFromQueueIndex(0);
        renderQueuePanel();
      });
      tr.addEventListener("contextmenu", (ev) => void openDownloadedSongRowContextMenu(ev, i));
      tbody.appendChild(tr);
    });
  } catch (e) {
    warnRequestFailed(e, "list_downloaded_songs");
    setTableMutedMessage(tbody, 4, MSG_REQUEST_FAILED);
    appState.downloadedSongsRows = [];
    appState.downloadedSourceIds = new Set();
  }
}

export function renderDownloadTables() {
  renderDownloadActiveTable();
  void refreshDownloadedSongsTable();
}

export async function refreshDownloadFolderHint() {
  const el = document.getElementById("download-folder-hint");
  if (!el) return;
  try {
    const s = await invoke("get_settings");
    const custom = ((s?.download_folder || s?.downloadFolder) || "").trim();
    if (custom) {
      el.textContent = `当前：${custom}`;
      return;
    }
    const def = await invoke("get_default_download_dir");
    el.textContent = `默认：${def}`;
  } catch {
    el.textContent = "默认：用户音乐/CloudPlayer";
  }
}

export async function refreshLocalLibraryTable() {
  const tbody = document.querySelector("#local-library-table tbody");
  if (!tbody) return;
  setTableMutedMessage(tbody, 4, "加载中…");
  try {
    const rows = await invoke("list_local_songs");
    appState.localLibraryRows = Array.isArray(rows) ? rows : [];
    tbody.innerHTML = "";
    if (!appState.localLibraryRows.length) {
      setTableMutedMessage(tbody, 4, "暂无本地曲库。请点击「选择文件夹并扫描」。");
      return;
    }
    appState.localLibraryRows.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(r.title || "")}</td><td>${escapeHtml(r.artist || "")}</td><td class="col-path" title="${escapeHtml(r.file_path || "")}">${escapeHtml(r.file_path || "")}</td>`;
      tr.addEventListener("dblclick", () => {
        appState.playQueue = [{ title: r.title, artist: r.artist || "", local_path: r.file_path, cover_url: null }];
        void playFromQueueIndex(0);
        renderQueuePanel();
      });
      tr.addEventListener("contextmenu", (ev) => void openLocalLibraryRowContextMenu(ev, i));
      tbody.appendChild(tr);
    });
  } catch (e) {
    warnRequestFailed(e, "list_local_songs");
    setTableMutedMessage(tbody, 4, MSG_REQUEST_FAILED);
  }
}

export function wireDownloadPage() {
  document.querySelectorAll("[data-download-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-download-tab");
      document.querySelectorAll("[data-download-tab]").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("page-tab--active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      document.querySelectorAll("[data-download-panel]").forEach((p) => {
        const show = p.getAttribute("data-download-panel") === id;
        p.classList.toggle("page-tab-panel--active", show);
      });
      if (id === "local") void refreshLocalLibraryTable();
      if (id === "saved") void refreshDownloadedSongsTable();
      if (id === "active") renderDownloadActiveTable();
    });
  });
  document.getElementById("btn-pick-download-folder")?.addEventListener("click", async () => {
    const statusEl = document.getElementById("download-folder-hint");
    try {
      const def = await downloadFolderDialogDefaultPath();
      const picked = await open({ directory: true, multiple: false, defaultPath: def, title: "选择下载保存目录" });
      if (picked == null) return;
      const folder = Array.isArray(picked) ? picked[0] : picked;
      if (!folder || !String(folder).trim()) return;
      const path = String(folder).trim();
      await invoke("save_settings", { patch: { download_folder: path } });
      await refreshDownloadFolderHint();
    } catch (e) {
      if (statusEl) statusEl.textContent = MSG_REQUEST_FAILED;
      alertRequestFailed(e, "pick download folder");
    }
  });
  document.getElementById("btn-scan-library-folder")?.addEventListener("click", async () => {
    const statusEl = document.getElementById("local-library-status");
    try {
      const s = await invoke("get_settings");
      const def = ((s && s.last_library_folder) || appState.lastLibraryFolder || "").trim();
      const picked = await open({ directory: true, multiple: false, defaultPath: def || undefined, title: "选择音乐文件夹" });
      if (picked == null) return;
      const folder = Array.isArray(picked) ? picked[0] : picked;
      if (!folder || !String(folder).trim()) return;
      const path = String(folder).trim();
      appState.lastLibraryFolder = path;
      await invoke("save_settings", { patch: { last_library_folder: path } }).catch(() => {});
      if (statusEl) statusEl.textContent = "正在扫描…";
      const res = await invoke("scan_music_folder", { path });
      if (statusEl) {
        statusEl.textContent = `已扫描 ${res.audio_files_seen} 个音频文件，写入/更新 ${res.rows_written} 条。`;
      }
      await refreshLocalLibraryTable();
    } catch (e) {
      if (statusEl) statusEl.textContent = MSG_REQUEST_FAILED;
      alertRequestFailed(e, "scan_music_folder");
    }
  });
}

// ── Settings Load ──

export async function loadSettings() {
  try {
    const s = await invoke("get_settings");
    appState.mainWindowCloseAction = normalizeCloseAction(s?.main_window_close_action ?? s?.mainWindowCloseAction);
    fillSettingsFormFromSettings(s);
    const vol = document.getElementById("volume");
    if (s && typeof s.volume === "number") {
      vol.value = String(Math.round(s.volume * 100));
    }
    const a = audioEl();
    if (a && s && typeof s.volume === "number") {
      a.volume = s.volume;
    }
    if (s && typeof s.desktop_lyrics_locked === "boolean") {
      appState.desktopLyricsLocked = s.desktop_lyrics_locked;
    }
    if (s && typeof s.last_library_folder === "string") {
      appState.lastLibraryFolder = s.last_library_folder.trim();
    }
    await refreshDownloadFolderHint();
    // Restore persisted play queue (do NOT auto-play)
    if (s?.last_play_queue_json && typeof s.last_play_queue_json === "string" && s.last_play_queue_json.trim()) {
      try {
        const parsed = JSON.parse(s.last_play_queue_json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          appState.playQueue = parsed;
          const idx = Number(s.last_play_index) || 0;
          appState.playIndex = Math.max(0, Math.min(idx, parsed.length - 1));
          renderQueuePanel();
          // Update player chrome to show the current track
          const cur = parsed[appState.playIndex];
          if (cur) {
            updatePlayerChrome({ title: cur.title, sub: cur.artist || "", coverUrl: cur.cover_url || null });
          }
          // Enable play button so user can start playback
          const playBtn = document.getElementById("btn-player-play");
          if (playBtn) playBtn.disabled = false;
        }
      } catch (e) {
        console.warn("restore play queue", e);
      }
    }
    // Restore persisted play mode
    if (typeof s?.last_play_mode_index === "number" && s.last_play_mode_index >= 0 && s.last_play_mode_index < PLAY_MODES.length) {
      appState.playModeIndex = Math.floor(s.last_play_mode_index);
      const m = PLAY_MODES[appState.playModeIndex];
      const modeBtn = document.getElementById("btn-play-mode");
      if (modeBtn && m) { modeBtn.textContent = m.label; modeBtn.title = m.tip; }
      const immBtn = document.getElementById("immersive-mode");
      if (immBtn && m) { immBtn.textContent = m.label; immBtn.title = m.tip; }
    }
    setPlayerNavEnabled();
    const { refreshLyricsLockMenuLabel, scheduleDesktopLyricsStyleSync, openDesktopLyricsFromSettingsIfNeeded } = await import("./lyrics.js");
    refreshLyricsLockMenuLabel();
    if (appState.desktopLyricsOpen) {
      scheduleDesktopLyricsStyleSync();
    }
    if (s?.desktop_lyrics_visible) {
      queueMicrotask(() => {
        void openDesktopLyricsFromSettingsIfNeeded(s);
      });
    }
  } catch (e) {
    console.warn("get_settings", e);
  }
  try {
    const st = await invoke("db_status");
    console.info(st);
  } catch (e) {
    console.warn("db_status", e);
  }
}
