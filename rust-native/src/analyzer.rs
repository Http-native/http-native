use serde_json::Value;
use std::collections::HashMap;

use crate::manifest::{MiddlewareInput, RouteInput};

/// Optimize static stuff
/// Its not very fun but we don't need to call js again and again for
/// static responses, we can just return them from rust

#[derive(Clone)]
pub struct StaticResponseSpec {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

pub enum AnalysisResult {
    ExactStaticFastPath(StaticResponseSpec),
    Dynamic,
}

pub fn analyze_route(route: &RouteInput, middlewares: &[MiddlewareInput]) -> AnalysisResult {
    if route.method.as_str() != "GET" || route.path.contains(':') {
        return AnalysisResult::Dynamic;
    }

    if has_applicable_middleware(route.path.as_str(), middlewares) {
        return AnalysisResult::Dynamic;
    }

    let source = route.handler_source.as_str();
    if source.contains("await") {
        return AnalysisResult::Dynamic;
    }

    let body = trim_return_and_semicolon(extract_function_body(source));
    if body.is_empty() {
        return AnalysisResult::Dynamic;
    }

    if let Some((status, payload)) = parse_status_call(body, "json") {
        if let Some(spec) = build_json_response(status, payload) {
            return AnalysisResult::ExactStaticFastPath(spec);
        }
    }

    if let Some((status, payload)) = parse_status_call(body, "send") {
        if let Some(spec) = build_send_response(status, payload) {
            return AnalysisResult::ExactStaticFastPath(spec);
        }
    }

    if let Some(payload) = strip_call(body, "res.json(") {
        if let Some(spec) = build_json_response(200, payload) {
            return AnalysisResult::ExactStaticFastPath(spec);
        }
    }

    if let Some(payload) = strip_call(body, "res.send(") {
        if let Some(spec) = build_send_response(200, payload) {
            return AnalysisResult::ExactStaticFastPath(spec);
        }
    }

    AnalysisResult::Dynamic
}

pub fn normalize_path(path: &str) -> String {
    if path == "/" {
        return "/".to_string();
    }

    let trimmed = path.trim_end_matches('/');
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

pub fn parse_segments(path: &str) -> Vec<RouteSegment> {
    if path == "/" {
        return Vec::new();
    }

    normalize_path(path)
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            if segment.strip_prefix(':').is_some() {
                RouteSegment::Param(())
            } else {
                RouteSegment::Static(segment.to_string())
            }
        })
        .collect()
}

#[derive(Clone)]
pub enum RouteSegment {
    Static(String),
    Param(()),
}

fn has_applicable_middleware(route_path: &str, middlewares: &[MiddlewareInput]) -> bool {
    middlewares
        .iter()
        .any(|middleware| path_prefix_matches(middleware.path_prefix.as_str(), route_path))
}

fn path_prefix_matches(path_prefix: &str, request_path: &str) -> bool {
    if path_prefix == "/" {
        return true;
    }

    request_path == path_prefix || request_path.starts_with(format!("{path_prefix}/").as_str())
}

fn extract_function_body(source: &str) -> &str {
    if let Some(arrow_index) = source.find("=>") {
        let right = source[arrow_index + 2..].trim();
        if right.starts_with('{') && right.ends_with('}') {
            return right[1..right.len() - 1].trim();
        }

        return right.trim();
    }

    if let Some(block_start) = source.find('{') {
        if let Some(block_end) = source.rfind('}') {
            if block_end > block_start {
                return source[block_start + 1..block_end].trim();
            }
        }
    }

    source.trim()
}

fn trim_return_and_semicolon(body: &str) -> &str {
    let mut value = body.trim();
    if let Some(stripped) = value.strip_prefix("return ") {
        value = stripped.trim();
    }

    if let Some(stripped) = value.strip_suffix(';') {
        value = stripped.trim();
    }

    value
}

fn parse_status_call<'a>(body: &'a str, method: &str) -> Option<(u16, &'a str)> {
    let status_prefix = "res.status(";
    let suffix = format!(").{method}(");

    if !body.starts_with(status_prefix) || !body.ends_with(')') {
        return None;
    }

    let after_status = &body[status_prefix.len()..];
    let separator_index = after_status.find(suffix.as_str())?;
    let status = after_status[..separator_index].trim().parse::<u16>().ok()?;
    let payload_start = separator_index + suffix.len();
    let payload = &after_status[payload_start..after_status.len() - 1];
    Some((status, payload.trim()))
}

fn strip_call<'a>(body: &'a str, prefix: &str) -> Option<&'a str> {
    if !body.starts_with(prefix) || !body.ends_with(')') {
        return None;
    }

    Some(body[prefix.len()..body.len() - 1].trim())
}

fn build_json_response(status: u16, payload: &str) -> Option<StaticResponseSpec> {
    let value = parse_literal(payload)?;
    let body = serde_json::to_vec(&value).ok()?;
    let mut headers = HashMap::new();
    headers.insert(
        "content-type".to_string(),
        "application/json; charset=utf-8".to_string(),
    );

    Some(StaticResponseSpec {
        status,
        headers,
        body,
    })
}

fn build_send_response(status: u16, payload: &str) -> Option<StaticResponseSpec> {
    let value = parse_literal(payload)?;
    match value {
        Value::String(text) => {
            let mut headers = HashMap::new();
            headers.insert(
                "content-type".to_string(),
                "text/plain; charset=utf-8".to_string(),
            );

            Some(StaticResponseSpec {
                status,
                headers,
                body: text.into_bytes(),
            })
        }
        other => {
            let body = serde_json::to_vec(&other).ok()?;
            let mut headers = HashMap::new();
            headers.insert(
                "content-type".to_string(),
                "application/json; charset=utf-8".to_string(),
            );

            Some(StaticResponseSpec {
                status,
                headers,
                body,
            })
        }
    }
}

fn parse_literal(source: &str) -> Option<Value> {
    let normalized = normalize_js_literal(source);
    json5::from_str::<Value>(normalized.as_str()).ok()
}

fn normalize_js_literal(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut string_delimiter = None;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if let Some(delimiter) = string_delimiter {
            output.push(ch);
            if escaped {
                escaped = false;
                continue;
            }

            if ch == '\\' {
                escaped = true;
            } else if ch == delimiter {
                string_delimiter = None;
            }
            continue;
        }

        if matches!(ch, '"' | '\'' | '`') {
            string_delimiter = Some(ch);
            output.push(ch);
            continue;
        }

        if ch == '!' {
            if matches!(chars.peek(), Some('0')) {
                chars.next();
                output.push_str("true");
                continue;
            }

            if matches!(chars.peek(), Some('1')) {
                chars.next();
                output.push_str("false");
                continue;
            }
        }

        output.push(ch);
    }

    output
}
