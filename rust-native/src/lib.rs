mod analyzer;
mod manifest;
mod router;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use bytes::{Buf, Bytes, BytesMut};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use memchr::{memchr, memmem};
use napi::bindgen_prelude::{Function, Promise};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Error, Status};
use napi_derive::napi;
use serde_json::{Map, Value};
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::{mpsc, Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::manifest::{DispatchRequest, DispatchResponse, HttpServerConfigInput, ManifestInput};
use crate::router::{ExactStaticRoute, Router};

const FALLBACK_DEFAULT_HOST: &str = "127.0.0.1";
const FALLBACK_DEFAULT_BACKLOG: i32 = 2048;
const FALLBACK_MAX_HEADER_BYTES: usize = 16 * 1024;
const FALLBACK_HOT_GET_ROOT_HTTP11: &str = "GET / HTTP/1.1\r\n";
const FALLBACK_HOT_GET_ROOT_HTTP10: &str = "GET / HTTP/1.0\r\n";
const FALLBACK_HEADER_CONNECTION_PREFIX: &str = "connection:";
const FALLBACK_HEADER_CONTENT_LENGTH_PREFIX: &str = "content-length:";
const FALLBACK_HEADER_TRANSFER_ENCODING_PREFIX: &str = "transfer-encoding:";

type DispatchTsfn =
    ThreadsafeFunction<String, Promise<String>, String, Status, false, false, 0>;

#[derive(Clone)]
struct HttpServerConfig {
    default_host: String,
    default_backlog: i32,
    max_header_bytes: usize,
    hot_get_root_http11: Vec<u8>,
    hot_get_root_http10: Vec<u8>,
    header_connection_prefix: Vec<u8>,
    header_content_length_prefix: Vec<u8>,
    header_transfer_encoding_prefix: Vec<u8>,
}

impl HttpServerConfig {
    fn from_manifest(manifest: &ManifestInput) -> Result<Self> {
        let input = manifest.server_config.as_ref();
        let default_backlog = input
            .and_then(|config| config.default_backlog)
            .unwrap_or(FALLBACK_DEFAULT_BACKLOG);
        let max_header_bytes = input
            .and_then(|config| config.max_header_bytes)
            .unwrap_or(FALLBACK_MAX_HEADER_BYTES);

        if default_backlog <= 0 {
            return Err(anyhow!("serverConfig.defaultBacklog must be greater than 0"));
        }

        if max_header_bytes == 0 {
            return Err(anyhow!("serverConfig.maxHeaderBytes must be greater than 0"));
        }

        Ok(Self {
            default_host: config_string(input, |config| config.default_host.as_deref(), FALLBACK_DEFAULT_HOST),
            default_backlog,
            max_header_bytes,
            hot_get_root_http11: config_string(
                input,
                |config| config.hot_get_root_http11.as_deref(),
                FALLBACK_HOT_GET_ROOT_HTTP11,
            )
            .into_bytes(),
            hot_get_root_http10: config_string(
                input,
                |config| config.hot_get_root_http10.as_deref(),
                FALLBACK_HOT_GET_ROOT_HTTP10,
            )
            .into_bytes(),
            header_connection_prefix: config_string(
                input,
                |config| config.header_connection_prefix.as_deref(),
                FALLBACK_HEADER_CONNECTION_PREFIX,
            )
            .into_bytes(),
            header_content_length_prefix: config_string(
                input,
                |config| config.header_content_length_prefix.as_deref(),
                FALLBACK_HEADER_CONTENT_LENGTH_PREFIX,
            )
            .into_bytes(),
            header_transfer_encoding_prefix: config_string(
                input,
                |config| config.header_transfer_encoding_prefix.as_deref(),
                FALLBACK_HEADER_TRANSFER_ENCODING_PREFIX,
            )
            .into_bytes(),
        })
    }
}

#[napi(object)]
pub struct NativeListenOptions {
    pub host: Option<String>,
    pub port: u16,
    pub backlog: Option<i32>,
}

#[napi]
pub struct NativeServerHandle {
    host: String,
    port: u32,
    url: String,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    closed: Mutex<Option<mpsc::Receiver<()>>>,
}

#[napi]
impl NativeServerHandle {
    #[napi(getter)]
    pub fn host(&self) -> String {
        self.host.clone()
    }

    #[napi(getter)]
    pub fn port(&self) -> u32 {
        self.port
    }

    #[napi(getter)]
    pub fn url(&self) -> String {
        self.url.clone()
    }

    #[napi]
    pub fn close(&self) -> napi::Result<()> {
        if let Some(tx) = self.shutdown.lock().expect("shutdown mutex poisoned").take() {
            let _ = tx.send(());
        }

        if let Some(receiver) = self.closed.lock().expect("closed mutex poisoned").take() {
            let _ = receiver.recv();
        }

        Ok(())
    }
}

// No Drop impl — server stays alive until close() is explicitly called.
// This prevents Bun's GC from prematurely shutting down the server.

#[napi]
pub fn start_server(
    manifest_json: String,
    dispatcher: Function<'_, String, Promise<String>>,
    options: NativeListenOptions,
) -> napi::Result<NativeServerHandle> {
    let manifest: ManifestInput =
        serde_json::from_str(&manifest_json).map_err(to_napi_error)?;
    validate_manifest(&manifest).map_err(to_napi_error)?;
    let server_config = Arc::new(HttpServerConfig::from_manifest(&manifest).map_err(to_napi_error)?);
    let router = Arc::new(Router::from_manifest(&manifest).map_err(to_napi_error)?);

    let callback: DispatchTsfn = dispatcher
        .build_threadsafe_function::<String>()
        .build()
        .map_err(to_napi_error)?;
    let dispatcher = Arc::new(JsDispatcher { callback });

    let (startup_tx, startup_rx) = mpsc::sync_channel::<Result<SocketAddr, String>>(1);
    let (closed_tx, closed_rx) = mpsc::channel::<()>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4))
                .build()
                .context("failed to build Tokio runtime")?;

            runtime.block_on(run_server(
                router,
                dispatcher,
                server_config,
                options,
                shutdown_rx,
                startup_tx,
            ))
        })();

        if let Err(error) = &result {
            eprintln!("[http-native] native server error: {error:#}");
        }

        let _ = closed_tx.send(());
    });

    let local_addr = match startup_rx.recv() {
        Ok(Ok(addr)) => addr,
        Ok(Err(message)) => return Err(Error::from_reason(message)),
        Err(_) => {
            return Err(Error::from_reason(
                "Native server exited before reporting readiness".to_string(),
            ))
        }
    };

    let host = local_addr.ip().to_string();
    let port = local_addr.port() as u32;

    Ok(NativeServerHandle {
        host: host.clone(),
        port,
        url: format!("http://{host}:{port}"),
        shutdown: Mutex::new(Some(shutdown_tx)),
        closed: Mutex::new(Some(closed_rx)),
    })
}

