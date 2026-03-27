use anyhow::Result;
use bytes::Bytes;
use std::collections::HashMap;

use crate::analyzer::{
    analyze_route, normalize_path, parse_segments, AnalysisResult, RouteSegment,
};
use crate::manifest::ManifestInput;

#[derive(Clone)]
pub struct Router {
    exact_get_root: Option<ExactStaticRoute>,
    dynamic_routes: Vec<Route>,
    exact_static_routes: HashMap<MethodKey, HashMap<Box<[u8]>, ExactStaticRoute>>,
}

#[derive(Clone)]
struct Route {
    method: String,
    segments: Vec<RouteSegment>,
    handler_id: u32,
}

#[derive(Clone)]
pub struct ExactStaticRoute {
    pub close_response: Bytes,
    pub keep_alive_response: Bytes,
}

#[derive(Clone)]
pub struct MatchedRoute {
    pub handler_id: u32,
    pub params: HashMap<String, String>,
}

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
enum MethodKey {
    Delete,
    Get,
    Head,
    Options,
    Patch,
    Post,
    Put,
}

impl Router {
    pub fn from_manifest(manifest: &ManifestInput) -> Result<Self> {
        let mut exact_get_root = None;
        let mut dynamic_routes = Vec::with_capacity(manifest.routes.len());
        let mut exact_static_routes = HashMap::new();

        for route in &manifest.routes {
            let method = route.method.to_uppercase();
            let path = normalize_path(route.path.as_str());
            let segments = parse_segments(path.as_str());
            if let AnalysisResult::ExactNativeStaticHot(spec) = analyze_route(route, &manifest.middlewares)
            {
                let Some(method_key) = MethodKey::from_method_str(method.as_str()) else {
                    continue;
                };

                let exact_route = ExactStaticRoute {
                    close_response: Bytes::from(build_close_response(
                        spec.status,
                        &spec.headers,
                        &spec.body,
                    )),
                    keep_alive_response: Bytes::from(build_keep_alive_response(
                        spec.status,
                        &spec.headers,
                        &spec.body,
                    )),
                };

                if method_key == MethodKey::Get && path == "/" {
                    exact_get_root = Some(exact_route);
                    continue;
                }

                exact_static_routes
                    .entry(method_key)
                    .or_insert_with(HashMap::new)
                    .insert(Box::<[u8]>::from(path.as_bytes()), exact_route);
                continue;
            }

            dynamic_routes.push(Route {
                method,
                segments,
                handler_id: route.handler_id,
            });
        }

        Ok(Self {
            exact_get_root,
            dynamic_routes,
            exact_static_routes,
        })
    }

    pub fn match_route(&self, method: &str, path: &str) -> Option<MatchedRoute> {
        let path_segments = split_path(path);

        for route in &self.dynamic_routes {
            if route.method != method {
                continue;
            }

            if route.segments.len() != path_segments.len() {
                continue;
            }

            let mut params = HashMap::new();
            let mut matched = true;

            for (segment, path_segment) in route.segments.iter().zip(path_segments.iter()) {
                match segment {
                    RouteSegment::Static(value) if value == path_segment => {}
                    RouteSegment::Static(_) => {
                        matched = false;
                        break;
                    }
                    RouteSegment::Param(name) => {
                        params.insert(name.clone(), path_segment.clone());
                    }
                }
            }

            if matched {
                return Some(MatchedRoute {
                    handler_id: route.handler_id,
                    params,
                });
            }
        }

        None
    }

    pub fn exact_static_route(&self, method: &[u8], path: &[u8]) -> Option<&ExactStaticRoute> {
        if method == b"GET" && path == b"/" {
            return self.exact_get_root.as_ref();
        }

        let method_key = MethodKey::from_method_bytes(method)?;
        self.exact_static_routes
            .get(&method_key)
            .and_then(|routes| routes.get(path))
    }

    pub fn exact_get_root(&self) -> Option<&ExactStaticRoute> {
        self.exact_get_root.as_ref()
    }
}

impl MethodKey {
    fn from_method_str(method: &str) -> Option<Self> {
        match method {
            "DELETE" => Some(Self::Delete),
            "GET" => Some(Self::Get),
            "HEAD" => Some(Self::Head),
            "OPTIONS" => Some(Self::Options),
            "PATCH" => Some(Self::Patch),
            "POST" => Some(Self::Post),
            "PUT" => Some(Self::Put),
            _ => None,
        }
    }

    fn from_method_bytes(method: &[u8]) -> Option<Self> {
        match method {
            b"DELETE" => Some(Self::Delete),
            b"GET" => Some(Self::Get),
            b"HEAD" => Some(Self::Head),
            b"OPTIONS" => Some(Self::Options),
            b"PATCH" => Some(Self::Patch),
            b"POST" => Some(Self::Post),
            b"PUT" => Some(Self::Put),
            _ => None,
        }
    }
}

fn split_path(path: &str) -> Vec<String> {
    if path == "/" {
        return Vec::new();
    }

    normalize_path(path)
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn build_keep_alive_response(status: u16, headers: &HashMap<String, String>, body: &[u8]) -> Vec<u8> {
    build_response_bytes(status, headers, body, true)
}

fn build_close_response(status: u16, headers: &HashMap<String, String>, body: &[u8]) -> Vec<u8> {
    build_response_bytes(status, headers, body, false)
}

fn build_response_bytes(
    status: u16,
    headers: &HashMap<String, String>,
    body: &[u8],
    keep_alive: bool,
) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {} {}\r\ncontent-length: {}\r\nconnection: {}\r\n",
        status,
        status_reason(status),
        body.len(),
        if keep_alive { "keep-alive" } else { "close" }
    )
    .into_bytes();

    for (name, value) in headers {
        response.extend_from_slice(name.as_bytes());
        response.extend_from_slice(b": ");
        response.extend_from_slice(value.as_bytes());
        response.extend_from_slice(b"\r\n");
    }

    response.extend_from_slice(b"\r\n");
    response.extend_from_slice(body);
    response
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "OK",
    }
}
