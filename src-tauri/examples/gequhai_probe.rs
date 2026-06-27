//! 自检 gequhai 搜索 + 试听 API。
use cloudplayer_tauri_lib::music_catalog::{CatalogTrackId, GequhaiProvider, MusicCatalogProvider};

#[tokio::main]
async fn main() {
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .expect("client");
    let p = GequhaiProvider::new();
    let page = p.search(&client, "七里香 周杰伦", 1).await.expect("search");
    println!("search results: {}", page.results.len());
    let first = page.results.first().expect("no results");
    println!("first: {} - {} id={}", first.title, first.artist, first.source_id);
    let bare = first.source_id.split(':').nth(1).unwrap_or(&first.source_id);
    let tid = CatalogTrackId::new("gequhai", bare);
    let url = p.fetch_preview_url(&client, &tid).await.expect("preview");
    println!("preview url: {:?}", url);
}
