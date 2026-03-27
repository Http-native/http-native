use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestInput {
    pub version: u32,
    pub server_config: Option<HttpServerConfigInput>,
    pub middlewares: Vec<MiddlewareInput>,
    pub routes: Vec<RouteInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpServerConfigInput {
    pub default_host: Option<String>,
    pub default_backlog: Option<i32>,
    pub max_header_bytes: Option<usize>,
    pub hot_get_root_http11: Option<String>,
    pub hot_get_root_http10: Option<String>,
    pub header_connection_prefix: Option<String>,
    pub header_content_length_prefix: Option<String>,
    pub header_transfer_encoding_prefix: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiddlewareInput {
    pub path_prefix: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteInput {
    pub method: String,
    pub path: String,
    pub handler_id: u32,
    pub handler_source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRequest {
    pub handler_id: u32,
    pub method: String,
    pub path: String,
    pub url: String,
    pub params: HashMap<String, String>,
    pub query: Value,
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body_base64: String,
}
