//! 代理 IPC：`get_proxy_status` 返回启动期解析出的最终代理（带密码段遮蔽的 URL +
//! 来源标签），供设置页「代理」分组显示；`validate_proxy` 在保存前对用户输入做白名单 + 形态校验。
//!
//! 注意：当前进程内的 reqwest `Client` 在 setup 期已经创建；为避免在使用中切换导致
//! 跨客户端状态不一致，运行期代理 URL 仅写回 settings.json，**重启后** 真正生效。
//! 设置页 UI 会以「需要重启应用」的徽标提示用户。

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use super::AppState;

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct ValidateProxyIn {
    pub url: Option<String>,
}

/// 返回最终生效的代理（含来源、归一化 URL、scheme/host/port、no_proxy 等）。
#[tauri::command]
pub fn get_proxy_status(state: State<'_, Arc<AppState>>) -> crate::proxy::ProxyStatus {
    crate::proxy::status_from(&state.proxy)
}

/// 仅做形态校验（scheme 白名单 + 主机/端口必填）；不修改 settings.json。
#[tauri::command]
pub fn validate_proxy(in_: ValidateProxyIn) -> Result<(), String> {
    let url = in_.url.unwrap_or_default();
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    crate::proxy::parse_proxy_url(trimmed).map(|_| ())
}
