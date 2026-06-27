# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm run tauri dev          # Full dev: Vite frontend + Rust backend with hot reload
npm run dev                # Frontend only (Vite on localhost:1420)
npm run build              # Frontend production build → dist/
npm run tauri build        # Production bundle (NSIS installer on Windows)

# Android
npm run android:dev        # tauri android dev
npm run android:build      # tauri android build -t aarch64
npm run android:build:apk  # ARM64 APK
npm run android:build:all-abis  # All Android ABIs
```

**Version bumping**: must be synced across `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.

## Architecture

**Tauri 2 desktop + Android music player** with vanilla JS frontend and Rust backend.

### Frontend (no framework — pure vanilla JS + CSS)

- `src/bootstrap.js` — entry point: detects platform via UA, loads either `src/main.js` (desktop) or `src/mobile-ui.js` (mobile)
- `src/main.js` (~137KB) — all desktop UI: pages, player, lyrics sync, desktop lyrics window management
- `src/mobile-ui.js` (~72KB) — complete mobile UI with its own `invokeTauri` wrapper
- `src/desktop_lyrics.js` — transparent overlay window for word-level lyrics display
- `src/export-playlist.js` — shared playlist export (TXT/CSV)
- `index.html` (~55KB) — full HTML shell (both desktop and mobile sections, mutually exclusive)
- `desktop_lyrics.html` — secondary Tauri Webview window with transparent background
- All DOM manipulation is imperative (`getElementById`, `querySelector`, `addEventListener`). No state management library.

### Rust Backend (`src-tauri/src/`)

| Module | Purpose |
|---|---|
| `commands.rs` | All 35 `#[tauri::command]` functions, AppState, request/response types |
| `config.rs` | `Settings` struct → `~/.cloudplayer/settings.json`, platform-specific paths, `BASE_URL` |
| `db.rs` | SQLite schema (7 tables), migrations, CRUD operations |
| `music_catalog/` | 在线曲库抽象层（`CatalogService` + `MusicCatalogProvider` trait） |
| `music_catalog/providers/gequhai.rs` | gequhai.com 搜索/试听/下载 |
| `download.rs` | Async download queue, delegates to provider trait |
| `lyrics.rs` | Lyrics types, LRC/YRC/TTML parsing, Netease/LRCLIB APIs |
| `lyric_replace.rs` | Multi-source lyric search (QQ/Kugou/Netease/LRCLIB) |
| `lyric_qq.rs` | QQ Music lyrics with QRC decryption |
| `lyric_kugou.rs` | Kugou lyrics with KRC XOR+Zlib decryption |
| `qrc_des.rs` | Custom Triple-DES for QQ QRC (non-standard S-box) |
| `lddc_parse.rs` | QRC/YRC XML word-level timestamp parsing |
| `share_link.rs` | Netease/QQ Music share link → playlist conversion |
| `import_playlist.rs` | Text/CSV/JSON playlist import parser |
| `import_enrich.rs` | Background enrichment: resolve source IDs, cache covers |
| `global_hotkeys.rs` | Desktop-only global shortcuts via `tauri-plugin-global-shortcut` |
| `rate_limiter.rs` | Token bucket: 45 req/min sliding window |
| `logging.rs` | File + stderr logging, panic hook |

### IPC: Frontend ↔ Rust

- **Frontend → Rust**: `invoke("command_name", { args })` via `@tauri-apps/api`
- **Rust → Frontend**: `app.emit("event-name", payload)` — events: `main-close-requested`, `global-hotkey`, `import-enrich-item-done`
- **Tauri managed state**: `DbState` (SQLite Mutex), `AppState` (reqwest Client + RateLimiter + download channel)

### Platform Differences

- **Desktop**: custom HTML titlebar (`decorations: false`), system tray, global hotkeys, desktop lyrics overlay window
- **Android**: sandboxed storage, `rustls` instead of `native-tls`, `convertFileSrc` Blob workaround for audio bug, `tauri-plugin-global-shortcut` excluded
- Conditional compilation: `#[cfg(desktop)]` / `#[cfg(target_os = "android")]` in Rust; UA detection in JS bootstrap

### Audio Playback Resolution Chain (`resolve_online_play`)

Local library → downloaded tracks → download dir same-name file → preview disk cache → recently played URL → **CatalogService** fetch preview → direct URL fallback

### Online Catalog

- `settings.json` → `catalog_provider`: `none` (default) | `gequhai` (歌曲海)
- Architecture: `MusicCatalogProvider` trait + `CatalogService` facade
- See [MUSIC_CATALOG.md](MUSIC_CATALOG.md) for module map and provider integration guide

### Lyrics Pipeline

Multi-source fallback: QQ Music (QRC encrypted) → Kugou (KRC encrypted) → Netease → LRCLIB. Custom cryptographic decoders for proprietary formats. Word-level timestamp extraction from QRC/YRC XML.

## Key Dependencies

- **Rust**: tauri 2, reqwest, rusqlite, tokio, amll-lyric, lofty, scraper
- **JS**: @tauri-apps/api v2, @tauri-apps/plugin-dialog, @tauri-apps/plugin-os
- **Build**: Vite 6, @tauri-apps/cli v2

## Database

SQLite via rusqlite. Tables: `songs`, `playlists`, `playlist_songs`, `playlist_import_items`, `liked_tracks`, `recent_plays`, `downloaded_tracks`. Schema and migrations in `db.rs`.

## Tauri Permissions

Command permissions are declared in `src-tauri/capabilities/default.json`. When adding a new `#[tauri::command]`, register it in both `lib.rs` invoke_handler and the capabilities ACL manifest.
