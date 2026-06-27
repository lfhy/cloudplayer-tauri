//! `GequhaiProvider` — gequhai.com 在线曲库实现。

use async_trait::async_trait;
use log::warn;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use regex::Regex;
use reqwest::Client;
use scraper::{Html, Selector};
use std::sync::LazyLock;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::sleep;

use super::super::id::CatalogTrackId;
use super::super::provider::MusicCatalogProvider;
use super::super::types::{PreviewResolve, SearchPage, SearchResultDto, TrackMetadata};

const BASE_URL: &str = "https://www.gequhai.com";
const PROVIDER_NAME: &str = "gequhai";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SEARCH_KEYWORD_MAX_LEN: usize = 50;

static GEOUHAI_HTTP: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static GEOUHAI_WARMED: LazyLock<Mutex<bool>> = LazyLock::new(|| Mutex::new(false));

pub struct GequhaiProvider;

impl GequhaiProvider {
    pub fn new() -> Self {
        Self
    }

    fn ensure_id(track_id: &CatalogTrackId) -> Result<&str, String> {
        if track_id.provider != PROVIDER_NAME {
            return Err(format!(
                "曲库 id 来源不匹配（期望 gequhai，实际 {}）",
                track_id.provider
            ));
        }
        let sid = track_id.id.trim();
        if sid.is_empty() {
            return Err("无效的歌曲 ID".to_string());
        }
        Ok(sid)
    }

    fn encode_path_segment(segment: &str) -> String {
        utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string()
    }

    async fn with_http_gate<F, Fut, T>(f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        let _guard = GEOUHAI_HTTP.lock().await;
        f().await
    }

    fn is_retryable_reqwest(err: &reqwest::Error) -> bool {
        err.is_connect() || err.is_timeout() || err.is_request()
    }

    async fn send_with_retry<F, Fut>(label: &str, build: F) -> Result<reqwest::Response, String>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
    {
        const BACKOFF_MS: [u64; 4] = [0, 600, 1500, 3000];
        let mut last = String::new();
        for (i, wait) in BACKOFF_MS.iter().enumerate() {
            if *wait > 0 {
                sleep(Duration::from_millis(*wait)).await;
            }
            match build().await {
                Ok(resp) => return Ok(resp),
                Err(e) => {
                    last = format!("{label}: {e:#}");
                    if i + 1 >= BACKOFF_MS.len() || !Self::is_retryable_reqwest(&e) {
                        break;
                    }
                    warn!(
                        target: "gequhai",
                        "HTTP 重试 {}/{} label={} err={}",
                        i + 1,
                        BACKOFF_MS.len(),
                        label,
                        e
                    );
                }
            }
        }
        Err(last)
    }

    fn search_page_url(keyword: &str, page: u32) -> Result<String, String> {
        let encoded = Self::encode_path_segment(keyword);
        let mut url = format!("{}/s/{}", BASE_URL, encoded);
        if page > 1 {
            url.push('?');
            url.push_str(
                &url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("page", &page.to_string())
                    .finish(),
            );
        }
        Ok(url)
    }

    fn form_keyword_body(keyword: &str) -> String {
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("keyword", keyword)
            .finish()
    }