struct JsDispatcher {
    callback: DispatchTsfn,
}

impl JsDispatcher {
    async fn dispatch(&self, request: DispatchRequest) -> Result<DispatchResponse> {
        let payload = serde_json::to_string(&request)?;
        let response_json = self
            .callback
            .call_async(payload)
            .await
            .map_err(|error| anyhow!(error.to_string()))?
            .await
            .map_err(|error| anyhow!(error.to_string()))?;

        Ok(serde_json::from_str(&response_json)?)
    }
}

async fn run_server(
    router: Arc<Router>,
    dispatcher: Arc<JsDispatcher>,
    server_config: Arc<HttpServerConfig>,
    options: NativeListenOptions,
    mut shutdown_rx: oneshot::Receiver<()>,
    startup_tx: mpsc::SyncSender<Result<SocketAddr, String>>,
) -> Result<()> {
    let listener = bind_listener(&options, server_config.as_ref())?;
    let local_addr = listener.local_addr()?;
    let _ = startup_tx.send(Ok(local_addr));

    loop {
        tokio::select! {
            _ = &mut shutdown_rx => {
                break;
            }
            accept_result = listener.accept() => {
                let (stream, _) = match accept_result {
                    Ok(pair) => pair,
                    Err(error) => {
                        eprintln!("[http-native] accept error: {error}");
                        continue;
                    }
                };

                if let Err(error) = stream.set_nodelay(true) {
                    eprintln!("[http-native] failed to enable TCP_NODELAY: {error}");
                }

                let router = Arc::clone(&router);
                let dispatcher = Arc::clone(&dispatcher);
                let server_config = Arc::clone(&server_config);

                tokio::spawn(async move {
                    if let Err(error) = handle_connection(stream, router, dispatcher, server_config).await {
                        eprintln!("[http-native] connection error: {error}");
                    }
                });
            }
        }
    }

    Ok(())
}

