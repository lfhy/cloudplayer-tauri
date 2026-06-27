mod id;
mod provider;
pub mod providers;
mod service;
mod types;

pub use id::{parse_catalog_id, CatalogTrackId, PROVIDER_NONE};
pub use provider::MusicCatalogProvider;
pub use providers::GequhaiProvider;
pub use service::CatalogService;
pub use types::SearchResultDto;
