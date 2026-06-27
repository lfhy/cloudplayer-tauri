/**
 * 集中式可变状态 — 各模块通过 import { appState } from './state.js' 访问。
 * 与原有顶层 let 变量行为等价，避免循环依赖。
 */
export const appState = {
  // ── 播放 ──
  /** @type {Array<{ source_id?: string, title: string, artist: string, album?: string, cover_url?: string | null, local_path?: string, import_playlist_id?: number | null, import_item_id?: number | null }>} */
  playQueue: [],
  playIndex: 0,
  seekDragging: false,
  playLoadGeneration: 0,
  audioSourceGeneration: 0,
  /** `progress` 上报节流：最多每秒一条 */
  audioProgressLogLastTs: 0,
  playModeIndex: 0,
  qualityPref: "128",

  // ── 歌词 ──
  /** @type {{ t: number, text: string }[]} */
  lrcEntries: [],
  /** @type {Array<{ startMs: number, endMs: number, words: Array<{ startMs: number, endMs: number, text: string }> }> | null} */
  wordLines: null,
  /** @type {string | null} */
  lrcCacheKey: null,
  desktopLyricsOpen: false,
  desktopLyricsWindow: null,
  /** 与 settings 对齐：默认 true（锁定穿透，参考 QQ 音乐） */
  desktopLyricsLocked: true,

  // ── 歌词替换弹窗 ──
  /** @type {any[]} */
  lyricsReplaceCandidates: [],
  lyricsReplaceSelectedIndex: -1,
  /** @type {{ lrcText: string, wordLines?: Array<any> | null } | null} */
  lyricsReplacePreviewPayload: null,
  /** 防止快速切换搜索/行时，旧请求覆盖预览 */
  lyricsReplaceFetchGen: 0,

  // ── 搜索 ──
  /** @type {{ keyword: string, page: number, hasNext: boolean, results: any[], busy: boolean }} */
  searchState: { keyword: "", page: 1, hasNext: false, results: [], busy: false },

  // ── 歌单 ──
  /** @type {number | null} */
  selectedPlaylistId: null,
  selectedPlaylistName: "",
  /** @type {any[]} */
  playlistDetailRows: [],
  /** 导入页已解析条目 @type {{ title: string, artist: string, album: string }[]} */
  importTracks: [],
  /** 分享链接拉取成功后建议的歌单名（网易云 / QQ 返回） */
  importShareSuggestedName: "",

  // ── 收藏 & 下载 ──
  /** @type {Set<string>} */
  likedIds: (() => {
    try {
      const raw = localStorage.getItem("cp_tauri_liked_ids");
      if (!raw) return new Set();
      const a = JSON.parse(raw);
      return new Set(Array.isArray(a) ? a : []);
    } catch {
      return new Set();
    }
  })(),
  /** 已下载曲库 id，用于发现/歌单表格 */
  downloadedSourceIds: new Set(),
  /** 下载队列展示：sourceId -> 最后一帧事件 */
  downloadTasksBySourceId: new Map(),
  /** 「下载歌曲」Tab：`list_downloaded_songs` 结果缓存 @type {any[]} */
  downloadedSongsRows: [],
  /** 本地曲库列表行缓存 @type {any[]} */
  localLibraryRows: [],
  lastLibraryFolder: "",

  // ── 最近播放 ──
  /** @type {Array<{ source_id?: string, title: string, artist: string, album?: string, cover_url?: string | null, local_path?: string }>} */
  sessionRecentPlays: [],

  // ── 设置 ──
  /** 主窗口关闭：`ask` | `quit` | `tray`（与 settings 同步） */
  mainWindowCloseAction: "ask",
  /** 偏好设置表单上次已保存/已加载的基线，用于对比是否有改动 */
  settingsFormBaseline: {
    action: "ask",
    base: "#ffffff",
    highlight: "#ffb7d4",
    fontFamily: "",
    neteaseApiBase: "",
    hotkeysSig: "",
    proxyEnabled: false,
    proxyUrl: "",
    proxyNoProxy: "",
  },
  /** 当前进程内实际生效的代理（启动期由 `get_proxy_status` 拉取一次），用于 UI 提示。 */
  effectiveProxy: {
    applied: false,
    source: "none",
    redactedUrl: "",
    normalizedUrl: "",
    scheme: "",
    host: "",
    port: 0,
    username: "",
    hasPassword: false,
    noProxy: "",
    appliedAtMs: 0,
  },

  // ── 右键菜单 ──
  contextMenuCleanup: null,

  // ── 沉浸播放页 ──
  immersiveLyricsIdx: -1,
  immersiveSeekDragging: false,
};