async fn handle_request(
    request: Request<Incoming>,
    router: Arc<Router>,
    dispatcher: Arc<JsDispatcher>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let url = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| path.clone());
    let query = parse_query(request.uri().query());

    let Some(matched_route) = router.match_route(&method, &path) else {
        return Ok(build_response(
            StatusCode::NOT_FOUND,
            &[("content-type", "application/json; charset=utf-8")],
            Bytes::from_static(br#"{"error":"Route not found"}"#),
        ));
    };

    let (parts, body) = request.into_parts();
    let _ = body.collect().await;

    let dispatch_request = DispatchRequest {
        handler_id: matched_route.handler_id,
        method,
        path,
        url,
        params: matched_route.params,
        query,
        headers: extract_headers(&parts.headers),
    };

    match dispatcher.dispatch(dispatch_request).await {
        Ok(response) => Ok(build_dispatch_response(response)),
        Err(error) => Ok(build_response(
            StatusCode::BAD_GATEWAY,
            &[("content-type", "application/json; charset=utf-8")],
            Bytes::from(format!(
                r#"{{"error":"Dispatch failed","detail":"{}"}}"#,
                escape_json(error.to_string().as_str())
            )),
        )),
    }
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    router: Arc<Router>,
    dispatcher: Arc<JsDispatcher>,
    server_config: Arc<HttpServerConfig>,
) -> Result<()> {
    if try_static_fast_path(&mut stream, router.as_ref(), server_config.as_ref()).await? {
        return Ok(());
    }

    let service = service_fn(move |request| {
        handle_request(
            request,
            Arc::clone(&router),
            Arc::clone(&dispatcher),
        )
    });

    let io = TokioIo::new(stream);
    http1::Builder::new()
        .keep_alive(true)
        .serve_connection(io, service)
        .await?;
    Ok(())
}

async fn try_static_fast_path(
    stream: &mut tokio::net::TcpStream,
    router: &Router,
    server_config: &HttpServerConfig,
) -> Result<bool> {
    let mut peek_buffer = [0_u8; 4096];
    let bytes_read = stream.peek(&mut peek_buffer).await?;
    if bytes_read == 0 {
        return Ok(false);
    }

    let request_bytes = &peek_buffer[..bytes_read];
    if let Some(static_route) = router.exact_get_root() {
        if let Some(request_head) = parse_hot_root_request_head(request_bytes, server_config) {
            discard_request_head(stream, request_head.header_bytes).await?;

            if !request_head.keep_alive {
                stream.write_all(static_route.close_response.as_ref()).await?;
                stream.shutdown().await?;
                return Ok(true);
            }

            stream
                .write_all(static_route.keep_alive_response.as_ref())
                .await?;
            serve_exact_get_root_connection(stream, static_route, server_config).await?;
            return Ok(true);
        }
    }

    let request_head = parse_request_head(request_bytes);

    let Some(request_head) = request_head else {
        return Ok(false);
    };

    if request_head.has_body {
        return Ok(false);
    }

    let Some(static_route) = router.exact_static_route(request_head.method, request_head.path) else {
        return Ok(false);
    };

    discard_request_head(stream, request_head.header_bytes).await?;

    if !request_head.keep_alive {
        stream.write_all(static_route.close_response.as_ref()).await?;
        stream.shutdown().await?;
        return Ok(true);
    }

    stream
        .write_all(static_route.keep_alive_response.as_ref())
        .await?;
    serve_exact_static_connection(stream, router, server_config).await?;
    Ok(true)
}

