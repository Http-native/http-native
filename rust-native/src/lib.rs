use anyhow::{Context, Result};
use bytes::Bytes;
use monoio::io::{AsyncReadExt, AsyncWriteExt};
use monoio::net::{TcpListener, TcpStream};
use monoio::utils::memmem;
use napi::bindgen_prelude::Buffer;
use std::borrow::Cow;
use std::collections::HashMap;
use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::thread;
use crate::router::{ExactStaticRoute, MatchedRoute, Router};
use crate::manifest::HttpServerConfigInput;

// ─── Constants & Limits ───────────────────────────────────────────────────────

const MAX_HEADERS: usize = 64;
const MAX_BODY_BYTES: usize = 1024 * 1024; // 1MB limit for safety
const REQUEST_FLAG_QUERY_PRESENT: u16 = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

pub type JsDispatcher = napi::threadsafe_function::ThreadsafeFunction<Buffer>;

#[derive(Clone, Debug)]
pub struct HttpServerConfig {
    pub default_host: String,
    pub default_backlog: i32,
    pub max_header_bytes: usize,
    pub hot_get_root_http11: Vec<u8>,
    pub hot_get_root_http10: Vec<u8>,
    pub header_connection_prefix: Vec<u8>,
    pub header_content_length_prefix: Vec<u8>,
    pub header_transfer_encoding_prefix: Vec<u8>,
}

pub struct ParsedRequest<'a> {
    method: &'a [u8],
    target: &'a [u8],
    path: &'a [u8],
    keep_alive: bool,
    header_bytes: usize,
    has_body: bool,
    content_length: Option<usize>,
    headers: Vec<(&'a str, &'a str)>,
}

// ─── Buffer Pooling ───────────────────────────────────────────────────────────
//
// Zero-allocation buffer management. Buffers are re-used across connections
// within the same thread to avoid expensive syscalls and allocator pressure.

thread_local! {
    static BUFFER_POOL: std::cell::RefCell<Vec<u8>> = std::cell::RefCell::new(Vec::with_capacity(65536));
}

fn acquire_buffer() -> Vec<u8> {
    BUFFER_POOL.with(|pool| {
        let mut b = pool.borrow_mut();
        if b.capacity() < 65536 {
            Vec::with_capacity(65536)
        } else {
            std::mem::take(&mut *b)
        }
    })
}

fn release_buffer(mut buf: Vec<u8>) {
    buf.clear();
    BUFFER_POOL.with(|pool| {
        *pool.borrow_mut() = buf;
    });
}

// ─── Server Entry Point ───────────────────────────────────────────────────────

pub fn start_server(
    manifest_json: String,
    handler: JsDispatcher,
    options: NativeListenOptions,
) -> Result<ServerHandle> {
    let manifest: crate::manifest::ManifestInput = serde_json::from_str(&manifest_json)?;
    let router = Arc::new(Router::from_manifest(&manifest)?);
    let dispatcher = Arc::new(handler);
    let server_config = Arc::new(HttpServerConfig::from_input(manifest.server_config.as_ref()));

    let worker_count = worker_count_for(&options);
    let mut workers = Vec::with_capacity(worker_count);

    for i in 0..worker_count {
        let router = Arc::clone(&router);
        let dispatcher = Arc::clone(&dispatcher);
        let server_config = Arc::clone(&server_config);
        let options = options.clone();

        let handle = thread::spawn(move || {
            let mut driver = monoio::RuntimeBuilder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();

            driver.block_on(async move {
                let listener = bind_listener(&options, &server_config)?;
                
                loop {
                    let (stream, _) = listener.accept().await?;
                    
                    if should_enable_nodelay() {
                        if let Err(error) = stream.set_nodelay(true) {
                            eprintln!("[http-native] failed to enable TCP_NODELAY: {error}");
                        }
                    }

                    let router = Arc::clone(&router);
                    let dispatcher = Arc::clone(&dispatcher);
                    let server_config = Arc::clone(&server_config);

                    monoio::spawn(async move {
                        if let Err(e) = handle_connection(stream, router, dispatcher, server_config).await {
                            eprintln!("[http-native] worker {i} connection error: {e}");
                        }
                    });
                }
            })
        });
        workers.push(handle);
    }

    Ok(ServerHandle { workers })
}

