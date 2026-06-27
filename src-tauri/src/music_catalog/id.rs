//! 复合曲库 ID：`provider:id`。

pub const PROVIDER_NONE: &str = "none";

/// 解析 API / DB 传入的 id 字符串。
pub fn parse_catalog_id(raw: &str) -> CatalogTrackId {
    let s = raw.trim();
    if s.is_empty() {
        return CatalogTrackId {
            provider: PROVIDER_NONE.to_string(),
            id: String::new(),
        };
    }
    if let Some((provider, id)) = s.split_once(':') {
        let p = provider.trim();
        let i = id.trim();
        if !p.is_empty() && !i.is_empty() {
            return CatalogTrackId {
                provider: p.to_string(),
                id: i.to_string(),
            };
        }
    }
    // 无冒号格式 → 未知来源，使用原始字符串作为 id
    CatalogTrackId {
        provider: PROVIDER_NONE.to_string(),
        id: s.to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogTrackId {
    pub provider: String,
    pub id: String,
}

impl CatalogTrackId {
    pub fn new(provider: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            id: id.into(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.id.trim().is_empty()
    }

    /// 写入 API / 队列：带 provider 前缀，便于多源共存。
    pub fn to_api_string(&self) -> String {
        if self.provider.is_empty() || self.provider == PROVIDER_NONE {
            return self.id.clone();
        }
        format!("{}:{}", self.provider, self.id)
    }

    /// 试听缓存文件名安全段（仅 ASCII 字母数字与下划线）。
    pub fn cache_key(&self) -> String {
        let raw = format!("{}_{}", self.provider, self.id);
        let safe: String = raw
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        if safe.is_empty() {
            "unknown".to_string()
        } else {
            safe
        }
    }
}