async fn serve_exact_get_root_connection(
    stream: &mut tokio::net::TcpStream,
    static_route: &ExactStaticRoute,
    server_config: &HttpServerConfig,
) -> Result<()> {
    let mut buffer = BytesMut::with_capacity(8192);

    loop {
        let request_head = loop {
            if let Some(request_head) = parse_hot_root_request_head(&buffer, server_config) {
                break request_head;
            }

            if find_header_end(&buffer).is_some() {
                stream.shutdown().await?;
                return Ok(());
            }

            let bytes_read = read_hot_bytes(stream, &mut buffer).await?;
            if bytes_read == 0 {
                return Ok(());
            }
            if buffer.len() > server_config.max_header_bytes {
                stream.shutdown().await?;
                return Ok(());
            }
        };

        let keep_alive = request_head.keep_alive;
        buffer.advance(request_head.header_bytes);
        if buffer.is_empty() {
            buffer.clear();
        }
        write_exact_static_response(stream, static_route, keep_alive).await?;

        if !keep_alive {
            stream.shutdown().await?;
            return Ok(());
        }
    }
}

async fn serve_exact_static_connection(
    stream: &mut tokio::net::TcpStream,
    router: &Router,
    server_config: &HttpServerConfig,
) -> Result<()> {
    let mut buffer = BytesMut::with_capacity(8192);

    loop {
        let request_head = loop {
            let request_head = if router.exact_get_root().is_some() {
                parse_hot_root_request_head(&buffer, server_config)
                    .or_else(|| parse_request_head(&buffer))
            } else {
                parse_request_head(&buffer)
            };

            if let Some(request_head) = request_head {
                break request_head;
            }

            let bytes_read = read_hot_bytes(stream, &mut buffer).await?;
            if bytes_read == 0 {
                return Ok(());
            }
            if buffer.len() > server_config.max_header_bytes {
                stream.shutdown().await?;
                return Ok(());
            }
        };

        if request_head.has_body {
            stream.shutdown().await?;
            return Ok(());
        }

        let Some(static_route) = router.exact_static_route(request_head.method, request_head.path) else {
            stream.shutdown().await?;
            return Ok(());
        };

        let keep_alive = request_head.keep_alive;
        buffer.advance(request_head.header_bytes);
        if buffer.is_empty() {
            buffer.clear();
        }
        write_exact_static_response(stream, static_route, keep_alive).await?;

        if !keep_alive {
            stream.shutdown().await?;
            return Ok(());
        }
    }
}

fn build_dispatch_response(response: DispatchResponse) -> Response<Full<Bytes>> {
    match base64::engine::general_purpose::STANDARD.decode(response.body_base64) {
        Ok(body) => build_response_map(response.status, &response.headers, Bytes::from(body)),
        Err(error) => build_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &[("content-type", "application/json; charset=utf-8")],
            Bytes::from(format!(
                r#"{{"error":"Invalid response body","detail":"{}"}}"#,
                escape_json(error.to_string().as_str())
            )),
        ),
    }
}

fn bind_listener(options: &NativeListenOptions, server_config: &HttpServerConfig) -> Result<TcpListener> {
    let host = options
        .host
        .as_deref()
        .unwrap_or(server_config.default_host.as_str());
    let bind_addr = resolve_socket_addr(host, options.port)
        .with_context(|| format!("failed to resolve bind address {host}:{}", options.port))?;

    let domain = if bind_addr.is_ipv4() {
        Domain::IPV4
    } else {
        Domain::IPV6
    };

    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))
        .context("failed to create TCP socket")?;
    let _ = socket.set_reuse_address(true);
    let _ = socket.set_reuse_port(true);
    socket
        .bind(&bind_addr.into())
        .with_context(|| format!("failed to bind TCP listener on {bind_addr}"))?;
    socket
        .listen(options.backlog.unwrap_or(server_config.default_backlog))
        .with_context(|| format!("failed to listen on {bind_addr}"))?;
    socket
        .set_nonblocking(true)
        .with_context(|| format!("failed to enable nonblocking mode on {bind_addr}"))?;

    TcpListener::from_std(socket.into()).with_context(|| {
        format!("failed to create Tokio listener for {bind_addr}")
    })
}