async fn handle_connection(
    mut stream: TcpStream,
    router: Arc<Router>,
    dispatcher: Arc<JsDispatcher>,
    server_config: Arc<HttpServerConfig>,
) -> Result<()> {
    let mut buffer = acquire_buffer();

    let result = handle_connection_inner(
        &mut stream,
        &mut buffer,
        &router,
        &dispatcher,
        &server_config,
    )
    .await;

    release_buffer(buffer);
    result
}

async fn handle_connection_inner(
    stream: &mut TcpStream,
    buffer: &mut Vec<u8>,
    router: &Router,
    dispatcher: &JsDispatcher,
    server_config: &HttpServerConfig,
) -> Result<()> {
    loop {
        // Try hot-path parsing first
        let parsed = loop {
            let result = if router.exact_get_root().is_some() {
                parse_hot_root_request(buffer, server_config)
                    .or_else(|| parse_request_httparse(buffer))
            } else {
                parse_request_httparse(buffer)
            };

            if let Some(parsed) = result {
                break parsed;
            }

            if find_header_end(buffer).is_some() {
                stream.shutdown().await?;
                return Ok(());
            }

            let owned_buf = std::mem::take(buffer);
            let (read_result, next_buffer) = stream.read(owned_buf).await;
            *buffer = next_buffer;
            let bytes_read = read_result?;

            if bytes_read == 0 {
                return Ok(());
            }

            if buffer.len() > server_config.max_header_bytes {
                let response = build_error_response_bytes(
                    431,
                    b"{\"error\":\"Request Header Fields Too Large\"}",
                    false,
                );
                let (write_result, _) = stream.write_all(response).await;
                write_result?;
                stream.shutdown().await?;
                return Ok(());
            }
        };

        let header_bytes = parsed.header_bytes;
        let keep_alive = parsed.keep_alive;
        let has_body = parsed.has_body;
        let content_length = parsed.content_length;

        // Extract owned copies from parsed (which borrows buffer) before we mutate buffer
        let method_owned: Vec<u8> = parsed.method.to_vec();
        let target_owned: Vec<u8> = parsed.target.to_vec();
        let path_owned: Vec<u8> = parsed.path.to_vec();
        let headers_owned: Vec<(String, String)> = parsed
            .headers
            .iter()
            .map(|(n, v)| (n.to_string(), v.to_string()))
            .collect();

        drop(parsed);

        // ── Fast path: static routes (GET /) ──
        if !has_body && method_owned == b"GET" {
            if path_owned == b"/" {
                if let Some(static_route) = router.exact_get_root() {
                    drain_consumed_bytes(buffer, header_bytes);
                    write_exact_static_response(stream, static_route, keep_alive).await?;
                    if !keep_alive {
                        stream.shutdown().await?;
                        return Ok(());
                    }
                    continue;
                }
            }
            if let Some(static_route) = router.exact_static_route(&method_owned, &path_owned) {
                drain_consumed_bytes(buffer, header_bytes);
                write_exact_static_response(stream, static_route, keep_alive).await?;
                if !keep_alive {
                    stream.shutdown().await?;
                    return Ok(());
                }
                continue;
            }
        }

        // ── Read request body if present ──────────────────────────────
        let body_bytes: Vec<u8> = if has_body {
            let cl = match content_length {
                Some(len) => len,
                None => {
                    let response = build_error_response_bytes(411, b"{\"error\":\"Length Required\"}", false);
                    let (write_result, _) = stream.write_all(response).await;
                    write_result?;
                    stream.shutdown().await?;
                    return Ok(());
                }
            };

            if cl > MAX_BODY_BYTES {
                let response = build_error_response_bytes(413, b"{\"error\":\"Payload Too Large\"}", false);
                let (write_result, _) = stream.write_all(response).await;
                write_result?;
                stream.shutdown().await?;
                return Ok(());
            }

            let already_in_buffer = if buffer.len() > header_bytes {
                buffer.len() - header_bytes
            } else {
                0
            };

            if already_in_buffer >= cl {
                let body = buffer[header_bytes..header_bytes + cl].to_vec();
                drain_consumed_bytes(buffer, header_bytes + cl);
                body
            } else {
                let mut body = Vec::with_capacity(cl);
                if already_in_buffer > 0 {
                    body.extend_from_slice(&buffer[header_bytes..]);
                }
                drain_consumed_bytes(buffer, buffer.len());

                while body.len() < cl {
                    let remaining = cl - body.len();
                    let chunk_buf = vec![0u8; remaining.min(65536)];
                    let (read_result, returned_buf) = stream.read(chunk_buf).await;
                    let bytes_read = read_result?;
                    if bytes_read == 0 {
                        return Ok(());
                    }
                    body.extend_from_slice(&returned_buf[..bytes_read]);
                }
                body.truncate(cl);
                body
            }
        } else {
            drain_consumed_bytes(buffer, header_bytes);
            Vec::new()
        };

        // ── Dynamic path: Bridge to JS ────
        let dispatch_request = build_dispatch_request_owned(
            router,
            &method_owned,
            &target_owned,
            &path_owned,
            &headers_owned,
            &body_bytes,
        )?;

        match dispatch_request {
            Some(request) => {
                write_dynamic_dispatch_response(stream, dispatcher, request, keep_alive).await?;
                if !keep_alive {
                    stream.shutdown().await?;
                    return Ok(());
                }
            }
            None => {
                write_not_found_response(stream, keep_alive).await?;
                if !keep_alive {
                    stream.shutdown().await?;
                    return Ok(());
                }
            }
        }
    }
}

