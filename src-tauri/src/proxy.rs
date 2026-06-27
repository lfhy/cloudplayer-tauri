//! 网络代理：让播放源（在线搜索 / 试听 / 歌词 / 分享链接 / 下载 / 富化）
//! 等所有 reqwest 调用统一走代理；支持 HTTP、HTTPS、SOCKS5、SOCKS5h。
//!
//! ## 配置优先级
//! 1. 命令行参数 `--proxy <url>` / `--no-proxy <list>`（仅用于调试：覆盖环境变量与配置文件）。
//! 2. 环境变量（沿用业界惯例；大小写不敏感）：
//!    - `CLOUDPLAYER_PROXY` —— 应用专属，等同于「全部协议代理」。
//!    - `HTTPS_PROXY` / `https_proxy`、`HTTP_PROXY` / `http_proxy`、`ALL_PROXY` / `all_proxy` —— 标准变量。
//!    - `NO_PROXY` / `no_proxy` —— 不走代理的域名/IP/CIDR 列表，逗号或空格分隔。
//! 3. `settings.json` 中的 `proxy.enabled + proxy.url + proxy.no_proxy`。
//! 4. 全部为空 → 不启用代理。
//!
//! ## 配置形态
//! ```json
//! { "enabled": true, "url": "socks5h://user:pass@127.0.0.1:1080", "no_proxy": "127.0.0.1,localhost" }
//! ```
//!
//! ## 运行时行为
//! - 启动时按优先级确定最终代理并写一条日志（密码段遮蔽）。
//! - 运行时调用 [`apply_to`] 把代理写入 reqwest 客户端即可。

use std::env;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const SUPPORTED_SCHEMES: &[&str] = &["http", "https", "socks5", "socks5h"];

/// 序列化的代理设置（与 `settings.json` 兼容）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "snake_case")]
pub struct ProxyConfig {
    /// 总开关：false 时即便 url 非空也不启用。
    pub enabled: bool,
    /// 代理 URL：scheme ∈ {http, https, socks5, socks5h}。
    pub url: String,
    /// NO_PROXY 列表：逗号或空格分隔；空字符串等同于「不做 exclude」。
    pub no_proxy: String,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            no_proxy: String::new(),
        }
    }
}

/// 解析后的代理详情（含最终生效来源，供前端展示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProxyStatus {
    /// 是否实际生效：true 即已写入 reqwest 客户端。
    pub applied: bool,
    /// 配置来源：`cli` / `env:CLOUDPLAYER_PROXY` / `env:HTTPS_PROXY` / `settings` / `none`。
    pub source: String,
    /// 原始字符串（密码段已替换为 `***`）。
    pub redacted_url: String,
    /// 归一化后的 URL（去掉 userinfo），供调试使用。
    pub normalized_url: String,
    /// scheme (`http` / `https` / `socks5` / `socks5h`)。
    pub scheme: String,
    /// host：空字符串表示未启用。
    pub host: String,
    /// port：0 表示未启用。
    pub port: u16,
    /// 解析出的 user（不包含密码），空表示无口令或未启用。
    pub username: String,
    /// 是否带口令。
    pub has_password: bool,
    /// NO_PROXY 列表（归一化为逗号分隔）。
    pub no_proxy: String,
    /// 启动时间戳（毫秒，UNIX 纪元）；用于 UI 显示「最后应用」时间。
    pub applied_at_ms: i64,
}

impl Default for ProxyStatus {
    fn default() -> Self {
        Self {
            applied: false,
            source: "none".to_string(),
            redacted_url: String::new(),
            normalized_url: String::new(),
            scheme: String::new(),
            host: String::new(),
            port: 0,
            username: String::new(),
            has_password: false,
            no_proxy: String::new(),
            applied_at_ms: 0,
        }
    }
}

/// 单次启动时记录：哪个来源最终胜出。
#[derive(Debug, Clone)]
pub struct EffectiveProxy {
    pub config: ProxyConfig,
    pub source: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 命令行参数覆盖（一次性快照，启动后变更需重启）。
#[derive(Debug, Clone, Default)]
pub struct CliProxyOverride {
    pub url: Option<String>,
    pub no_proxy: Option<String>,
    pub disable: bool,
}

impl CliProxyOverride {
    pub fn from_env_args(args: &[String]) -> Self {
        let mut o = CliProxyOverride::default();
        let mut i = 0;
        while i < args.len() {
            let a = &args[i];
            match a.as_str() {
                "--proxy" => {
                    if let Some(v) = args.get(i + 1) {
                        o.url = Some(v.clone());
                        i += 2;
                        continue;
                    }
                }
                "--no-proxy" => {
                    if let Some(v) = args.get(i + 1) {
                        o.no_proxy = Some(v.clone());
                        i += 2;
                        continue;
                    }
                }
                "--no-proxy-at-all" | "--disable-proxy" => {
                    o.disable = true;
                }
                _ => {}
            }
            i += 1;
        }
        o
    }
}

/// 解析代理 URL：支持 `http://`、`https://`、`socks5://`、`socks5h://`，
/// 可选 `user:pass@host:port`。
pub fn parse_proxy_url(raw: &str) -> Result<url::Url, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("代理 URL 为空".to_string());
    }
    let url = url::Url::parse(s).map_err(|e| format!("代理 URL 无法解析: {e}"))?;
    let scheme = url.scheme().to_ascii_lowercase();
    if !SUPPORTED_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!(
            "不支持的代理协议: {scheme}（仅支持 http / https / socks5 / socks5h）"
        ));
    }
    let host = url.host_str().unwrap_or("").trim();
    if host.is_empty() {
        return Err("代理 URL 缺少主机名".to_string());
    }
    if url.port().is_none() {
        return Err("代理 URL 缺少端口".to_string());
    }
    Ok(url)
}