fn resolve_socket_addr(host: &str, port: u16) -> Result<SocketAddr> {
    (host, port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow!("unable to resolve {host}:{port}"))
}

fn validate_manifest(manifest: &ManifestInput) -> Result<()> {
    if manifest.version != 1 {
        return Err(anyhow!(
            "Unsupported manifest version {}",
            manifest.version
        ));
    }

    Ok(())
}

fn extract_headers(headers: &hyper::HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect()
}

fn parse_query(query: Option<&str>) -> Value {
    let mut map = Map::new();

    if let Some(query) = query {
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            let key = key.to_string();
            let value = Value::String(value.to_string());

            match map.remove(&key) {
                None => {
                    map.insert(key, value);
                }
                Some(existing) => {
                    let merged = match existing {
                        Value::Array(mut items) => {
                            items.push(value);
                            Value::Array(items)
                        }
                        previous => Value::Array(vec![previous, value]),
                    };

                    map.insert(key, merged);
                }
            }
        }
    }

    Value::Object(map)
}

async fn write_exact_static_response(
    stream: &mut tokio::net::TcpStream,
    static_route: &ExactStaticRoute,
    keep_alive: bool,
) -> Result<()> {
    if keep_alive {
        stream
            .write_all(static_route.keep_alive_response.as_ref())
            .await?;
        return Ok(());
    }

    stream.write_all(static_route.close_response.as_ref()).await?;
    Ok(())
}

async fn read_hot_bytes(
    stream: &mut tokio::net::TcpStream,
    buffer: &mut BytesMut,
) -> Result<usize> {
    buffer.reserve(2048);
    let bytes_read = stream.read_buf(buffer).await?;
    Ok(bytes_read)
}

struct RequestHead<'a> {
    method: &'a [u8],
    path: &'a [u8],
    keep_alive: bool,
    header_bytes: usize,
    has_body: bool,
}

fn parse_request_head(bytes: &[u8]) -> Option<RequestHead<'_>> {
    let header_end = find_header_end(bytes)?;
    let line_end = memmem::find(bytes, b"\r\n")?;
    let request_line = &bytes[..line_end];

    let first_space = memchr(b' ', request_line)?;
    let second_space = memchr(b' ', &request_line[first_space + 1..])? + first_space + 1;

    let method = &request_line[..first_space];
    let target = &request_line[first_space + 1..second_space];
    let version = &request_line[second_space + 1..];
    let path = target.split(|byte| *byte == b'?').next()?;

    let mut keep_alive = version.eq_ignore_ascii_case(b"HTTP/1.1");
    let mut has_body = false;
    let mut line_start = line_end + 2;

    while line_start + 2 <= header_end {
        let next_end = memmem::find(&bytes[line_start..header_end], b"\r\n")? + line_start;

        if next_end == line_start {
            break;
        }

        let line = &bytes[line_start..next_end];
        if line.len() >= 11 && line[..11].eq_ignore_ascii_case(b"connection:") {
            let value = &line[11..];
            if contains_ascii_case_insensitive(value, b"close") {
                keep_alive = false;
            }
            if contains_ascii_case_insensitive(value, b"keep-alive") {
                keep_alive = true;
            }
        }

        if line.len() >= 15 && line[..15].eq_ignore_ascii_case(b"content-length:") {
            let value = trim_ascii_spaces(&line[15..]);
            if value != b"0" {
                has_body = true;
            }
        }

        if line.len() >= 18 && line[..18].eq_ignore_ascii_case(b"transfer-encoding:") {
            let value = trim_ascii_spaces(&line[18..]);
            if !value.is_empty() && !value.eq_ignore_ascii_case(b"identity") {
                has_body = true;
            }
        }

        line_start = next_end + 2;
    }

    Some(RequestHead {
        method,
        path,
        keep_alive,
        header_bytes: header_end + 4,
        has_body,
    })
}

