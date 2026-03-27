mod analyzer;
mod manifest;
mod router;

use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use memchr::{memchr, memmem};
use monoio::io::{AsyncReadRent, AsyncWriteRent, AsyncWriteRentExt};
use monoio::net::{ListenerOpts, TcpListener, TcpStream};
use napi::bindgen_prelude::{Buffer, Function, Promise};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Error, Status};
use napi_derive::napi;
use std::borrow::Cow;
use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use crate::manifest::{HttpServerConfigInput, ManifestInput};
use crate::router::{ExactStaticRoute, MatchedRoute, Router};

const FALLBACK_DEFAULT_HOST: &str = "127.0.0.1";
const FALLBACK_DEFAULT_BACKLOG: i32 = 2048;
const FALLBACK_MAX_HEADER_BYTES: usize = 16 * 1024;
const FALLBACK_HOT_GET_ROOT_HTTP11: &str = "GET / HTTP/1.1\r\n";
const FALLBACK_HOT_GET_ROOT_HTTP10: &str = "GET / HTTP/1.0\r\n";
const FALLBACK_HEADER_CONNECTION_PREFIX: &str = "connection:";
const FALLBACK_HEADER_CONTENT_LENGTH_PREFIX: &str = "content-length:";
const FALLBACK_HEADER_TRANSFER_ENCODING_PREFIX: &str = "transfer-encoding:";
const BRIDGE_VERSION: u8 = 1;
const REQUEST_FLAG_QUERY_PRESENT: u16 = 1 << 0;
const NOT_FOUND_BODY: &[u8] = br#"{"error":"Route not found"}"#;