// ─── Header Parsers ───────────────────────────────────────────────────────────

fn parse_request_httparse(bytes: &[u8]) -> Option<ParsedRequest<'_>> {
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut req = httparse::Request::new(&mut headers);

    match req.parse(bytes) {
        Ok(httparse::Status::Complete(header_len)) => {
            let method = req.method?;
            let target = req.path?;
            let path = target.split(|&b| b == b'?').next()?;
            
            let mut keep_alive = req.version == Some(1); // Default true for HTTP/1.1
            let mut content_length = None;
            let mut has_body = false;
            let mut parsed_headers = Vec::with_capacity(req.headers.len());

            for h in req.headers {
                let name = h.name.to_lowercase();
                let value_bytes = h.value;
                let value = std::str::from_utf8(value_bytes).ok()?;

                match name.as_str() {
                    "connection" => {
                        if contains_ascii_case_insensitive(value_bytes, b"close") {
                            keep_alive = false;
                        } else if contains_ascii_case_insensitive(value_bytes, b"keep-alive") {
                            keep_alive = true;
                        }
                    }
                    "content-length" => {
                        if let Ok(len) = value.trim().parse::<usize>() {
                            content_length = Some(len);
                            if len > 0 { has_body = true; }
                        }
                    }
                    "transfer-encoding" => {
                        if !value.eq_ignore_ascii_case("identity") {
                            has_body = true;
                        }
                    }
                    _ => {}
                }
                parsed_headers.push((h.name, value));
            }

            Some(ParsedRequest {
                method: method.as_bytes(),
                target: target.as_bytes(),
                path: path.as_bytes(),
                keep_alive,
                header_bytes: header_len,
                has_body,
                content_length,
                headers: parsed_headers,
            })
        }
        _ => None,
    }
}

fn parse_hot_root_request<'a>(
    bytes: &'a [u8],
    server_config: &HttpServerConfig,
) -> Option<ParsedRequest<'a>> {
    let (_, keep_alive) = if bytes.starts_with(server_config.hot_get_root_http11.as_slice()) {
        (server_config.hot_get_root_http11.len(), true)
    } else if bytes.starts_with(server_config.hot_get_root_http10.as_slice()) {
        (server_config.hot_get_root_http10.len(), false)
    } else {
        return None;
    };

    let header_end = find_header_end(bytes)?;
    // For hot path, we just verify it looks like a header block ending
    // but we use httparse for the actual details to be safe.
    parse_request_httparse(bytes)
}

// ─── Routing ──────────────────────────────────────────────────────────────────