/// 用户态验证：URL 形态 + scheme 白名单。
pub fn validate_config(cfg: &ProxyConfig) -> Result<(), String> {
    if !cfg.enabled {
        return Ok(());
    }
    let url = cfg.url.trim();
    if url.is_empty() {
        return Err("已启用代理但 URL 为空".to_string());
    }
    parse_proxy_url(url).map(|_| ())
}

/// 替换 userinfo 中的密码段为 `***`，保留用户名。
pub fn redact_url(raw: &str) -> String {
    let Ok(url) = url::Url::parse(raw.trim()) else {
        return raw.to_string();
    };
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or("");
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    let userinfo = match (url.username(), url.password()) {
        ("", _) => String::new(),
        (u, Some(_)) => format!("{u}:***@"),
        (u, None) => format!("{u}@"),
    };
    let path_q = {
        let p = url.path();
        if p.is_empty() || p == "/" {
            String::new()
        } else {
            p.to_string()
        }
    };
    format!("{scheme}://{userinfo}{host}{port}{path_q}")
}

fn normalize_no_proxy(s: &str) -> String {
    s.split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

/// 进程环境变量里的代理候选，按优先级排列。
fn env_candidates() -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    for (k, label) in [
        ("CLOUDPLAYER_PROXY", "env:CLOUDPLAYER_PROXY"),
        ("HTTPS_PROXY", "env:HTTPS_PROXY"),
        ("https_proxy", "env:HTTPS_PROXY"),
        ("HTTP_PROXY", "env:HTTP_PROXY"),
        ("http_proxy", "env:HTTP_PROXY"),
        ("ALL_PROXY", "env:ALL_PROXY"),
        ("all_proxy", "env:ALL_PROXY"),
    ] {
        if let Ok(v) = env::var(k) {
            let t = v.trim();
            if !t.is_empty() {
                out.push((label, t.to_string()));
            }
        }
    }
    out
}