fn parse_hot_root_request_head(
    bytes: &[u8],
    server_config: &HttpServerConfig,
) -> Option<RequestHead<'static>> {
    let (request_line_len, keep_alive) = if bytes.starts_with(server_config.hot_get_root_http11.as_slice()) {
        (server_config.hot_get_root_http11.len(), true)
    } else if bytes.starts_with(server_config.hot_get_root_http10.as_slice()) {
        (server_config.hot_get_root_http10.len(), false)
    } else {
        return None;
    };

    let header_end = find_header_end(bytes)?;
    let mut keep_alive = keep_alive;
    let mut has_body = false;
    let mut line_start = request_line_len;

    while line_start <= header_end {
        let next_end = memmem::find(&bytes[line_start..header_end], b"\r\n")? + line_start;

        if next_end == line_start {
            break;
        }

        let line = &bytes[line_start..next_end];
        if line.len() >= server_config.header_connection_prefix.len()
            && line[..server_config.header_connection_prefix.len()]
                .eq_ignore_ascii_case(server_config.header_connection_prefix.as_slice())
        {
            let value = &line[server_config.header_connection_prefix.len()..];
            if contains_ascii_case_insensitive(value, b"close") {
                keep_alive = false;
            }
            if contains_ascii_case_insensitive(value, b"keep-alive") {
                keep_alive = true;
            }
        } else if line.len() >= server_config.header_content_length_prefix.len()
            && line[..server_config.header_content_length_prefix.len()]
                .eq_ignore_ascii_case(server_config.header_content_length_prefix.as_slice())
        {
            let value =
                trim_ascii_spaces(&line[server_config.header_content_length_prefix.len()..]);
            if value != b"0" {
                has_body = true;
            }
        } else if line.len() >= server_config.header_transfer_encoding_prefix.len()
            && line[..server_config.header_transfer_encoding_prefix.len()]
                .eq_ignore_ascii_case(server_config.header_transfer_encoding_prefix.as_slice())
        {
            let value =
                trim_ascii_spaces(&line[server_config.header_transfer_encoding_prefix.len()..]);
            if !value.is_empty() && !value.eq_ignore_ascii_case(b"identity") {
                has_body = true;
            }
        }

        line_start = next_end + 2;
    }

    Some(RequestHead {
        method: b"GET",
        path: b"/",
        keep_alive,
        header_bytes: header_end + 4,
        has_body,
    })
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    memmem::find(bytes, b"\r\n\r\n")
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }

    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

fn trim_ascii_spaces(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map(|index| index + 1)
        .unwrap_or(start);
    &bytes[start..end]
}

async fn discard_request_head(
    stream: &mut tokio::net::TcpStream,
    mut remaining: usize,
) -> Result<()> {
    let mut scratch = [0_u8; 4096];

    while remaining > 0 {
        let chunk_len = remaining.min(scratch.len());
        stream.read_exact(&mut scratch[..chunk_len]).await?;
        remaining -= chunk_len;
    }

    Ok(())
}

fn config_string(
    input: Option<&HttpServerConfigInput>,
    pick: impl Fn(&HttpServerConfigInput) -> Option<&str>,
    fallback: &str,
) -> String {
    input
        .and_then(|config| pick(config))
        .unwrap_or(fallback)
        .to_string()
}

fn build_response_map(
    status: u16,
    headers: &HashMap<String, String>,
    body: Bytes,
) -> Response<Full<Bytes>> {
    let mut builder = Response::builder().status(status);

    for (name, value) in headers {
        builder = builder.header(name, value);
    }

    builder.body(Full::new(body)).unwrap_or_else(|_| {
        Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header("content-type", "application/json; charset=utf-8")
            .body(Full::new(Bytes::from_static(
                br#"{"error":"Failed to build response"}"#,
            )))
            .expect("fallback response should build")
    })
}

fn build_response(
    status: StatusCode,
    headers: &[(&str, &str)],
    body: Bytes,
) -> Response<Full<Bytes>> {
    let mut builder = Response::builder().status(status);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }

    builder
        .body(Full::new(body))
        .expect("static response should build")
}

fn escape_json(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn to_napi_error<E>(error: E) -> Error
where
    E: std::fmt::Display,
{
    Error::from_reason(error.to_string())
}