#[allow(dead_code)]
fn resolve_static_fast_path<'a>(
    router: &'a Router,
    parsed: &ParsedRequest<'_>,
    _server_config: &HttpServerConfig,
) -> Option<&'a ExactStaticRoute> {
    if parsed.path == b"/" && parsed.method == b"GET" {
        return router.exact_get_root();
    }
    router.exact_static_route(parsed.method, parsed.path)
}

fn build_dispatch_request_owned(
    router: &Router,
    method: &[u8],
    target: &[u8],
    path: &[u8],
    headers: &[(String, String)],
    body: &[u8],
) -> Result<Option<Buffer>> {
    let Some(method_code) = method_code_from_bytes(method) else {
        return Ok(None);
    };

    let path_str = std::str::from_utf8(path).ok().context("Invalid UTF-8 path")?;
    let url_str = std::str::from_utf8(target).ok().context("Invalid UTF-8 URL")?;

    let normalized_path = normalize_runtime_path(path_str);
    if contains_path_traversal(&normalized_path) {
        return Ok(None);
    }

    let Some(matched_route) = router.match_route(method_code, normalized_path.as_ref()) else {
        return Ok(None);
    };

    let header_refs: Vec<(&str, &str)> = headers.iter().map(|(n, v)| (n.as_str(), v.as_str())).collect();
    build_dispatch_envelope(&matched_route, method_code, path_str, url_str, &header_refs, body).map(Some)
}

fn build_dispatch_envelope(
    matched_route: &MatchedRoute<'_, '_>,
    method_code: u8,
    path: &str,
    url: &str,
    header_entries: &[(&str, &str)],
    body: &[u8],
) -> Result<Buffer> {
    let url_bytes = url.as_bytes();
    let path_bytes = path.as_bytes();
    let mut flags: u16 = 0;
    if url.contains('?') {
        flags |= REQUEST_FLAG_QUERY_PRESENT;
    }

    let mut envelope = Vec::with_capacity(512 + body.len());
    envelope.push(1); // Version
    envelope.push(method_code);
    envelope.extend_from_slice(&(flags).to_le_bytes());
    envelope.extend_from_slice(&(matched_route.handler_id).to_le_bytes());

    write_usize(&mut envelope, url_bytes.len());
    envelope.extend_from_slice(url_bytes);

    write_usize(&mut envelope, path_bytes.len());
    envelope.extend_from_slice(path_bytes);

    write_usize(&mut envelope, matched_route.param_values.len());
    for val in &matched_route.param_values {
        write_usize(&mut envelope, val.len());
        envelope.extend_from_slice(val.as_bytes());
    }

    let header_count = matched_route.header_keys.len();
    write_usize(&mut envelope, header_count);

    for key_boxed in matched_route.header_keys {
        let key = key_boxed.as_ref();
        let mut found = false;
        for (h_name, h_value) in header_entries {
            if h_name.eq_ignore_ascii_case(key) {
                write_usize(&mut envelope, h_value.len());
                envelope.extend_from_slice(h_value.as_bytes());
                found = true;
                break;
            }
        }
        if !found {
            write_usize(&mut envelope, 0);
        }
    }

    // Body support
    write_usize(&mut envelope, body.len());
    envelope.extend_from_slice(body);

    Ok(Buffer::from(envelope))
}

// ─── Response Writing ─────────────────────────────────────────────────────────

async fn write_exact_static_response(
    stream: &mut TcpStream,
    route: &ExactStaticRoute,
    keep_alive: bool,
) -> Result<()> {
    let response = if keep_alive {
        &route.keep_alive_response
    } else {
        &route.close_response
    };
    let (res, _) = stream.write_all(response.clone()).await;
    res?;
    Ok(())
}

async fn write_dynamic_dispatch_response(
    stream: &mut TcpStream,
    dispatcher: &JsDispatcher,
    request_buffer: Buffer,
    keep_alive: bool,
) -> Result<()> {
    let result: Buffer = dispatcher.call_async(request_buffer).await
        .map_err(|e| anyhow::anyhow!("JS dispatch failed: {e}"))?;

    let (write_res, _) = stream.write_all(result).await;
    write_res?;

    Ok(())
}