fn env_no_proxy() -> Option<String> {
    for k in ["NO_PROXY", "no_proxy"] {
        if let Ok(v) = env::var(k) {
            let t = v.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// 综合 CLI 覆盖 + 环境变量 + settings.json，输出最终代理及来源。
pub fn resolve_effective(cli: &CliProxyOverride, settings: &ProxyConfig) -> EffectiveProxy {
    if cli.disable {
        return EffectiveProxy {
            config: ProxyConfig::default(),
            source: "cli:disable".to_string(),
        };
    }
    if let Some(url) = cli.url.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let no_proxy = cli
            .no_proxy
            .clone()
            .or_else(env_no_proxy)
            .unwrap_or_else(|| settings.no_proxy.clone());
        return EffectiveProxy {
            config: ProxyConfig {
                enabled: true,
                url: url.to_string(),
                no_proxy: normalize_no_proxy(&no_proxy),
            },
            source: "cli:--proxy".to_string(),
        };
    }
    for (label, url) in env_candidates() {
        return EffectiveProxy {
            config: ProxyConfig {
                enabled: true,
                url: url.clone(),
                no_proxy: normalize_no_proxy(
                    &env_no_proxy().unwrap_or_else(|| settings.no_proxy.clone()),
                ),
            },
            source: label.to_string(),
        };
    }
    if settings.enabled {
        let url = settings.url.trim().to_string();
        if !url.is_empty() {
            return EffectiveProxy {
                config: ProxyConfig {
                    enabled: true,
                    url,
                    no_proxy: normalize_no_proxy(&settings.no_proxy),
                },
                source: "settings".to_string(),
            };
        }
    }
    EffectiveProxy {
        config: ProxyConfig::default(),
        source: "none".to_string(),
    }
}

pub fn status_from(eff: &EffectiveProxy) -> ProxyStatus {
    if !eff.config.enabled {
        return ProxyStatus {
            source: eff.source.clone(),
            ..ProxyStatus::default()
        };
    }
    let parsed = parse_proxy_url(&eff.config.url).ok();
    let (scheme, host, port, user, has_pwd) = match parsed.as_ref() {
        Some(u) => {
            let port = u.port().unwrap_or(0);
            let user = u.username().to_string();
            let pwd = u.password().is_some();
            (
                u.scheme().to_ascii_lowercase(),
                u.host_str().unwrap_or("").to_string(),
                port,
                user,
                pwd,
            )
        }
        None => (String::new(), String::new(), 0, String::new(), false),
    };
    ProxyStatus {
        applied: true,
        source: eff.source.clone(),
        redacted_url: redact_url(&eff.config.url),
        normalized_url: parsed
            .as_ref()
            .map(|u| {
                let host = u.host_str().unwrap_or("");
                let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
                format!("{}://{}{}", u.scheme(), host, port)
            })
            .unwrap_or_default(),
        scheme,
        host,
        port,
        username: user,
        has_password: has_pwd,
        no_proxy: eff.config.no_proxy.clone(),
        applied_at_ms: now_ms(),
    }
}

/// 把代理配置应用到 reqwest 客户端构造器。
///
/// `Proxy::all` 会同时接管 http 与 https；`socks5h` 通过 `reqwest::Proxy::all` 解析，
/// 会作为 SOCKS5h 转发，**远端域名解析**仍在代理端执行，符合 socks5h 语义。
pub fn apply_to(builder: reqwest::ClientBuilder, cfg: &ProxyConfig) -> reqwest::ClientBuilder {
    if !cfg.enabled {
        return builder;
    }
    let Ok(url) = parse_proxy_url(&cfg.url) else {
        return builder;
    };
    // reqwest 0.12 Proxy::all 返回 `Result<Proxy, _>`；不通过即视为未启用（不抛错）。
    let proxy = match reqwest::Proxy::all(url.as_str()) {
        Ok(p) => p,
        Err(_) => return builder,
    };
    // reqwest 0.12 的 Proxy::no_proxy 接受 `Option<NoProxy>`（None 表示禁用 NO_PROXY 过滤）。
    let no_proxy_opt = if cfg.no_proxy.trim().is_empty() {
        None
    } else {
        reqwest::NoProxy::from_string(&normalize_no_proxy(&cfg.no_proxy))
    };
    let proxy = proxy.no_proxy(no_proxy_opt);
    builder.proxy(proxy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_proxy_url_accepts_socks5h() {
        let u = parse_proxy_url("socks5h://127.0.0.1:1080").expect("parse");
        assert_eq!(u.scheme(), "socks5h");
        assert_eq!(u.host_str(), Some("127.0.0.1"));
        assert_eq!(u.port(), Some(1080));
    }

    #[test]
    fn parse_proxy_url_rejects_bad_scheme() {
        assert!(parse_proxy_url("ftp://127.0.0.1:21").is_err());
    }

    #[test]
    fn parse_proxy_url_rejects_missing_port() {
        assert!(parse_proxy_url("http://127.0.0.1").is_err());
    }

    #[test]
    fn redact_url_hides_password() {
        let r = redact_url("http://alice:hunter2@example.com:8080");
        assert!(r.contains("alice:***@"));
        assert!(!r.contains("hunter2"));
    }

    #[test]
    fn resolve_effective_prefers_cli() {
        let cli = CliProxyOverride {
            url: Some("http://1.1.1.1:8080".into()),
            no_proxy: None,
            disable: false,
        };
        let settings = ProxyConfig {
            enabled: true,
            url: "http://2.2.2.2:8080".into(),
            no_proxy: "".into(),
        };
        let eff = resolve_effective(&cli, &settings);
        assert_eq!(eff.source, "cli:--proxy");
        assert_eq!(eff.config.url, "http://1.1.1.1:8080");
    }

    #[test]
    fn resolve_effective_disable_cli() {
        let cli = CliProxyOverride {
            url: None,
            no_proxy: None,
            disable: true,
        };
        let settings = ProxyConfig {
            enabled: true,
            url: "http://2.2.2.2:8080".into(),
            no_proxy: "".into(),
        };
        let eff = resolve_effective(&cli, &settings);
        assert!(!eff.config.enabled);
        assert_eq!(eff.source, "cli:disable");
    }

    #[test]
    fn resolve_effective_settings_when_no_env() {
        let cli = CliProxyOverride::default();
        let settings = ProxyConfig {
            enabled: true,
            url: "http://5.5.5.5:8080".into(),
            no_proxy: "127.0.0.1,localhost".into(),
        };
        let eff = resolve_effective(&cli, &settings);
        assert_eq!(eff.source, "settings");
        assert_eq!(eff.config.no_proxy, "127.0.0.1,localhost");
    }

    #[test]
    fn validate_config_rejects_empty_when_enabled() {
        let c = ProxyConfig {
            enabled: true,
            url: "".into(),
            no_proxy: "".into(),
        };
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn validate_config_accepts_disabled() {
        let c = ProxyConfig::default();
        assert!(validate_config(&c).is_ok());
    }

    #[test]
    fn apply_to_is_noop_when_disabled() {
        let b = reqwest::Client::builder();
        let _ = apply_to(b, &ProxyConfig::default());
    }
}
