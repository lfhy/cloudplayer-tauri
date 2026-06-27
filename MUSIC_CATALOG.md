# 在线曲库（Music Catalog）架构说明

本应用通过 `music_catalog` 模块将搜索、试听、下载、导入富化与具体曲库源解耦。新增曲库源只需实现 `MusicCatalogProvider` trait 并在 `CatalogService::new()` 中注册。

## 模块结构

| 路径 | 职责 |
|------|------|
| `src-tauri/src/music_catalog/mod.rs` | 模块入口 |
| `src-tauri/src/music_catalog/types.rs` | `CatalogTrackId`、`SearchResult`、`PreviewResolve` 等 |
| `src-tauri/src/music_catalog/id.rs` | 复合 ID 解析（`provider:id` 格式） |
| `src-tauri/src/music_catalog/provider.rs` | `MusicCatalogProvider` trait |
| `src-tauri/src/music_catalog/service.rs` | `CatalogService`：active provider、缓存路径 |
| `src-tauri/src/music_catalog/providers/gequhai.rs` | gequhai.com 搜索/试听/下载 |

## 新增 Provider 指南

1. 在 `providers/` 下新建模块，实现 `MusicCatalogProvider` trait
2. 在 `service.rs` 的 `CatalogService::new()` 中注册
3. 在 `config.rs` 的 `catalog_provider` 设置中添加对应值

### trait 方法

| 方法 | 用途 |
|------|------|
| `search` | 关键词搜索，返回分页结果 |
| `resolve_preview` | 解析试听（URL 或缓存文件） |
| `fetch_preview_url` | 获取试听直链 |
| `cache_preview` | 下载试听音频到本地缓存 |
| `fetch_metadata` | 获取专辑/时长等元数据 |
| `fetch_lrc` | 获取 LRC 歌词文本 |
| `download_full` | 全量下载（可选，默认不支持） |

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

四表含 `catalog_provider` 和 `pjmp3_source_id` 列（历史兼容，语义为 catalog_id）。serde 别名 `catalog_id`。

## 设置

`settings.json` → `catalog_provider`：`none`（默认，不可用）| `gequhai`（歌曲海）

## 播放解析链

本地库 → 已下载 → 下载目录同名 → 试听磁盘缓存 → 最近播放 URL → CatalogService 拉取试听 → 直链 fallback