async fn write_not_found_response(stream: &mut TcpStream, keep_alive: bool) -> Result<()> {
    let response = build_error_response_bytes(404, b"{\"error\":\"Not Found\"}", keep_alive);
    let (res, _) = stream.write_all(response).await;
    res?;
    Ok(())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn build_error_response_bytes(status: u16, body: &[u8], keep_alive: bool) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {} {}\r\ncontent-length: {}\r\ncontent-type: application/json\r\nconnection: {}\r\n\r\n",
        status,
        status_reason(status),
        body.len(),
        if keep_alive { "keep-alive" } else { "close" }
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

fn drain_consumed_bytes(buffer: &mut Vec<u8>, consumed: usize) {
    if consumed >= buffer.len() {
        buffer.clear();
    } else {
        buffer.drain(..consumed);
    }
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        411 => "Length Required",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

fn method_code_from_bytes(method: &[u8]) -> Option<u8> {
    match method {
        b"GET" => Some(1),
        b"POST" => Some(2),
        b"PUT" => Some(3),
        b"DELETE" => Some(4),
        b"PATCH" => Some(5),
        b"OPTIONS" => Some(6),
        b"HEAD" => Some(7),
        _ => None,
    }
}

fn write_usize(output: &mut Vec<u8>, value: usize) {
    output.extend_from_slice(&(value as u32).to_le_bytes());
}

fn normalize_runtime_path(path: &str) -> Cow<'_, str> {
    if path == "/" || !path.ends_with('/') {
        Cow::Borrowed(path)
    } else {
        Cow::Owned(path.trim_end_matches('/').to_string())
    }
}

fn contains_path_traversal(path: &str) -> bool {
    path.contains("/../") || path.contains("\\..\\") || path.ends_with("/..") || path.ends_with("\\..")
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    memmem::find(bytes, b"\r\n\r\n")
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w.eq_ignore_ascii_case(needle))
}

fn should_enable_nodelay() -> bool {
    std::env::var("HTTP_NATIVE_TCP_NODELAY")
        .ok()
        .map(|v| !matches!(v.trim().to_lowercase().as_str(), "0" | "false" | "off" | "no"))
        .unwrap_or(true)
}

fn bind_listener(options: &NativeListenOptions, config: &HttpServerConfig) -> Result<TcpListener> {
    let host = options.host.as_deref().unwrap_or(&config.default_host);
    let addr = (host, options.port).to_socket_addrs()?.next()
        .ok_or_else(|| anyhow::anyhow!("Failed to resolve address {host}:{}", options.port))?;

    let mut opts = monoio::net::ListenerOpts::new()
        .reuse_addr(true)
        .backlog(options.backlog.unwrap_or(config.default_backlog));
    
    if worker_count_for(options) > 1 {
        opts = opts.reuse_port(true);
    }

    TcpListener::bind_with_config(addr, &opts)
}

fn worker_count_for(options: &NativeListenOptions) -> usize {
    options.workers.unwrap_or_else(num_cpus::get)
}

// ─── NAPI Glue ────────────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Default)]
pub struct NativeListenOptions {
    pub host: Option<String>,
    pub port: u16,
    pub backlog: Option<i32>,
    pub workers: Option<usize>,
}

#[napi]
pub struct ServerHandle {
    workers: Vec<thread::JoinHandle<()>>,
}

#[napi]
impl ServerHandle {
    #[napi]
    pub fn close(&mut self) {
        // In a real implementation, we'd send a shutdown signal.
        // For now, we just let them drop or kill the process.
    }
}

impl HttpServerConfig {
    fn from_input(input: Option<&HttpServerConfigInput>) -> Self {
        Self {
            default_host: input.and_then(|i| i.default_host.clone()).unwrap_or_else(|| "127.0.0.1".to_string()),
            default_backlog: input.and_then(|i| i.default_backlog).unwrap_or(2048),
            max_header_bytes: input.and_then(|i| i.max_header_bytes).unwrap_or(8192),
            hot_get_root_http11: b"GET / HTTP/1.1\r\n".to_vec(),
            hot_get_root_http10: b"GET / HTTP/1.0\r\n".to_vec(),
            header_connection_prefix: b"connection:".to_vec(),
            header_content_length_prefix: b"content-length:".to_vec(),
            header_transfer_encoding_prefix: b"transfer-encoding:".to_vec(),
        }
    }
}