    fn api_post_headers(referer: &str) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::USER_AGENT, UA.parse().unwrap());
        headers.insert(
            reqwest::header::HeaderName::from_static("x-requested-with"),
            "XMLHttpRequest".parse().unwrap(),
        );
        headers.insert(reqwest::header::ORIGIN, BASE_URL.parse().unwrap());
        headers.insert(reqwest::header::REFERER, referer.parse().unwrap());
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded; charset=UTF-8"
                .parse()
                .unwrap(),
        );
        headers.insert(
            reqwest::header::ACCEPT,
            "application/json, text/javascript, */*; q=0.01"
                .parse()
                .unwrap(),
        );
        headers.insert(
            reqwest::header::ACCEPT_LANGUAGE,
            "zh-CN,zh;q=0.9,en;q=0.8".parse().unwrap(),
        );
        headers
    }

    /// 站点需先 POST `/api/s`，必要时轮询 `/api/query-map`，再 GET 结果页。
    async fn prepare_search(client: &Client, keyword: &str) -> Result<(), String> {
        let referer = format!("{}/", BASE_URL);
        let body = Self::form_keyword_body(keyword);
        let resp = Self::send_with_retry("POST /api/s", || {
            client
                .post(format!("{}/api/s", BASE_URL))
                .headers(Self::api_post_headers(&referer))
                .body(body.clone())
                .send()
        })
        .await?;

        if !resp.status().is_success() {
            return Err(format!("搜索 API HTTP {}", resp.status()));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("解析搜索 API 响应失败: {}", e))?;

        match json.get("code").and_then(|c| c.as_i64()) {
            Some(1) => Ok(()),
            Some(2) => Self::poll_query_map(client, keyword).await,
            Some(code) => {
                let msg = json
                    .get("msg")
                    .and_then(|m| m.as_str())
                    .unwrap_or("未知错误");
                Err(format!("搜索 API 业务错误 {}: {}", code, msg))
            }
            None => Err("搜索 API 响应缺少 code".to_string()),
        }
    }

    async fn poll_query_map(client: &Client, keyword: &str) -> Result<(), String> {
        let referer = Self::search_page_url(keyword, 1)?;
        let body = Self::form_keyword_body(keyword);
        for attempt in 0..15 {
            if attempt > 0 {
                sleep(Duration::from_millis(800)).await;
            }
            let resp = match Self::send_with_retry("POST /api/query-map", || {
                client
                    .post(format!("{}/api/query-map", BASE_URL))
                    .headers(Self::api_post_headers(&referer))
                    .body(body.clone())
                    .send()
            })
            .await
            {
                Ok(r) => r,
                Err(e) => {
                    warn!(target: "gequhai", "query-map 请求失败 attempt={} err={}", attempt, e);
                    continue;
                }
            };
            if !resp.status().is_success() {
                continue;
            }
            let json: serde_json::Value = match resp.json().await {
                Ok(v) => v,
                Err(_) => continue,
            };
            if json.get("code").and_then(|c| c.as_i64()) == Some(1) {
                return Ok(());
            }
        }
        Err("搜索排队超时，请稍后再试".to_string())
    }

    /// 对齐站点提示：去掉括号/特殊符号，截断 50 字。
    pub fn sanitize_search_keyword(s: &str) -> String {
        let mut t = s.replace('&', " ");
        let re_paren =
            Regex::new(r"[\(\（\[【《][^)\）\]】》]*[\)\）\]】》]").unwrap_or_else(|_| Regex::new("$^").unwrap());
        for _ in 0..4 {
            let next = re_paren.replace_all(&t, " ");
            if next == t {
                break;
            }
            t = next.to_string();
        }
        for tag in ["(Explicit)", "(Live)", "(Remix)", "（Explicit）", "（Live）"] {
            t = t.replace(tag, " ");
        }
        let re_ws = Regex::new(r"\s+").unwrap_or_else(|_| Regex::new("$^").unwrap());
        t = re_ws.replace_all(t.trim(), " ").to_string();
        t.chars().take(SEARCH_KEYWORD_MAX_LEN).collect()
    }

    /// 富化/匹配用：多组关键词，由精确到宽松。
    pub fn search_keyword_variants(title: &str, artist: &str) -> Vec<String> {
        let title = title.trim();
        let artist = artist.trim();
        let mut variants = Vec::new();
        let mut push = |s: String| {
            let s = Self::sanitize_search_keyword(&s);
            if !s.is_empty() && !variants.iter().any(|v| v == &s) {
                variants.push(s);
            }
        };

        if !title.is_empty() && !artist.is_empty() {
            push(format!("{title} {artist}"));
        }
        if !title.is_empty() {
            push(title.to_string());
            if let Some(before) = title.split(['-', '–', '—', '|']).next() {
                push(before.trim().to_string());
            }
        }
        if !artist.is_empty() {
            let first = artist
                .split(&['&', '/', '、', ','][..])
                .next()
                .unwrap_or(artist)
                .split(" feat.")
                .next()
                .unwrap_or("")
                .split(" ft.")
                .next()
                .unwrap_or("")
                .trim();
            if !title.is_empty() && !first.is_empty() {
                push(format!("{title} {first}"));
            }
        }
        variants
    }

    /// 预热：访问首页建立 cookie（每进程一次）。
    async fn warmup(client: &Client) {
        let mut warmed = GEOUHAI_WARMED.lock().await;
        if *warmed {
            return;
        }
        let _ = client
            .get(BASE_URL)
            .header("User-Agent", UA)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .send()
            .await;
        *warmed = true;
    }

    /// 获取歌曲页 HTML（须先于 `/api/music` 调用以建立 session）。
    async fn fetch_play_page(client: &Client, id: &str) -> Result<String, String> {
        let url = format!("{}/play/{}", BASE_URL, id);
        let resp = client
            .get(&url)
            .header("User-Agent", UA)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("Referer", format!("{}/", BASE_URL))
            .header("Sec-Fetch-Dest", "document")
            .header("Sec-Fetch-Mode", "navigate")
            .header("Sec-Fetch-Site", "same-origin")
            .send()
            .await
            .map_err(|e| format!("请求歌曲页失败: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("歌曲页 HTTP {}", resp.status()));
        }
        resp.text()
            .await
            .map_err(|e| format!("读取歌曲页失败: {}", e))
    }

    /// 从歌曲页 script 中提取 `window.{name} = 'value'`。
    fn extract_window_var(html: &str, var_name: &str) -> Option<String> {
        let patterns = [
            format!(r"window\.{var_name}\s*=\s*'([^']*)'"),
            format!(r#"window\.{var_name}\s*=\s*"([^"]*)""#),
            format!(r"{var_name}\s*=\s*'([^']*)'"),
            format!(r#"{var_name}\s*=\s*"([^"]*)""#),
        ];
        for pat in &patterns {
            if let Ok(re) = Regex::new(pat) {
                if let Some(caps) = re.captures(html) {
                    if let Some(m) = caps.get(1) {
                        let v = m.as_str().trim();
                        if !v.is_empty() {
                            return Some(v.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    fn extract_mp3_type(html: &str) -> String {
        Self::extract_window_var(html, "mp3_type").unwrap_or_else(|| "0".to_string())
    }

    fn extract_cover(html: &str) -> Option<String> {
        Self::extract_window_var(html, "mp3_cover")
    }

    fn extract_lrc(html: &str) -> Option<String> {
        let document = Html::parse_document(html);
        let selector = Selector::parse("#content-lrc2").ok()?;
        let el = document.select(&selector).next()?;
        let text = el.text().collect::<Vec<_>>().join("\n");
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed.contains("歌词获取失败") {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    fn api_ok(code: i64) -> bool {
        code == 200 || code == 1
    }

    /// POST `/api/music`：`id` 为歌曲页 numeric id（非 play_id hash）。
    async fn fetch_audio_url(
        client: &Client,
        api_id: &str,
        mp3_type: &str,
        referer_song_id: &str,
    ) -> Result<String, String> {
        let referer = format!("{}/play/{}", BASE_URL, referer_song_id);
        let resp = client
            .post(format!("{}/api/music", BASE_URL))
            .header("User-Agent", UA)
            .header("X-Requested-With", "XMLHttpRequest")
            .header("X-Custom-Header", "SecretKey")
            .header("Origin", BASE_URL)
            .header("Referer", referer)
            .header("Accept", "application/json, text/javascript, */*; q=0.01")
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header("Sec-Fetch-Dest", "empty")
            .header("Sec-Fetch-Mode", "cors")
            .header("Sec-Fetch-Site", "same-origin")
            .header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
            .body(format!("id={}&type={}", api_id, mp3_type))
            .send()
            .await
            .map_err(|e| format!("请求音频接口失败: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("音频接口 HTTP {}", resp.status()));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("解析音频接口响应失败: {}", e))?;

        let code = json.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
        if !Self::api_ok(code) {
            let msg = json
                .get("msg")
                .and_then(|m| m.as_str())
                .unwrap_or("未知错误");
            return Err(format!("音频接口业务错误 {}: {}", code, msg));
        }

        json.get("data")
            .and_then(|d| d.get("url"))
            .and_then(|u| u.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| s.starts_with("http"))
            .ok_or_else(|| "音频接口响应缺少 url 字段".to_string())
    }

    /// 解析搜索页 HTML（对齐 musicdl：table#myTables，任意 `/play/` 链接）。
    fn parse_search_html(html: &str) -> (Vec<SearchResultDto>, bool) {
        let document = Html::parse_document(html);
        let row_sel = match Selector::parse("table#myTables tbody tr") {
            Ok(s) => s,
            Err(_) => return (Vec::new(), false),
        };
        let td_sel = Selector::parse("td").unwrap();
        let play_link_sel = Selector::parse("a[href*='/play/']").unwrap();

        let mut results = Vec::new();

        for row in document.select(&row_sel) {
            let tds: Vec<_> = row.select(&td_sel).collect();
            if tds.len() < 3 {
                continue;
            }
            let Some(link) = tds[1].select(&play_link_sel).next() else {
                continue;
            };
            let href = link.value().attr("href").unwrap_or("").trim();
            let title = link.text().collect::<Vec<_>>().join("").trim().to_string();
            let artist = tds[2].text().collect::<Vec<_>>().join("").trim().to_string();

            let id = href
                .strip_prefix("/play/")
                .or_else(|| href.strip_prefix("play/"))
                .and_then(|rest| rest.split(['?', '#']).next())
                .map(str::trim)
                .filter(|s| !s.is_empty());

            let Some(id) = id else {
                continue;
            };
            if title.is_empty() {
                continue;
            }

            let track_id = CatalogTrackId::new(PROVIDER_NAME, id);
            results.push(SearchResultDto {
                source_id: track_id.to_api_string(),
                catalog_provider: PROVIDER_NAME.to_string(),
                title,
                artist,
                album: String::new(),
                cover_url: None,
            });
        }

        let has_next = html.contains("下一页") && {
            let next_sel = Selector::parse("nav a").unwrap();
            document.select(&next_sel).any(|a| {
                let text = a.text().collect::<Vec<_>>().join("");
                text.contains("下一页")
                    && a.value()
                        .attr("href")
                        .map(|h| !h.is_empty() && h != "#")
                        .unwrap_or(false)
            })
        };

        (results, has_next)
    }
}

#[async_trait]
impl MusicCatalogProvider for GequhaiProvider {
    fn name(&self) -> &'static str {
        PROVIDER_NAME
    }

    async fn search(&self, client: &Client, keyword: &str, page: u32) -> Result<SearchPage, String> {
        let keyword = Self::sanitize_search_keyword(keyword.trim());
        if keyword.is_empty() {
            return Err("搜索关键词不能为空".to_string());
        }

        Self::with_http_gate(|| async {
            Self::warmup(client).await;
            if let Err(e) = Self::prepare_search(client, &keyword).await {
                warn!(
                    target: "gequhai",
                    "prepare_search 失败，尝试直接 GET 结果页 keyword={} err={}",
                    keyword,
                    e
                );
            }

            let url = Self::search_page_url(&keyword, page)?;
            let fetch_url = url.clone();

            let resp = Self::send_with_retry("GET /s/", || {
                client
                    .get(&fetch_url)
                    .header("User-Agent", UA)
                    .header(
                        "Accept",
                        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    )
                    .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                    .header("Referer", format!("{}/", BASE_URL))
                    .send()
            })
            .await
            .map_err(|e| format!("搜索请求失败: {}", e))?;

            if !resp.status().is_success() {
                return Err(format!("搜索页 HTTP {}", resp.status()));
            }

            let html = resp
                .text()
                .await
                .map_err(|e| format!("读取搜索页失败: {}", e))?;

            let (results, has_next) = Self::parse_search_html(&html);
            if results.is_empty() {
                warn!(
                    target: "gequhai",
                    "搜索无结果 keyword={} page={} html_len={}",
                    keyword,
                    page,
                    html.len()
                );
            }
            Ok(SearchPage { results, has_next })
        })
        .await
    }

    async fn resolve_preview(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<PreviewResolve, String> {
        let url = self
            .fetch_preview_url(client, track_id)
            .await?
            .ok_or_else(|| "未解析到试听地址".to_string())?;
        Ok(PreviewResolve::Url(url))
    }

    async fn fetch_preview_url(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<Option<String>, String> {
        let sid = Self::ensure_id(track_id)?;
        let html = Self::fetch_play_page(client, sid).await?;
        let mp3_type = Self::extract_mp3_type(&html);
        // API 的 id 优先用页面 script 里的 play_id（hash）；无则回退 URL 数字 id。
        let api_id = Self::extract_window_var(&html, "play_id").unwrap_or_else(|| sid.to_string());
        match Self::fetch_audio_url(client, &api_id, &mp3_type, sid).await {
            Ok(url) => Ok(Some(url)),
            Err(e) if api_id != sid => {
                warn!(
                    target: "gequhai",
                    "play_id api failed sid={} play_id={} err={} — retry numeric id",
                    sid,
                    api_id,
                    e
                );
                Self::fetch_audio_url(client, sid, &mp3_type, sid)
                    .await
                    .map(Some)
            }
            Err(e) => {
                warn!(target: "gequhai", "fetch_audio_url sid={} err={}", sid, e);
                Err(e)
            }
        }
    }

    async fn cache_preview(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<std::path::PathBuf, String> {
        let sid = Self::ensure_id(track_id)?;
        let url = self
            .fetch_preview_url(client, track_id)
            .await?
            .ok_or_else(|| "未解析到试听地址".to_string())?;

        let dir = crate::music_catalog::CatalogService::preview_audio_cache_dir();
        let _ = std::fs::create_dir_all(&dir);
        let cache_path = dir.join(format!("preview_{}_{}.mp3", PROVIDER_NAME, sid));

        if cache_path.is_file()
            && std::fs::metadata(&cache_path)
                .map(|m| m.len() > 0)
                .unwrap_or(false)
        {
            return Ok(cache_path);
        }

        let referer = format!("{}/play/{}", BASE_URL, sid);
        crate::download::stream_audio_to_file(client, &url, &referer, &cache_path).await?;
        Ok(cache_path)
    }

    async fn fetch_metadata(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<TrackMetadata, String> {
        let sid = Self::ensure_id(track_id)?;
        Self::warmup(client).await;
        let html = Self::fetch_play_page(client, sid).await.unwrap_or_default();
        let cover_url = Self::extract_cover(&html);
        Ok(TrackMetadata {
            album: String::new(),
            duration_ms: 0,
            cover_url,
        })
    }

    async fn fetch_lrc(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
    ) -> Result<Option<String>, String> {
        let sid = Self::ensure_id(track_id)?;
        Self::warmup(client).await;
        let html = Self::fetch_play_page(client, sid).await?;
        Ok(Self::extract_lrc(&html))
    }

    async fn download_full(
        &self,
        client: &Client,
        track_id: &CatalogTrackId,
        _quality: &str,
        dest: &std::path::Path,
    ) -> Result<(), String> {
        let sid = Self::ensure_id(track_id)?;
        let url = self
            .fetch_preview_url(client, track_id)
            .await?
            .ok_or_else(|| "未解析到下载地址".to_string())?;

        let referer = format!("{}/play/{}", BASE_URL, sid);
        crate::download::stream_audio_to_file(client, &url, &referer, dest).await?;
        Ok(())
    }

    fn supports_download(&self) -> bool {
        true
    }
}
