# 播放源代理（Network Proxy）

让所有「需要联网」的播放源请求统一走代理：在线搜索 / 试听直链 / 歌词 / 分享链接解析 / 下载 / 后台富化等。
WebView 自身的播放仍由浏览器内核处理，与 Rust 侧 HTTP 层互不干扰。

## 支持的协议

| 协议        | 用途                          | 备注 |
|-------------|-------------------------------|------|
| `http://`   | 普通 HTTP 代理                | 需代理软件支持 CONNECT 方法转发 HTTPS |
| `https://`  | 通过 HTTPS 隧道连接代理本身    | 仅代理通道本身加密；目标站点仍按 HTTP/HTTPS |
| `socks5://` | SOCKS5 代理，本地解析目标域名  | 兼容性最广 |
| `socks5h://`| SOCKS5 代理，代理端解析目标域名 | 避免本地 DNS 泄漏（推荐） |

URL 形态：`scheme://[user:pass@]host:port`。
无 userinfo 或仅 `user@` 视为匿名；密码段在 UI 与日志中会被遮蔽为 `***`。

## 配置优先级（自高到低）

1. **命令行参数**（仅桌面，便于临时调试）：
   - `--proxy <url>`：强制覆盖其他来源。
   - `--no-proxy <list>`：设置 NO_PROXY 列表（逗号或空格分隔）。
   - `--disable-proxy` / `--no-proxy-at-all`：忽略所有代理配置。
2. **环境变量**：
   - `CLOUDPLAYER_PROXY` —— 应用专属，scheme 任意。
   - `HTTPS_PROXY` / `https_proxy`、`HTTP_PROXY` / `http_proxy`、`ALL_PROXY` / `all_proxy` —— 标准变量。
   - `NO_PROXY` / `no_proxy` —— 不走代理的域名 / IP / CIDR 列表。
3. **配置文件**：`settings.json` 的 `proxy.enabled + proxy.url + proxy.no_proxy`。
4. 全部为空 → 不启用代理。

## settings.json 形态

```json
{
  "proxy": {
    "enabled": true,
    "url": "socks5h://user:pass@127.0.0.1:1080",
    "no_proxy": "127.0.0.1,localhost,.internal"
  }
}
```

`no_proxy` 可选，遵循 `reqwest::NoProxy::from_string` 规则（逗号或空格分隔；支持域名 / IP / CIDR）。

## 运行期行为

- 启动期 `lib.rs::run()` 解析最终代理，写一条 `eprintln!` 日志（含 `source` 与 `redacted_url`），同时把 `reqwest::Proxy` 注入全局 `AppState.client`。
- 所有需要联网的命令（`search_songs`、`get_preview_url`、`cache_preview_for_play`、`resolve_online_play`、`fetch_song_lrc*`、`lyrics_*`、`fetch_share_playlist`、`enqueue_download`、`scan_music_folder` 中外链请求、后台 `import_enrich` 等）都共享这一 `Client`，因此**无需逐处改造**。
- 修改 `proxy.*` 后 `save_settings` 仅写回磁盘；reqwest `Client` 在启动期一次性构造，**重启后**才生效。设置页 UI 会提示来源与归一化后的 URL。
- IPC：
  - `get_proxy_status() -> ProxyStatus` —— 返回当前进程实际生效的代理（含 `source` / `scheme` / `host` / `port` / `username` / `has_password` / `no_proxy` / `applied_at_ms` / `redacted_url`）。
  - `validate_proxy({ url })` —— 仅做 URL 形态校验（scheme 白名单 + 主机/端口必填）。

## 故障排查

| 现象                                                | 可能原因                                      |
|----------------------------------------------------|----------------------------------------------|
| 设置页保存后仍提示「未启用」                         | 修改后未重启应用，reqwest 客户端未重建          |
| 日志提示 `unsupported scheme 'xxx'`                  | 协议不在 `{http, https, socks5, socks5h}` 内   |
| 通过代理访问 HTTPS 站点失败                          | 代理软件不支持 CONNECT / RFC 2817              |
| 部分本地地址（localhost）也被代理转发                | NO_PROXY 未配置或配置错误                      |
| 移动端启动后行为异常                                 | 代理是命令行参数，Android 上 argv 处理受限，建议使用环境变量或 `settings.json` |
| 代理设置被 CLI `--disable-proxy` 覆盖                | 检查启动参数；命令行优先级最高                  |

## 代码地图

| 路径 | 作用 |
|------|------|
| `src-tauri/src/proxy.rs` | 配置 / 解析 / 应用 / 测试 |
| `src-tauri/src/commands/proxy_cmd.rs` | IPC：`get_proxy_status`、`validate_proxy` |
| `src-tauri/src/commands/settings_cmd.rs` | `SettingsPatch` 新增 `proxy_enabled / proxy_url / proxy_no_proxy` 三字段 |
| `src-tauri/src/config.rs` | `Settings` 新增 `proxy: ProxyConfig` 字段 |
| `src-tauri/src/lib.rs` | 启动期注入 `reqwest::Proxy`，把 `EffectiveProxy` 写入 `AppState` |
| `src-tauri/Cargo.toml` | `reqwest` 启用 `socks` feature（桌面与 Android 双平台） |
| `index.html` | 「播放源代理」偏好设置 UI |
| `src/styles.css` | 代理设置相关样式（`.settings-proxy-*`） |
| `src/settings.js` | 表单读写 + dirty tracking + `get_proxy_status` 拉取 |
| `src/state.js` | `settingsFormBaseline` 增加三字段 + `effectiveProxy` 当前生效快照 |