type DispatchTsfn = ThreadsafeFunction<Buffer, Promise<Buffer>, Buffer, Status, false, false, 0>;

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
            return Err(anyhow!(
                "serverConfig.defaultBacklog must be greater than 0"
            ));
        }

        if max_header_bytes == 0 {
            return Err(anyhow!(
                "serverConfig.maxHeaderBytes must be greater than 0"
            ));
        }

        Ok(Self {
            default_host: config_string(
                input,
                |config| config.default_host.as_deref(),
                FALLBACK_DEFAULT_HOST,
            ),
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

struct ShutdownHandle {
    flag: Arc<AtomicBool>,
    wake_addrs: Vec<SocketAddr>,
}

#[napi]
pub struct NativeServerHandle {
    host: String,
    port: u32,
    url: String,
    shutdown: Mutex<Option<ShutdownHandle>>,
    closed: Mutex<Option<Vec<mpsc::Receiver<()>>>>,
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
        if let Some(shutdown) = self
            .shutdown
            .lock()
            .expect("shutdown mutex poisoned")
            .take()
        {
            shutdown.flag.store(true, Ordering::SeqCst);
            for wake_addr in shutdown.wake_addrs {
                let _ = std::net::TcpStream::connect(wake_addr);
            }
        }

        if let Some(receivers) = self.closed.lock().expect("closed mutex poisoned").take() {
            for receiver in receivers {
                let _ = receiver.recv();
            }
        }

        Ok(())
    }
}

#[napi]
pub fn start_server(
    manifest_json: String,
    dispatcher: Function<'_, Buffer, Promise<Buffer>>,
    options: NativeListenOptions,
) -> napi::Result<NativeServerHandle> {
    let manifest: ManifestInput = serde_json::from_str(&manifest_json).map_err(to_napi_error)?;
    validate_manifest(&manifest).map_err(to_napi_error)?;
    let server_config =
        Arc::new(HttpServerConfig::from_manifest(&manifest).map_err(to_napi_error)?);
    let router = Arc::new(Router::from_manifest(&manifest).map_err(to_napi_error)?);

    let callback: DispatchTsfn = dispatcher
        .build_threadsafe_function::<Buffer>()
        .build()
        .map_err(to_napi_error)?;
    let dispatcher = Arc::new(JsDispatcher { callback });

    let worker_count = worker_count_for(&options);
    let (startup_tx, startup_rx) = mpsc::sync_channel::<Result<SocketAddr, String>>(worker_count);
    let shutdown_flag = Arc::new(AtomicBool::new(false));
    let mut closed_receivers = Vec::with_capacity(worker_count);

    for _ in 0..worker_count {
        let (closed_tx, closed_rx) = mpsc::channel::<()>();
        closed_receivers.push(closed_rx);

        let thread_router = Arc::clone(&router);
        let thread_dispatcher = Arc::clone(&dispatcher);
        let thread_config = Arc::clone(&server_config);
        let thread_shutdown = Arc::clone(&shutdown_flag);
        let thread_options = NativeListenOptions {
            host: options.host.clone(),
            port: options.port,
            backlog: options.backlog,
        };
        let thread_startup_tx = startup_tx.clone();

        std::thread::spawn(move || {
            let startup_tx_error = thread_startup_tx.clone();
            let result = (|| -> Result<()> {
                let mut runtime = monoio::RuntimeBuilder::<monoio::FusionDriver>::new()
                    .build()
                    .context("failed to build monoio runtime")?;

                runtime.block_on(async move {
                    let listener = bind_listener(&thread_options, thread_config.as_ref())
                        .context("failed to create monoio listener")?;
                    let local_addr = listener.local_addr()?;
                    let _ = thread_startup_tx.send(Ok(local_addr));
                    run_server(
                        listener,
                        thread_router,
                        thread_dispatcher,
                        thread_config,
                        thread_shutdown,
                    )
                    .await
                })
            })();

            if let Err(error) = &result {
                let _ = startup_tx_error.send(Err(error.to_string()));
                eprintln!("[http-native] native server error: {error:#}");
            }

            let _ = closed_tx.send(());
        });
    }

    let mut wake_addrs = Vec::with_capacity(worker_count);
    let mut local_addr = None;
    for _ in 0..worker_count {
        match startup_rx.recv() {
            Ok(Ok(addr)) => {
                if local_addr.is_none() {
                    local_addr = Some(addr);
                }
                wake_addrs.push(addr);
            }
            Ok(Err(message)) => {
                shutdown_flag.store(true, Ordering::SeqCst);
                for wake_addr in &wake_addrs {
                    let _ = std::net::TcpStream::connect(*wake_addr);
                }
                for receiver in closed_receivers {
                    let _ = receiver.recv();
                }
                return Err(Error::from_reason(message));
            }
            Err(_) => {
                shutdown_flag.store(true, Ordering::SeqCst);
                for wake_addr in &wake_addrs {
                    let _ = std::net::TcpStream::connect(*wake_addr);
                }
                for receiver in closed_receivers {
                    let _ = receiver.recv();
                }
                return Err(Error::from_reason(
                    "Native server exited before reporting readiness".to_string(),
                ));
            }
        }
    }

    let local_addr = local_addr.expect("worker count must be at least 1");

    let host = local_addr.ip().to_string();
    let port = local_addr.port() as u32;

    Ok(NativeServerHandle {
        host: host.clone(),
        port,
        url: format!("http://{host}:{port}"),
        shutdown: Mutex::new(Some(ShutdownHandle {
            flag: shutdown_flag,
            wake_addrs,
        })),
        closed: Mutex::new(Some(closed_receivers)),
    })
}

fn worker_count_for(options: &NativeListenOptions) -> usize {
    if options.port == 0 {
        return 1;
    }

    std::env::var("HTTP_NATIVE_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|count| *count > 0)
        .unwrap_or(1)
}

struct JsDispatcher {
    callback: DispatchTsfn,
}

impl JsDispatcher {
    async fn dispatch(&self, request: Buffer) -> Result<Buffer> {
        let response_json = self
            .callback
            .call_async(request)
            .await
            .map_err(|error| anyhow!(error.to_string()))?
            .await
            .map_err(|error| anyhow!(error.to_string()))?;

        Ok(response_json)
    }
}

async fn run_server(
    listener: TcpListener,
    router: Arc<Router>,
    dispatcher: Arc<JsDispatcher>,
    server_config: Arc<HttpServerConfig>,
    shutdown_flag: Arc<AtomicBool>,
) -> Result<()> {
    loop {
        if shutdown_flag.load(Ordering::Acquire) {
            break;
        }

        match listener.accept().await {
            Ok((stream, _)) => {
                if shutdown_flag.load(Ordering::Acquire) {
                    break;
                }

                if let Err(error) = stream.set_nodelay(true) {
                    eprintln!("[http-native] failed to enable TCP_NODELAY: {error}");
                }

                let router = Arc::clone(&router);
                let dispatcher = Arc::clone(&dispatcher);
                let server_config = Arc::clone(&server_config);

                monoio::spawn(async move {
                    if let Err(error) =
                        handle_connection(stream, router, dispatcher, server_config).await
                    {
                        eprintln!("[http-native] connection error: {error}");
                    }
                });
            }
            Err(error) => {
                if shutdown_flag.load(Ordering::Acquire) {
                    break;
                }

                eprintln!("[http-native] accept error: {error}");
            }
        }
    }

    Ok(())
}

async fn handle_connection(
    mut stream: TcpStream,
    router: Arc<Router>,
    dispatcher: Arc<JsDispatcher>,
    server_config: Arc<HttpServerConfig>,
) -> Result<()> {
    let mut buffer: Vec<u8> = Vec::with_capacity(8192);

    loop {
        let request_head = loop {
            let request_head = if router.exact_get_root().is_some() {
                parse_hot_root_request_head(&buffer, server_config.as_ref())
                    .or_else(|| parse_request_head(&buffer))
            } else {
                parse_request_head(&buffer)
            };

            if let Some(request_head) = request_head {
                break request_head;
            }

            if find_header_end(&buffer).is_some() {
                stream.shutdown().await?;
                return Ok(());
            }

            let (read_result, next_buffer) = stream.read(buffer).await;
            buffer = next_buffer;
            let bytes_read = read_result?;

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

        let header_bytes = request_head.header_bytes;
        let keep_alive = request_head.keep_alive;

        if let Some(static_route) =
            resolve_static_fast_path(&router, &request_head, server_config.as_ref())
        {
            drain_consumed_bytes(&mut buffer, header_bytes);
            write_exact_static_response(&mut stream, static_route, keep_alive).await?;

            if !keep_alive {
                stream.shutdown().await?;
                return Ok(());
            }

            continue;
        }

        let dispatch_request =
            build_manual_dispatch_request(&router, &buffer[..header_bytes], &request_head)?;
        drain_consumed_bytes(&mut buffer, header_bytes);

        match dispatch_request {
            Some(request) => {
                write_dynamic_dispatch_response(
                    &mut stream,
                    dispatcher.as_ref(),
                    request,
                    keep_alive,
                )
                .await?;
            }
            None => {
                write_not_found_response(&mut stream, keep_alive).await?;
            }
        }

        if !keep_alive {
            stream.shutdown().await?;
            return Ok(());
        }
    }
}

fn resolve_static_fast_path<'a>(
    router: &'a Router,
    request_head: &RequestHead<'_>,
    server_config: &HttpServerConfig,
) -> Option<&'a ExactStaticRoute> {
    if request_head.path == b"/"
        && request_head.method == b"GET"
        && parse_hot_root_request_head_prefix(request_head, server_config)
    {
        return router.exact_get_root();
    }

    router.exact_static_route(request_head.method, request_head.path)
}

fn parse_hot_root_request_head_prefix(
    request_head: &RequestHead<'_>,
    _server_config: &HttpServerConfig,
) -> bool {
    request_head.method == b"GET" && request_head.path == b"/"
}

fn drain_consumed_bytes(buffer: &mut Vec<u8>, consumed: usize) {
    if consumed >= buffer.len() {
        buffer.clear();
        return;
    }

    let remaining = buffer.len() - consumed;
    buffer.copy_within(consumed.., 0);
    buffer.truncate(remaining);
}

fn bind_listener(
    options: &NativeListenOptions,
    server_config: &HttpServerConfig,
) -> Result<TcpListener> {
    let host = options
        .host
        .as_deref()
        .unwrap_or(server_config.default_host.as_str());
    let bind_addr = resolve_socket_addr(host, options.port)
        .with_context(|| format!("failed to resolve bind address {host}:{}", options.port))?;
    let listener_opts = ListenerOpts::new()
        .reuse_addr(true)
        .reuse_port(true)
        .backlog(options.backlog.unwrap_or(server_config.default_backlog));

    TcpListener::bind_with_config(bind_addr, &listener_opts)
        .with_context(|| format!("failed to bind TCP listener on {bind_addr}"))
}

fn resolve_socket_addr(host: &str, port: u16) -> Result<SocketAddr> {
    (host, port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow!("unable to resolve {host}:{port}"))
}

fn validate_manifest(manifest: &ManifestInput) -> Result<()> {
    if manifest.version != 1 {
        return Err(anyhow!("Unsupported manifest version {}", manifest.version));
    }

    Ok(())
}

async fn write_exact_static_response(
    stream: &mut TcpStream,
    static_route: &ExactStaticRoute,
    keep_alive: bool,
) -> Result<()> {
    let response = if keep_alive {
        static_route.keep_alive_response.clone()
    } else {
        static_route.close_response.clone()
    };

    let (write_result, _) = stream.write_all(response).await;
    write_result?;
    Ok(())
}

#[derive(Clone)]
struct DispatchResponseEnvelope {
    status: u16,
    headers: Vec<(String, String)>,
    body: Bytes,
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

fn build_manual_dispatch_request(
    router: &Router,
    request_bytes: &[u8],
    request_head: &RequestHead<'_>,
) -> Result<Option<Buffer>> {
    let Some(method_code) = method_code_from_bytes(request_head.method) else {
        return Ok(None);
    };

    let path = match std::str::from_utf8(request_head.path) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    let url = match std::str::from_utf8(request_head.target) {
        Ok(url) => url,
        Err(_) => return Ok(None),
    };
    let normalized_path = normalize_runtime_path(path);
    let Some(matched_route) = router.match_route(method_code, normalized_path.as_ref()) else {
        return Ok(None);
    };

    let header_entries = if matched_route.full_headers || !matched_route.header_keys.is_empty() {
        parse_request_header_pairs(request_bytes)?
    } else {
        Vec::new()
    };
    build_dispatch_request_from_pairs(&matched_route, method_code, path, url, &header_entries)
        .map(Some)
}

fn build_dispatch_request_from_pairs(
    matched_route: &MatchedRoute<'_, '_>,
    method_code: u8,
    path: &str,
    url: &str,
    header_entries: &[(&str, &str)],
) -> Result<Buffer> {
    let url_bytes = url.as_bytes();
    let path_bytes = path.as_bytes();
    let flags = if url.contains('?') {
        REQUEST_FLAG_QUERY_PRESENT
    } else {
        0
    };

    if url_bytes.len() > u32::MAX as usize {
        return Err(anyhow!("request url too large"));
    }
    if path_bytes.len() > u16::MAX as usize {
        return Err(anyhow!("request path too large"));
    }
    if matched_route.param_values.len() > u16::MAX as usize {
        return Err(anyhow!("too many params"));
    }
    let selected_headers = select_header_entries(header_entries, matched_route);
    if selected_headers.len() > u16::MAX as usize {
        return Err(anyhow!("too many headers"));
    }

    let mut frame =
        Vec::with_capacity(16 + url_bytes.len() + path_bytes.len() + selected_headers.len() * 16);
    frame.push(BRIDGE_VERSION);
    frame.push(method_code);
    push_u16(&mut frame, flags);
    push_u32(&mut frame, matched_route.handler_id);
    push_u32(&mut frame, url_bytes.len() as u32);
    push_u16(&mut frame, path_bytes.len() as u16);
    push_u16(&mut frame, matched_route.param_values.len() as u16);
    push_u16(&mut frame, selected_headers.len() as u16);
    frame.extend_from_slice(url_bytes);
    frame.extend_from_slice(path_bytes);

    for value in matched_route.param_values.iter() {
        push_string_value(&mut frame, value)?;
    }

    for (name, value) in selected_headers {
        push_string_pair(&mut frame, name, value)?;
    }

    Ok(Buffer::from(frame))
}

fn select_header_entries<'a>(
    header_entries: &[(&'a str, &'a str)],
    matched_route: &MatchedRoute<'_, '_>,
) -> Vec<(&'a str, &'a str)> {
    if matched_route.full_headers {
        return header_entries.to_vec();
    }

    if matched_route.header_keys.is_empty() {
        return Vec::new();
    }

    let mut selected = Vec::with_capacity(matched_route.header_keys.len());
    for (name, value) in header_entries {
        if matched_route
            .header_keys
            .iter()
            .any(|target| target.as_ref().eq_ignore_ascii_case(name))
        {
            selected.push((*name, *value));
        }
    }

    selected
}

fn parse_dispatch_response(bytes: &[u8]) -> Result<DispatchResponseEnvelope> {
    let mut offset = 0;
    let status = read_u16(bytes, &mut offset)?;
    let header_count = read_u16(bytes, &mut offset)? as usize;
    let body_length = read_u32(bytes, &mut offset)? as usize;

    let mut headers = Vec::with_capacity(header_count);
    for _ in 0..header_count {
        let name_length = read_u8(bytes, &mut offset)? as usize;
        let value_length = read_u16(bytes, &mut offset)? as usize;
        let name = read_utf8(bytes, &mut offset, name_length)?;
        let value = read_utf8(bytes, &mut offset, value_length)?;
        headers.push((name, value));
    }

    if offset + body_length > bytes.len() {
        return Err(anyhow!("response body truncated"));
    }

    let body = Bytes::copy_from_slice(&bytes[offset..offset + body_length]);
    Ok(DispatchResponseEnvelope {
        status,
        headers,
        body,
    })
}

fn parse_request_header_pairs(bytes: &[u8]) -> Result<Vec<(&str, &str)>> {
    let header_end = find_header_end(bytes).ok_or_else(|| anyhow!("request header incomplete"))?;
    let line_end =
        memmem::find(bytes, b"\r\n").ok_or_else(|| anyhow!("request line incomplete"))?;
    let mut line_start = line_end + 2;
    let mut headers = Vec::new();

    while line_start + 2 <= header_end {
        let next_end = memmem::find(&bytes[line_start..header_end + 2], b"\r\n")
            .ok_or_else(|| anyhow!("invalid header line"))?
            + line_start;

        if next_end == line_start {
            break;
        }

        let line = &bytes[line_start..next_end];
        let separator = memchr(b':', line).ok_or_else(|| anyhow!("invalid header separator"))?;
        let name = std::str::from_utf8(&line[..separator]).context("header name was not utf-8")?;
        let value = std::str::from_utf8(trim_ascii_spaces(&line[separator + 1..]))
            .context("header value was not utf-8")?;
        headers.push((name, value));
        line_start = next_end + 2;
    }

    Ok(headers)
}

async fn write_dynamic_dispatch_response(
    stream: &mut TcpStream,
    dispatcher: &JsDispatcher,
    request: Buffer,
    keep_alive: bool,
) -> Result<()> {
    let parsed = match dispatcher.dispatch(request).await {
        Ok(response) => match parse_dispatch_response(response.as_ref()) {
            Ok(parsed) => parsed,
            Err(error) => DispatchResponseEnvelope {
                status: 500,
                headers: vec![(
                    "content-type".to_string(),
                    "application/json; charset=utf-8".to_string(),
                )],
                body: Bytes::from(format!(
                    r#"{{"error":"Invalid response envelope","detail":"{}"}}"#,
                    escape_json(error.to_string().as_str())
                )),
            },
        },
        Err(error) => DispatchResponseEnvelope {
            status: 502,
            headers: vec![(
                "content-type".to_string(),
                "application/json; charset=utf-8".to_string(),
            )],
            body: Bytes::from(format!(
                r#"{{"error":"Dispatch failed","detail":"{}"}}"#,
                escape_json(error.to_string().as_str())
            )),
        },
    };

    let response_bytes = build_dispatch_response_bytes(parsed, keep_alive);
    let (write_result, _) = stream.write_all(response_bytes).await;
    write_result?;
    Ok(())
}

async fn write_not_found_response(stream: &mut TcpStream, keep_alive: bool) -> Result<()> {
    let response = build_response_bytes(
        404,
        &[(
            "content-type".to_string(),
            "application/json; charset=utf-8".to_string(),
        )],
        Bytes::from_static(NOT_FOUND_BODY),
        keep_alive,
    );
    let (write_result, _) = stream.write_all(response).await;
    write_result?;
    Ok(())
}

fn build_dispatch_response_bytes(response: DispatchResponseEnvelope, keep_alive: bool) -> Vec<u8> {
    build_response_bytes(
        response.status,
        &response.headers,
        response.body,
        keep_alive,
    )
}

fn build_response_bytes(
    status: u16,
    headers: &[(String, String)],
    body: Bytes,
    keep_alive: bool,
) -> Vec<u8> {
    let mut output = format!(
        "HTTP/1.1 {} {}\r\ncontent-length: {}\r\nconnection: {}\r\n",
        status,
        status_reason(status),
        body.len(),
        if keep_alive { "keep-alive" } else { "close" }
    )
    .into_bytes();

    for (name, value) in headers {
        if name.eq_ignore_ascii_case("content-length") || name.eq_ignore_ascii_case("connection") {
            continue;
        }

        output.extend_from_slice(name.as_bytes());
        output.extend_from_slice(b": ");
        output.extend_from_slice(value.as_bytes());
        output.extend_from_slice(b"\r\n");
    }

    output.extend_from_slice(b"\r\n");
    output.extend_from_slice(body.as_ref());
    output
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

fn push_string_pair(frame: &mut Vec<u8>, name: &str, value: &str) -> Result<()> {
    if name.len() > u8::MAX as usize {
        return Err(anyhow!("field name too long"));
    }
    if value.len() > u16::MAX as usize {
        return Err(anyhow!("field value too long"));
    }

    frame.push(name.len() as u8);
    push_u16(frame, value.len() as u16);
    frame.extend_from_slice(name.as_bytes());
    frame.extend_from_slice(value.as_bytes());
    Ok(())
}

fn push_string_value(frame: &mut Vec<u8>, value: &str) -> Result<()> {
    if value.len() > u16::MAX as usize {
        return Err(anyhow!("field value too long"));
    }

    push_u16(frame, value.len() as u16);
    frame.extend_from_slice(value.as_bytes());
    Ok(())
}

fn push_u16(frame: &mut Vec<u8>, value: u16) {
    frame.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(frame: &mut Vec<u8>, value: u32) {
    frame.extend_from_slice(&value.to_le_bytes());
}

fn read_u8(bytes: &[u8], offset: &mut usize) -> Result<u8> {
    if *offset + 1 > bytes.len() {
        return Err(anyhow!("response envelope truncated"));
    }

    let value = bytes[*offset];
    *offset += 1;
    Ok(value)
}

fn read_u16(bytes: &[u8], offset: &mut usize) -> Result<u16> {
    if *offset + 2 > bytes.len() {
        return Err(anyhow!("response envelope truncated"));
    }

    let value = u16::from_le_bytes([bytes[*offset], bytes[*offset + 1]]);
    *offset += 2;
    Ok(value)
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> Result<u32> {
    if *offset + 4 > bytes.len() {
        return Err(anyhow!("response envelope truncated"));
    }

    let value = u32::from_le_bytes([
        bytes[*offset],
        bytes[*offset + 1],
        bytes[*offset + 2],
        bytes[*offset + 3],
    ]);
    *offset += 4;
    Ok(value)
}

fn read_utf8(bytes: &[u8], offset: &mut usize, length: usize) -> Result<String> {
    if *offset + length > bytes.len() {
        return Err(anyhow!("response envelope truncated"));
    }

    let value = std::str::from_utf8(&bytes[*offset..*offset + length])
        .context("response envelope contained invalid utf-8")?
        .to_string();
    *offset += length;
    Ok(value)
}

struct RequestHead<'a> {
    method: &'a [u8],
    target: &'a [u8],
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
        let next_end = memmem::find(&bytes[line_start..header_end + 2], b"\r\n")? + line_start;

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
        target,
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
    let (request_line_len, keep_alive) =
        if bytes.starts_with(server_config.hot_get_root_http11.as_slice()) {
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
        let next_end = memmem::find(&bytes[line_start..header_end + 2], b"\r\n")? + line_start;

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
        target: b"/",
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

fn config_string(
    input: Option<&HttpServerConfigInput>,
    pick: impl Fn(&HttpServerConfigInput) -> Option<&str>,
    fallback: &str,
) -> String {
    input.and_then(pick).unwrap_or(fallback).to_string()
}

fn normalize_runtime_path(path: &str) -> Cow<'_, str> {
    if path == "/" || !path.ends_with('/') {
        return Cow::Borrowed(path);
    }

    Cow::Owned(crate::analyzer::normalize_path(path))
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
