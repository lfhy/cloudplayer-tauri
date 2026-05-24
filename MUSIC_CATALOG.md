# 在线曲库（Music Catalog）架构说明

pjmp3.com 已下线。本应用通过 `music_catalog` 模块将搜索、试听、下载、导入富化与具体曲库源解耦。

## 模块结构

| 路径 | 职责 |
|------|------|
| `src-tauri/src/music_catalog/mod.rs` | 模块入口 |
| `src-tauri/src/music_catalog/types.rs` | `CatalogTrackId`、`SearchResult`、`PreviewResolve` 等 |
| `src-tauri/src/music_catalog/id.rs` | 复合 ID 解析（`pjmp3:123` / 裸数字兼容） |
| `src-tauri/src/music_catalog/provider.rs` | `MusicCatalogProvider` trait |
| `src-tauri/src/music_catalog/service.rs` | `CatalogService`：active provider、限速、缓存路径 |
| `src-tauri/src/music_catalog/providers/pjmp3_impl.rs` | 原 pjmp3 抓取实现（legacy，默认不启用） |
| `src-tauri/src/music_catalog/providers/pjmp3.rs` | `Pjmp3Provider` trait 实现 |

## IPC 命令 → CatalogService

| 命令 | 方法 |
|------|------|
| `search_songs` | `search` |
| `get_preview_url` | `fetch_preview_url` |
| `cache_preview_for_play` | `cache_preview` |
| `resolve_online_play`（在线段） | `preview_cache_path` / `cache_preview` / `fetch_preview_url` |
| `fetch_song_lrc` | `fetch_lrc` |
| `enqueue_download` → `download::run_one_job` | `download_full` |
| `import_enrich` | `search_first_match` / `fetch_metadata` |

## 数据库

四表含 `catalog_provider`（默认 `pjmp3` 表示历史数据）。`pjmp3_source_id` 列语义为 **catalog_id**，serde 别名 `catalog_id`。

## 设置

`settings.json` → `catalog_provider`：`none`（默认）| `pjmp3`（legacy，站点已不可用）

## 播放解析链（不变）

本地库 → 已下载 → 下载目录同名 → 试听磁盘缓存 → 最近播放 URL → CatalogService 拉取试听 → 直链 fallback
