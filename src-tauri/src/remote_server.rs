use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, Request, State};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, HOST, WWW_AUTHENTICATE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

use crate::atomic_file::write_file_atomic;
use crate::database::{self, DbState};
use crate::embedded_terminal::{
    EmbeddedTerminalState, RemoteTerminalOutput, RemoteTerminalSnapshot,
    StartEmbeddedTerminalRequest,
};
use crate::remote_protocol::{
    ApiError, ApiSuccess, EditMessageMutation, RemoteAuthInfo, RemoteBootstrap, RemoteCapabilities,
    RemotePlatformInfo, RemoteTerminalInputRequest, RemoteTerminalResizeRequest,
    RemoteTerminalStartRequest, RemoteTerminalStopRequest, RestoreMessageMutation,
    REMOTE_API_PREFIX, REMOTE_PROTOCOL_VERSION,
};
use crate::session_service;
use crate::settings::AppSettings;

pub const DEFAULT_REMOTE_PORT: u16 = 7331;
const REQUEST_ID_HEADER: &str = "x-request-id";
const MAX_PAGE_SIZE: usize = 200;
const MAX_MUTATION_CONTENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_MUTATION_BODY_BYTES: usize = MAX_MUTATION_CONTENT_BYTES + 64 * 1024;
const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const REMOTE_SESSION_NOT_FOUND: &str = "REMOTE_SESSION_NOT_FOUND";
const REMOTE_MUTATION_UNSUPPORTED_PLATFORM: &str = "kiro-ide";

#[derive(Debug, Clone)]
pub struct RemoteServerConfig {
    pub bind_address: IpAddr,
    pub port: u16,
    pub enable_mutations: bool,
    pub enable_terminal: bool,
    pub require_auth: bool,
    pub access_token: Option<String>,
}

impl RemoteServerConfig {
    pub fn loopback_default() -> Self {
        Self {
            bind_address: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: DEFAULT_REMOTE_PORT,
            enable_mutations: false,
            enable_terminal: false,
            require_auth: false,
            access_token: None,
        }
    }

    #[cfg(test)]
    fn loopback_ephemeral() -> Self {
        Self {
            bind_address: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 0,
            enable_mutations: false,
            enable_terminal: false,
            require_auth: false,
            access_token: None,
        }
    }
}

#[derive(Clone)]
pub struct RemoteServerContext {
    pub db_path: String,
    pub settings: Arc<Mutex<AppSettings>>,
    pub server_id: String,
    pub server_name: String,
    pub server_version: String,
    pub web_root: Option<PathBuf>,
    pub mutation_enabled: bool,
    pub terminal_enabled: bool,
    pub mutation_lock: Arc<Mutex<()>>,
    pub auth_required: bool,
    pub access_token: Option<String>,
    pub terminal_state: EmbeddedTerminalState,
    pub app_handle: Option<tauri::AppHandle>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerStatus {
    pub running: bool,
    pub bind_address: String,
    pub port: u16,
    pub url: String,
    pub protocol_version: u16,
    pub read_only: bool,
    pub terminal_enabled: bool,
    pub auth_required: bool,
    pub lan_urls: Vec<String>,
    pub access_token: Option<String>,
    pub error: Option<String>,
}

impl Default for RemoteServerStatus {
    fn default() -> Self {
        Self {
            running: false,
            bind_address: Ipv4Addr::LOCALHOST.to_string(),
            port: DEFAULT_REMOTE_PORT,
            url: format!("http://{}:{DEFAULT_REMOTE_PORT}", Ipv4Addr::LOCALHOST),
            protocol_version: REMOTE_PROTOCOL_VERSION,
            read_only: true,
            terminal_enabled: false,
            auth_required: false,
            lan_urls: Vec::new(),
            access_token: None,
            error: None,
        }
    }
}

struct RemoteServerHandle {
    shutdown: Option<oneshot::Sender<()>>,
    thread: thread::JoinHandle<()>,
}

pub struct RemoteServerState {
    handle: Mutex<Option<RemoteServerHandle>>,
    status: Arc<Mutex<RemoteServerStatus>>,
}

impl Default for RemoteServerState {
    fn default() -> Self {
        Self {
            handle: Mutex::new(None),
            status: Arc::new(Mutex::new(RemoteServerStatus::default())),
        }
    }
}

impl RemoteServerState {
    pub fn start(
        &self,
        config: RemoteServerConfig,
        mut context: RemoteServerContext,
    ) -> Result<RemoteServerStatus, String> {
        if config.require_auth
            && config
                .access_token
                .as_deref()
                .is_none_or(|token| token.trim().len() < 32)
        {
            return Err(
                "remote authentication requires an access token of at least 32 characters"
                    .to_string(),
            );
        }
        let mut handle_guard = self
            .handle
            .lock()
            .map_err(|_| "failed to lock remote server handle".to_string())?;
        if handle_guard
            .as_ref()
            .is_some_and(|handle| !handle.thread.is_finished())
        {
            return Err("remote server is already running".to_string());
        }
        if let Some(mut finished) = handle_guard.take() {
            let _ = finished.shutdown.take().map(|sender| sender.send(()));
            let _ = finished.thread.join();
        }

        let requested_address = SocketAddr::new(config.bind_address, config.port);
        let listener = TcpListener::bind(requested_address).map_err(|error| {
            let message = format!("failed to bind remote server at {requested_address}: {error}");
            self.set_error(&config, message.clone());
            message
        })?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("failed to configure remote server socket: {error}"))?;
        let bound_address = listener
            .local_addr()
            .map_err(|error| format!("failed to read remote server address: {error}"))?;
        context.mutation_enabled = config.enable_mutations;
        context.terminal_enabled = config.enable_terminal;
        context.auth_required = config.require_auth;
        context.access_token = config.access_token.clone();
        let router = build_router(context, bound_address);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let lan_urls = if bound_address.ip().is_unspecified() {
            discover_lan_urls(bound_address.port())
        } else {
            Vec::new()
        };
        let status = RemoteServerStatus {
            running: true,
            bind_address: bound_address.ip().to_string(),
            port: bound_address.port(),
            url: if bound_address.ip().is_unspecified() {
                lan_urls
                    .first()
                    .cloned()
                    .unwrap_or_else(|| format_http_url(bound_address))
            } else {
                format_http_url(bound_address)
            },
            protocol_version: REMOTE_PROTOCOL_VERSION,
            read_only: !config.enable_mutations,
            terminal_enabled: config.enable_terminal,
            auth_required: config.require_auth,
            lan_urls,
            access_token: config
                .require_auth
                .then(|| config.access_token.clone())
                .flatten(),
            error: None,
        };
        self.replace_status(status.clone());

        let shared_status = Arc::clone(&self.status);
        let server_thread = thread::Builder::new()
            .name("memory-forge-remote".to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .worker_threads(2)
                    .thread_name("memory-forge-remote-worker")
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        record_server_exit(
                            &shared_status,
                            Some(format!("failed to create remote runtime: {error}")),
                        );
                        return;
                    }
                };

                let result = runtime.block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener)
                        .map_err(|error| format!("failed to adopt remote listener: {error}"))?;
                    axum::serve(listener, router)
                        .with_graceful_shutdown(async {
                            let _ = shutdown_rx.await;
                        })
                        .await
                        .map_err(|error| format!("remote server failed: {error}"))
                });
                record_server_exit(&shared_status, result.err());
            })
            .map_err(|error| {
                let message = format!("failed to start remote server thread: {error}");
                self.set_error(&config, message.clone());
                message
            })?;

        *handle_guard = Some(RemoteServerHandle {
            shutdown: Some(shutdown_tx),
            thread: server_thread,
        });
        Ok(self.status())
    }

    pub fn status(&self) -> RemoteServerStatus {
        self.status
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| RemoteServerStatus {
                error: Some("failed to lock remote server status".to_string()),
                ..RemoteServerStatus::default()
            })
    }

    pub fn stop(&self) -> Result<RemoteServerStatus, String> {
        let mut handle = self
            .handle
            .lock()
            .map_err(|_| "failed to lock remote server handle".to_string())?
            .take();
        if let Some(mut handle) = handle.take() {
            if let Some(shutdown) = handle.shutdown.take() {
                let _ = shutdown.send(());
            }
            handle
                .thread
                .join()
                .map_err(|_| "remote server thread panicked".to_string())?;
        }
        let mut status = self.status();
        status.running = false;
        self.replace_status(status.clone());
        Ok(status)
    }

    fn set_error(&self, config: &RemoteServerConfig, error: String) {
        self.replace_status(RemoteServerStatus {
            running: false,
            bind_address: config.bind_address.to_string(),
            port: config.port,
            url: format_http_url(SocketAddr::new(config.bind_address, config.port)),
            protocol_version: REMOTE_PROTOCOL_VERSION,
            read_only: true,
            terminal_enabled: config.enable_terminal,
            auth_required: config.require_auth,
            lan_urls: Vec::new(),
            access_token: config
                .require_auth
                .then(|| config.access_token.clone())
                .flatten(),
            error: Some(error),
        });
    }

    fn replace_status(&self, status: RemoteServerStatus) {
        if let Ok(mut current) = self.status.lock() {
            *current = status;
        }
    }
}

impl Drop for RemoteServerState {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub fn load_or_create_server_id(data_dir: &Path) -> Result<String, String> {
    let path = data_dir.join("remote-server-id");
    if path.exists() {
        let value = std::fs::read_to_string(&path)
            .map_err(|error| format!("failed to read remote server id: {error}"))?;
        let trimmed = value.trim();
        Uuid::parse_str(trimmed).map_err(|_| "remote server id file is invalid".to_string())?;
        return Ok(trimmed.to_string());
    }

    let server_id = Uuid::new_v4().to_string();
    write_file_atomic(&path, format!("{server_id}\n").as_bytes())
        .map_err(|error| format!("failed to persist remote server id: {error}"))?;
    Ok(server_id)
}

pub fn load_or_create_access_token(data_dir: &Path) -> Result<String, String> {
    let path = data_dir.join("remote-access-token");
    if path.exists() {
        restrict_access_token_permissions(&path)?;
        let value = std::fs::read_to_string(&path)
            .map_err(|error| format!("failed to read remote access token: {error}"))?;
        let trimmed = value.trim();
        if trimmed.len() != 64 || !trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("remote access token file is invalid".to_string());
        }
        return Ok(trimmed.to_string());
    }

    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    write_file_atomic(&path, format!("{token}\n").as_bytes())
        .map_err(|error| format!("failed to persist remote access token: {error}"))?;
    restrict_access_token_permissions(&path)?;
    Ok(token)
}

fn restrict_access_token_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to secure remote access token: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub fn local_server_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Memory Forge Host".to_string())
}

#[derive(Clone)]
struct RemoteAppState {
    context: RemoteServerContext,
}

#[derive(Clone)]
struct HostPolicy {
    allowed: Arc<HashSet<String>>,
    port: u16,
    allow_private_ip_hosts: bool,
}

#[derive(Clone)]
struct AuthPolicy {
    required: bool,
    token: Arc<str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    protocol_version: u16,
    server_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionListQuery {
    platform: String,
    q: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    show_archived: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionQuery {
    platform: String,
    session_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTerminalListQuery {
    device_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTerminalOutputQuery {
    device_id: String,
    cursor: Option<u64>,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RemoteMutationResult {
    mutation_id: String,
    applied: bool,
}

struct RemoteHttpError {
    status: StatusCode,
    body: ApiError,
}

impl IntoResponse for RemoteHttpError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

fn build_router(context: RemoteServerContext, address: SocketAddr) -> Router {
    let web_root = context
        .web_root
        .clone()
        .filter(|root| root.join("index.html").is_file());
    let app_state = RemoteAppState { context };
    let api = Router::new()
        .route("/bootstrap", get(bootstrap))
        .route("/dashboard", get(dashboard))
        .route("/sessions", get(session_list))
        .route("/session-detail", get(session_detail))
        .route("/edit-log", get(edit_log))
        .route("/mutations/session-edit", post(session_edit_mutation))
        .route("/mutations/session-restore", post(session_restore_mutation))
        .route("/terminals", get(terminal_list).post(terminal_start))
        .route(
            "/terminals/{terminal_id}",
            get(terminal_snapshot).delete(terminal_close),
        )
        .route("/terminals/{terminal_id}/output", get(terminal_output))
        .route("/terminals/{terminal_id}/input", post(terminal_input))
        .route("/terminals/{terminal_id}/resize", post(terminal_resize))
        .route("/terminals/{terminal_id}/stop", post(terminal_stop))
        .layer(DefaultBodyLimit::max(MAX_MUTATION_BODY_BYTES));
    let host_policy = HostPolicy {
        allowed: Arc::new(allowed_hosts(address)),
        port: address.port(),
        allow_private_ip_hosts: address.ip().is_unspecified(),
    };
    let auth_policy = AuthPolicy {
        required: app_state.context.auth_required,
        token: Arc::from(app_state.context.access_token.clone().unwrap_or_default()),
    };
    let request_id = HeaderName::from_static(REQUEST_ID_HEADER);
    let cors = CorsLayer::new()
        .allow_origin([
            HeaderValue::from_static("http://localhost:1430"),
            HeaderValue::from_static("http://127.0.0.1:1430"),
        ])
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([CONTENT_TYPE, AUTHORIZATION, request_id]);

    let mut router = Router::new()
        .route("/health", get(health))
        .nest(REMOTE_API_PREFIX, api)
        .with_state(app_state);
    if let Some(web_root) = web_root {
        router = router.fallback_service(
            ServeDir::new(&web_root).fallback(ServeFile::new(web_root.join("index.html"))),
        );
    }

    router
        .layer(cors)
        .layer(middleware::from_fn_with_state(auth_policy, enforce_auth))
        .layer(middleware::from_fn_with_state(
            host_policy,
            enforce_allowed_host,
        ))
        .layer(middleware::from_fn(add_security_headers))
}

async fn add_security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    response
}

async fn enforce_allowed_host(
    State(policy): State<HostPolicy>,
    request: Request,
    next: Next,
) -> Response {
    let allowed = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase())
        .is_some_and(|value| host_is_allowed(&policy, &value));
    if allowed {
        return next.run(request).await;
    }

    let request_id = request_id(request.headers());
    RemoteHttpError {
        status: StatusCode::MISDIRECTED_REQUEST,
        body: ApiError::new(
            request_id,
            "INVALID_HOST",
            "The request Host header is not allowed",
            false,
        ),
    }
    .into_response()
}

fn host_is_allowed(policy: &HostPolicy, value: &str) -> bool {
    if policy.allowed.contains(value) {
        return true;
    }
    if !policy.allow_private_ip_hosts {
        return false;
    }
    let Ok(address) = value.parse::<SocketAddr>() else {
        return false;
    };
    if address.port() != policy.port {
        return false;
    }
    match address.ip() {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        IpAddr::V6(ip) => ip.is_unique_local() || ip.is_loopback() || ip.is_unicast_link_local(),
    }
}

async fn enforce_auth(State(policy): State<AuthPolicy>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let protected =
        path.starts_with(REMOTE_API_PREFIX) && path != format!("{REMOTE_API_PREFIX}/bootstrap");
    if !policy.required || !protected {
        return next.run(request).await;
    }

    let supplied = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if constant_time_eq(supplied.as_bytes(), policy.token.as_bytes()) {
        return next.run(request).await;
    }

    let request_id = request_id(request.headers());
    let mut response = RemoteHttpError {
        status: StatusCode::UNAUTHORIZED,
        body: ApiError::new(
            request_id,
            "AUTH_REQUIRED",
            "A valid remote access token is required",
            false,
        ),
    }
    .into_response();
    response.headers_mut().insert(
        WWW_AUTHENTICATE,
        HeaderValue::from_static("Bearer realm=\"Memory Forge\""),
    );
    response
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

async fn health(State(state): State<RemoteAppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        protocol_version: REMOTE_PROTOCOL_VERSION,
        server_id: state.context.server_id,
    })
}

async fn bootstrap(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
) -> Result<Json<ApiSuccess<RemoteBootstrap>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    let settings = state
        .context
        .settings
        .lock()
        .map_err(|_| internal_error(&request_id, "failed to lock settings"))?
        .clone();
    let platforms = platform_catalog()
        .into_iter()
        .map(|(id, label)| RemotePlatformInfo {
            available: settings.visible_platforms.iter().any(|value| value == id),
            id: id.to_string(),
            label: label.to_string(),
        })
        .collect();
    let payload = RemoteBootstrap {
        protocol_version: REMOTE_PROTOCOL_VERSION,
        server_id: state.context.server_id,
        server_name: state.context.server_name,
        server_version: state.context.server_version,
        server_time: Utc::now().to_rfc3339(),
        capabilities: RemoteCapabilities::configured(
            state.context.mutation_enabled,
            state.context.terminal_enabled,
        ),
        auth: RemoteAuthInfo {
            required: state.context.auth_required,
            pairing_supported: false,
        },
        platforms,
    };
    Ok(Json(ApiSuccess::new(request_id, payload)))
}

async fn dashboard(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
) -> Result<Json<ApiSuccess<session_service::DashboardSummary>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    let mutation_enabled = state.context.mutation_enabled;
    let mut result = run_snapshot(state, |db, settings| {
        session_service::dashboard_summary(db, settings)
    })
    .await
    .map_err(|error| service_error(&request_id, error))?;
    for platform in &mut result.platforms {
        if !mutation_enabled || !remote_mutations_supported(&platform.platform) {
            for item in &mut platform.items {
                item.editable = false;
            }
        }
    }
    for item in &mut result.recent_sessions {
        if !mutation_enabled || !remote_mutations_supported(&item.platform) {
            item.editable = false;
        }
    }
    Ok(Json(ApiSuccess::new(request_id, result)))
}

async fn session_list(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    Query(query): Query<SessionListQuery>,
) -> Result<Json<ApiSuccess<crate::platforms::SessionListResult>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    let mutation_supported =
        state.context.mutation_enabled && remote_mutations_supported(&query.platform);
    let limit = query.limit.map(|value| value.min(MAX_PAGE_SIZE));
    let mut result = run_snapshot(state, move |db, settings| {
        session_service::session_list(
            db,
            settings,
            &query.platform,
            query.q.as_deref(),
            limit,
            query.offset.unwrap_or(0),
            query.show_archived.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| service_error(&request_id, error))?;
    if !mutation_supported {
        for item in &mut result.items {
            item.editable = false;
        }
    }
    Ok(Json(ApiSuccess::new(request_id, result)))
}

async fn session_detail(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    Query(query): Query<SessionQuery>,
) -> Result<Json<ApiSuccess<crate::platforms::SessionDetail>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    let mutation_supported =
        state.context.mutation_enabled && remote_mutations_supported(&query.platform);
    let mut result = run_snapshot(state, move |db, settings| {
        ensure_known_session(settings, &query.platform, &query.session_key)?;
        session_service::session_detail(db, settings, &query.platform, &query.session_key)
    })
    .await
    .map_err(|error| service_error(&request_id, error))?;
    if !mutation_supported {
        for block in &mut result.blocks {
            block.editable = false;
        }
    }
    Ok(Json(ApiSuccess::new(request_id, result)))
}

async fn edit_log(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    Query(query): Query<SessionQuery>,
) -> Result<Json<ApiSuccess<Vec<database::EditLog>>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    let result = run_snapshot(state, move |db, _settings| {
        ensure_known_session(_settings, &query.platform, &query.session_key)?;
        session_service::session_edit_log(db, &query.platform, &query.session_key)
    })
    .await
    .map_err(|error| service_error(&request_id, error))?;
    Ok(Json(ApiSuccess::new(request_id, result)))
}

async fn terminal_list(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    Query(query): Query<RemoteTerminalListQuery>,
) -> Result<Json<ApiSuccess<Vec<RemoteTerminalSnapshot>>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    ensure_terminal_capability(&request_id, &state)?;
    validate_id(&query.device_id, "deviceId")
        .map_err(|error| invalid_request_error(&request_id, error))?;
    let terminals = state
        .context
        .terminal_state
        .remote_list(&query.device_id)
        .map_err(|error| terminal_service_error(&request_id, error))?;
    Ok(Json(ApiSuccess::new(request_id, terminals)))
}

async fn terminal_start(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    payload: Result<Json<RemoteTerminalStartRequest>, JsonRejection>,
) -> Result<Json<ApiSuccess<RemoteTerminalSnapshot>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    ensure_terminal_capability(&request_id, &state)?;
    let Json(request) = payload.map_err(|error| {
        invalid_request_error(&request_id, format!("invalid terminal start body: {error}"))
    })?;
    validate_terminal_start(&request_id, &request)?;

    if let Ok(existing) = state
        .context
        .terminal_state
        .remote_snapshot(&request.terminal_id, &request.device_id)
    {
        return Ok(Json(ApiSuccess::new(request_id, existing)));
    }

    let platform = request.platform.clone();
    let session_key = request.session_key.clone();
    let command_kind = request.command_kind.clone();
    let detail = run_snapshot(state.clone(), move |db, settings| {
        ensure_known_session(settings, &platform, &session_key)?;
        session_service::session_detail(db, settings, &platform, &session_key)
    })
    .await
    .map_err(|error| service_error(&request_id, error))?;
    let command = detail
        .commands
        .get(&command_kind)
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            invalid_request_error(
                &request_id,
                format!("the selected session does not support {command_kind}"),
            )
        })?;
    let app = state
        .context
        .app_handle
        .clone()
        .ok_or_else(|| internal_error(&request_id, "Terminal host is unavailable"))?;
    let terminal_state = state.context.terminal_state.clone();
    let launch = StartEmbeddedTerminalRequest {
        terminal_id: request.terminal_id,
        session_key: request.session_key,
        command,
        command_kind: request.command_kind,
        cwd: (!detail.cwd.trim().is_empty()).then_some(detail.cwd),
        cols: request.cols,
        rows: request.rows,
        owner_device_id: Some(request.device_id),
        platform: Some(request.platform),
        session_title: Some(if detail.alias_title.trim().is_empty() {
            detail.title
        } else {
            detail.alias_title
        }),
    };
    let snapshot = tokio::task::spawn_blocking(move || terminal_state.start_remote(&app, launch))
        .await
        .map_err(|error| {
            internal_error(
                &request_id,
                &format!("remote terminal start task failed: {error}"),
            )
        })?
        .map_err(|error| terminal_service_error(&request_id, error))?;
    Ok(Json(ApiSuccess::new(request_id, snapshot)))
}

async fn terminal_snapshot(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    AxumPath(terminal_id): AxumPath<String>,
    Query(query): Query<RemoteTerminalListQuery>,
) -> Result<Json<ApiSuccess<RemoteTerminalSnapshot>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    ensure_terminal_capability(&request_id, &state)?;
    validate_terminal_owner(&request_id, &terminal_id, &query.device_id)?;
    let terminal = state
        .context
        .terminal_state
        .remote_snapshot(&terminal_id, &query.device_id)
        .map_err(|error| terminal_service_error(&request_id, error))?;
    Ok(Json(ApiSuccess::new(request_id, terminal)))
}

async fn terminal_output(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    AxumPath(terminal_id): AxumPath<String>,
    Query(query): Query<RemoteTerminalOutputQuery>,
) -> Result<Json<ApiSuccess<RemoteTerminalOutput>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    ensure_terminal_capability(&request_id, &state)?;
    validate_terminal_owner(&request_id, &terminal_id, &query.device_id)?;
    let output = state
        .context
        .terminal_state
        .remote_output(
            &terminal_id,
            &query.device_id,
            query.cursor.unwrap_or_default(),
            query.limit.unwrap_or(128),
        )
        .map_err(|error| terminal_service_error(&request_id, error))?;
    Ok(Json(ApiSuccess::new(request_id, output)))
}

async fn terminal_input(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    AxumPath(terminal_id): AxumPath<String>,
    payload: Result<Json<RemoteTerminalInputRequest>, JsonRejection>,
) -> Result<Json<ApiSuccess<RemoteTerminalSnapshot>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    ensure_terminal_capability(&request_id, &state)?;
    let Json(input) = payload.map_err(|error| {
        invalid_request_error(&request_id, format!("invalid terminal input body: {error}"))
    })?;
    validate_terminal_owner(&request_id, &terminal_id, &input.device_id)?;
    let data = if input.binary {
        BASE64_STANDARD.decode(input.data).map_err(|error| {
            invalid_request_error(
                &request_id,
                format!("invalid base64 terminal input: {error}"),
            )
        })?
    } else {
        input.data.into_bytes()
    };
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err(invalid_request_error(
            &request_id,
            "terminal input exceeds the 64 KiB limit",
        ));
    }
    state
        .context
        .terminal_state
        .remote_write(&terminal_id, &input.device_id, &data)
        .map_err(|error| terminal_service_error(&request_id, error))?;
    let terminal = state
        .context
        .terminal_state
        .remote_snapshot(&terminal_id, &input.device_id)
        .map_err(|error| terminal_service_error(&request_id, error))?;
    Ok(Json(ApiSuccess::new(request_id, terminal)))
}

async fn terminal_resize(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    AxumPath(terminal_id): AxumPath<String>,
    payload: Result<Json<RemoteTerminalResizeRequest>, JsonRejection>,
) -> Result<Json<ApiSuccess<RemoteTerminalSnapshot>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    ensure_terminal_capability(&request_id, &state)?;
    let Json(resize) = payload.map_err(|error| {
        invalid_request_error(
            &request_id,
            format!("invalid terminal resize body: {error}"),
        )
    })?;
    validate_terminal_owner(&request_id, &terminal_id, &resize.device_id)?;
    validate_terminal_size(&request_id, resize.cols, resize.rows)?;
    state
        .context
        .terminal_state
        .remote_resize(&terminal_id, &resize.device_id, resize.cols, resize.rows)
        .map_err(|error| terminal_service_error(&request_id, error))?;
    let terminal = state
        .context
        .terminal_state
        .remote_snapshot(&terminal_id, &resize.device_id)
        .map_err(|error| terminal_service_error(&request_id, error))?;
    Ok(Json(ApiSuccess::new(request_id, terminal)))
}

async fn terminal_stop(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    AxumPath(terminal_id): AxumPath<String>,
    payload: Result<Json<RemoteTerminalStopRequest>, JsonRejection>,
) -> Result<Json<ApiSuccess<RemoteTerminalSnapshot>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    ensure_terminal_capability(&request_id, &state)?;
    let Json(stop) = payload.map_err(|error| {
        invalid_request_error(&request_id, format!("invalid terminal stop body: {error}"))
    })?;
    validate_terminal_owner(&request_id, &terminal_id, &stop.device_id)?;
    let terminal_state = state.context.terminal_state.clone();
    let owner = stop.device_id.clone();
    let id = terminal_id.clone();
    tokio::task::spawn_blocking(move || terminal_state.remote_stop(&id, &owner, stop.force))
        .await
        .map_err(|error| {
            internal_error(
                &request_id,
                &format!("remote terminal stop task failed: {error}"),
            )
        })?
        .map_err(|error| terminal_service_error(&request_id, error))?;
    let terminal = state
        .context
        .terminal_state
        .remote_snapshot(&terminal_id, &stop.device_id)
        .map_err(|error| terminal_service_error(&request_id, error))?;
    Ok(Json(ApiSuccess::new(request_id, terminal)))
}

async fn terminal_close(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    AxumPath(terminal_id): AxumPath<String>,
    Query(query): Query<RemoteTerminalListQuery>,
) -> Result<Json<ApiSuccess<serde_json::Value>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    ensure_terminal_capability(&request_id, &state)?;
    validate_terminal_owner(&request_id, &terminal_id, &query.device_id)?;
    let terminal_state = state.context.terminal_state.clone();
    let owner = query.device_id;
    let id = terminal_id.clone();
    tokio::task::spawn_blocking(move || terminal_state.remote_close(&id, &owner))
        .await
        .map_err(|error| {
            internal_error(
                &request_id,
                &format!("remote terminal close task failed: {error}"),
            )
        })?
        .map_err(|error| terminal_service_error(&request_id, error))?;
    Ok(Json(ApiSuccess::new(
        request_id,
        serde_json::json!({ "terminalId": terminal_id, "closed": true }),
    )))
}

async fn session_edit_mutation(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    payload: Result<Json<EditMessageMutation>, JsonRejection>,
) -> Result<Json<ApiSuccess<RemoteMutationResult>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    let Json(mutation) = payload.map_err(|error| {
        invalid_request_error(&request_id, format!("invalid mutation body: {error}"))
    })?;
    if !state.context.mutation_enabled {
        return Err(capability_error(&request_id, "sessionEdit"));
    }
    validate_edit_mutation(&request_id, &mutation)?;
    let db_path = state.context.db_path.clone();
    let settings = state
        .context
        .settings
        .lock()
        .map_err(|_| internal_error(&request_id, "failed to lock settings"))?
        .clone();
    let lock = Arc::clone(&state.context.mutation_lock);
    let request_hash = mutation_hash(&mutation);
    let mutation_for_task = mutation.clone();
    let result = tokio::task::spawn_blocking(move || {
        execute_edit_mutation(&db_path, &settings, lock, mutation_for_task, request_hash)
    })
    .await
    .map_err(|error| {
        internal_error(
            &request_id,
            &format!("remote mutation task failed: {error}"),
        )
    })?;

    match result {
        Ok(payload) => Ok(Json(ApiSuccess::new(request_id, payload))),
        Err(failure) => Err(mutation_failure_response(&request_id, failure)),
    }
}

async fn session_restore_mutation(
    State(state): State<RemoteAppState>,
    headers: HeaderMap,
    payload: Result<Json<RestoreMessageMutation>, JsonRejection>,
) -> Result<Json<ApiSuccess<RemoteMutationResult>>, RemoteHttpError> {
    let request_id = request_id(&headers);
    let Json(mutation) = payload.map_err(|error| {
        invalid_request_error(&request_id, format!("invalid mutation body: {error}"))
    })?;
    if !state.context.mutation_enabled {
        return Err(capability_error(&request_id, "sessionEdit"));
    }
    validate_restore_mutation(&request_id, &mutation)?;
    let db_path = state.context.db_path.clone();
    let settings = state
        .context
        .settings
        .lock()
        .map_err(|_| internal_error(&request_id, "failed to lock settings"))?
        .clone();
    let lock = Arc::clone(&state.context.mutation_lock);
    let request_hash = mutation_hash(&mutation);
    let mutation_for_task = mutation.clone();
    let result = tokio::task::spawn_blocking(move || {
        execute_restore_mutation(&db_path, &settings, lock, mutation_for_task, request_hash)
    })
    .await
    .map_err(|error| {
        internal_error(
            &request_id,
            &format!("remote mutation task failed: {error}"),
        )
    })?;

    match result {
        Ok(payload) => Ok(Json(ApiSuccess::new(request_id, payload))),
        Err(failure) => Err(mutation_failure_response(&request_id, failure)),
    }
}

#[derive(Debug)]
struct MutationFailure {
    error: String,
    current_revision: Option<String>,
}

fn execute_edit_mutation(
    db_path: &str,
    settings: &AppSettings,
    lock: Arc<Mutex<()>>,
    mutation: EditMessageMutation,
    request_hash: String,
) -> Result<RemoteMutationResult, MutationFailure> {
    let _guard = lock.lock().map_err(|_| MutationFailure {
        error: "remote mutation lock is poisoned".to_string(),
        current_revision: None,
    })?;
    let db = DbState::new(db_path).map_err(failure_without_revision)?;
    let operation = "session-edit";
    if let Some(existing) =
        database::get_remote_mutation(&db.conn, &mutation.device_id, &mutation.mutation_id)
            .map_err(failure_without_revision)?
    {
        return replay_or_reject(existing, operation, &request_hash);
    }
    ensure_known_session(settings, &mutation.platform, &mutation.session_key)
        .map_err(failure_without_revision)?;

    session_service::session_edit_message(
        &db,
        settings,
        &mutation.platform,
        &mutation.message_id,
        &mutation.content,
        &mutation.session_key,
        &mutation.expected_revision,
    )
    .map_err(|error| {
        mutation_service_failure(
            &db,
            settings,
            &mutation.platform,
            &mutation.session_key,
            error,
        )
    })?;

    persist_mutation_result(
        &db,
        &mutation.device_id,
        &mutation.mutation_id,
        operation,
        &request_hash,
    )
}

fn execute_restore_mutation(
    db_path: &str,
    settings: &AppSettings,
    lock: Arc<Mutex<()>>,
    mutation: RestoreMessageMutation,
    request_hash: String,
) -> Result<RemoteMutationResult, MutationFailure> {
    let _guard = lock.lock().map_err(|_| MutationFailure {
        error: "remote mutation lock is poisoned".to_string(),
        current_revision: None,
    })?;
    let db = DbState::new(db_path).map_err(failure_without_revision)?;
    let operation = "session-restore";
    if let Some(existing) =
        database::get_remote_mutation(&db.conn, &mutation.device_id, &mutation.mutation_id)
            .map_err(failure_without_revision)?
    {
        return replay_or_reject(existing, operation, &request_hash);
    }
    ensure_known_session(settings, &mutation.platform, &mutation.session_key)
        .map_err(failure_without_revision)?;

    session_service::session_restore_message(
        &db,
        settings,
        &mutation.platform,
        mutation.edit_log_id,
        &mutation.session_key,
        &mutation.expected_revision,
    )
    .map_err(|error| {
        mutation_service_failure(
            &db,
            settings,
            &mutation.platform,
            &mutation.session_key,
            error,
        )
    })?;

    persist_mutation_result(
        &db,
        &mutation.device_id,
        &mutation.mutation_id,
        operation,
        &request_hash,
    )
}

fn persist_mutation_result(
    db: &DbState,
    device_id: &str,
    mutation_id: &str,
    operation: &str,
    request_hash: &str,
) -> Result<RemoteMutationResult, MutationFailure> {
    let payload = RemoteMutationResult {
        mutation_id: mutation_id.to_string(),
        applied: true,
    };
    let response_json = serde_json::to_string(&payload)
        .map_err(|error| failure_without_revision(error.to_string()))?;
    database::save_remote_mutation(
        &db.conn,
        device_id,
        mutation_id,
        operation,
        request_hash,
        &response_json,
    )
    .map_err(failure_without_revision)?;
    Ok(payload)
}

fn replay_or_reject(
    existing: database::RemoteMutationRecord,
    operation: &str,
    request_hash: &str,
) -> Result<RemoteMutationResult, MutationFailure> {
    if existing.operation != operation || existing.request_hash != request_hash {
        return Err(MutationFailure {
            error: "MUTATION_ID_REUSED".to_string(),
            current_revision: None,
        });
    }
    serde_json::from_str(&existing.response_json)
        .map_err(|error| failure_without_revision(error.to_string()))
}

fn mutation_service_failure(
    db: &DbState,
    settings: &AppSettings,
    platform: &str,
    session_key: &str,
    error: String,
) -> MutationFailure {
    if error.contains(session_service::SESSION_REVISION_CONFLICT) {
        let current_revision = session_service::session_detail(db, settings, platform, session_key)
            .and_then(|detail| session_service::session_revision(&detail.blocks))
            .ok();
        return MutationFailure {
            error: session_service::SESSION_REVISION_CONFLICT.to_string(),
            current_revision,
        };
    }
    failure_without_revision(error)
}

fn failure_without_revision(error: String) -> MutationFailure {
    MutationFailure {
        error,
        current_revision: None,
    }
}

fn mutation_hash<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err(format!("{label} must be between 1 and 128 characters"));
    }
    if !trimmed
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("{label} contains unsupported characters"));
    }
    Ok(())
}

fn validate_opaque(value: &str, label: &str, max_len: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max_len {
        return Err(format!(
            "{label} must be between 1 and {max_len} characters"
        ));
    }
    if value.bytes().any(|byte| byte == 0) {
        return Err(format!("{label} contains unsupported characters"));
    }
    Ok(())
}

fn validate_edit_mutation(
    request_id: &str,
    mutation: &EditMessageMutation,
) -> Result<(), RemoteHttpError> {
    for (value, label) in [
        (&mutation.device_id, "deviceId"),
        (&mutation.mutation_id, "mutationId"),
        (&mutation.platform, "platform"),
        (&mutation.expected_revision, "expectedRevision"),
    ] {
        validate_id(value, label).map_err(|error| invalid_request_error(request_id, error))?;
    }
    validate_opaque(&mutation.session_key, "sessionKey", 4096)
        .map_err(|error| invalid_request_error(request_id, error))?;
    validate_opaque(&mutation.message_id, "messageId", 8192)
        .map_err(|error| invalid_request_error(request_id, error))?;
    validate_platform(request_id, &mutation.platform)?;
    validate_mutation_platform(request_id, &mutation.platform)?;
    if mutation.content.len() > MAX_MUTATION_CONTENT_BYTES {
        return Err(invalid_request_error(
            request_id,
            "content exceeds the 4 MiB limit",
        ));
    }
    Ok(())
}

fn validate_restore_mutation(
    request_id: &str,
    mutation: &RestoreMessageMutation,
) -> Result<(), RemoteHttpError> {
    for (value, label) in [
        (&mutation.device_id, "deviceId"),
        (&mutation.mutation_id, "mutationId"),
        (&mutation.platform, "platform"),
        (&mutation.expected_revision, "expectedRevision"),
    ] {
        validate_id(value, label).map_err(|error| invalid_request_error(request_id, error))?;
    }
    validate_opaque(&mutation.session_key, "sessionKey", 4096)
        .map_err(|error| invalid_request_error(request_id, error))?;
    validate_platform(request_id, &mutation.platform)?;
    validate_mutation_platform(request_id, &mutation.platform)?;
    if mutation.edit_log_id <= 0 {
        return Err(invalid_request_error(
            request_id,
            "editLogId must be positive",
        ));
    }
    Ok(())
}

fn ensure_terminal_capability(
    request_id: &str,
    state: &RemoteAppState,
) -> Result<(), RemoteHttpError> {
    if state.context.terminal_enabled {
        Ok(())
    } else {
        Err(capability_error(request_id, "terminal"))
    }
}

fn validate_terminal_start(
    request_id: &str,
    request: &RemoteTerminalStartRequest,
) -> Result<(), RemoteHttpError> {
    validate_id(&request.device_id, "deviceId")
        .map_err(|error| invalid_request_error(request_id, error))?;
    crate::embedded_terminal::validate_remote_terminal_id(&request.terminal_id)
        .map_err(|error| invalid_request_error(request_id, error))?;
    validate_platform(request_id, &request.platform)?;
    if request.platform == REMOTE_MUTATION_UNSUPPORTED_PLATFORM {
        return Err(invalid_request_error(
            request_id,
            "remote terminal is not supported for Kiro IDE",
        ));
    }
    validate_opaque(&request.session_key, "sessionKey", 4096)
        .map_err(|error| invalid_request_error(request_id, error))?;
    if !matches!(request.command_kind.as_str(), "resume" | "fork") {
        return Err(invalid_request_error(
            request_id,
            "commandKind must be resume or fork",
        ));
    }
    validate_terminal_size(request_id, request.cols, request.rows)
}

fn validate_terminal_owner(
    request_id: &str,
    terminal_id: &str,
    device_id: &str,
) -> Result<(), RemoteHttpError> {
    crate::embedded_terminal::validate_remote_terminal_id(terminal_id)
        .map_err(|error| invalid_request_error(request_id, error))?;
    validate_id(device_id, "deviceId").map_err(|error| invalid_request_error(request_id, error))
}

fn validate_terminal_size(request_id: &str, cols: u16, rows: u16) -> Result<(), RemoteHttpError> {
    if !(20..=500).contains(&cols) || !(3..=300).contains(&rows) {
        return Err(invalid_request_error(
            request_id,
            "terminal size must be between 20x3 and 500x300",
        ));
    }
    Ok(())
}

fn terminal_service_error(request_id: &str, error: String) -> RemoteHttpError {
    let lower = error.to_ascii_lowercase();
    if lower.contains("not found") {
        return RemoteHttpError {
            status: StatusCode::NOT_FOUND,
            body: ApiError::new(
                request_id.to_string(),
                "NOT_FOUND",
                "Remote terminal not found",
                false,
            ),
        };
    }
    if lower.contains("limit reached") {
        return RemoteHttpError {
            status: StatusCode::TOO_MANY_REQUESTS,
            body: ApiError::new(
                request_id.to_string(),
                "TERMINAL_LIMIT_REACHED",
                error,
                true,
            ),
        };
    }
    if lower.contains("invalid")
        || lower.contains("required")
        || lower.contains("too large")
        || lower.contains("unsupported")
        || lower.contains("already exists")
    {
        return invalid_request_error(request_id, error);
    }
    if lower.contains("closed") || lower.contains("stopping") {
        return RemoteHttpError {
            status: StatusCode::CONFLICT,
            body: ApiError::new(request_id.to_string(), "TERMINAL_NOT_RUNNING", error, true),
        };
    }
    eprintln!("[remote] terminal request {request_id} failed: {error}");
    internal_error(request_id, "The remote terminal request failed")
}

fn invalid_request_error(request_id: &str, message: impl Into<String>) -> RemoteHttpError {
    RemoteHttpError {
        status: StatusCode::BAD_REQUEST,
        body: ApiError::new(
            request_id.to_string(),
            "INVALID_REQUEST",
            message.into(),
            false,
        ),
    }
}

fn capability_error(request_id: &str, capability: &str) -> RemoteHttpError {
    RemoteHttpError {
        status: StatusCode::FORBIDDEN,
        body: ApiError::new(
            request_id.to_string(),
            "REMOTE_CAPABILITY_UNAVAILABLE",
            format!("Remote capability is disabled: {capability}"),
            false,
        ),
    }
}

fn validate_platform(request_id: &str, platform: &str) -> Result<(), RemoteHttpError> {
    if platform_catalog().iter().any(|(id, _)| *id == platform) {
        return Ok(());
    }
    Err(invalid_request_error(
        request_id,
        format!("unsupported platform: {platform}"),
    ))
}

fn validate_mutation_platform(request_id: &str, platform: &str) -> Result<(), RemoteHttpError> {
    if remote_mutations_supported(platform) {
        return Ok(());
    }
    Err(invalid_request_error(
        request_id,
        format!("remote mutations are not supported for platform: {platform}"),
    ))
}

fn remote_mutations_supported(platform: &str) -> bool {
    platform != REMOTE_MUTATION_UNSUPPORTED_PLATFORM
}

fn mutation_failure_response(request_id: &str, failure: MutationFailure) -> RemoteHttpError {
    let code = if failure.error == session_service::SESSION_REVISION_CONFLICT {
        "SESSION_REVISION_CONFLICT"
    } else if failure.error == "MUTATION_ID_REUSED" {
        "MUTATION_ID_REUSED"
    } else if failure.error == REMOTE_SESSION_NOT_FOUND {
        "NOT_FOUND"
    } else if failure.error == session_service::SESSION_EDIT_TARGET_MISMATCH {
        "INVALID_REQUEST"
    } else {
        "INTERNAL_ERROR"
    };
    let status = match code {
        "SESSION_REVISION_CONFLICT" | "MUTATION_ID_REUSED" => StatusCode::CONFLICT,
        "NOT_FOUND" => StatusCode::NOT_FOUND,
        "INVALID_REQUEST" => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let mut body = ApiError::new(
        request_id.to_string(),
        code,
        if code == "INTERNAL_ERROR" {
            "The remote mutation failed".to_string()
        } else {
            failure.error
        },
        code == "INTERNAL_ERROR",
    );
    body.error.current_revision = failure.current_revision;
    RemoteHttpError { status, body }
}

async fn run_snapshot<T, F>(state: RemoteAppState, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&DbState, &AppSettings) -> Result<T, String> + Send + 'static,
{
    let db_path = state.context.db_path;
    let settings = state
        .context
        .settings
        .lock()
        .map_err(|_| "failed to lock settings".to_string())?
        .clone();
    tokio::task::spawn_blocking(move || {
        let db = DbState::new(&db_path)?;
        operation(&db, &settings)
    })
    .await
    .map_err(|error| format!("remote snapshot task failed: {error}"))?
}

fn request_id(headers: &HeaderMap) -> String {
    headers
        .get(REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

fn service_error(request_id: &str, error: String) -> RemoteHttpError {
    if error == REMOTE_SESSION_NOT_FOUND {
        return RemoteHttpError {
            status: StatusCode::NOT_FOUND,
            body: ApiError::new(
                request_id.to_string(),
                "NOT_FOUND",
                "Remote session not found",
                false,
            ),
        };
    }
    let lower = error.to_ascii_lowercase();
    if lower.contains("unsupported platform") || lower.contains("invalid") {
        return RemoteHttpError {
            status: StatusCode::BAD_REQUEST,
            body: ApiError::new(request_id.to_string(), "INVALID_REQUEST", error, false),
        };
    }
    if lower.contains("not found") || lower.contains("does not exist") {
        return RemoteHttpError {
            status: StatusCode::NOT_FOUND,
            body: ApiError::new(request_id.to_string(), "NOT_FOUND", error, false),
        };
    }
    eprintln!("[remote] request {request_id} failed: {error}");
    internal_error(request_id, "The remote request failed")
}

fn internal_error(request_id: &str, message: &str) -> RemoteHttpError {
    RemoteHttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        body: ApiError::new(request_id.to_string(), "INTERNAL_ERROR", message, true),
    }
}

fn ensure_known_session(
    settings: &AppSettings,
    platform: &str,
    session_key: &str,
) -> Result<(), String> {
    if session_service::session_key_exists(settings, platform, session_key)? {
        Ok(())
    } else {
        Err(REMOTE_SESSION_NOT_FOUND.to_string())
    }
}

fn platform_catalog() -> [(&'static str, &'static str); 9] {
    [
        ("claude", "Claude Code"),
        ("codex", "Codex CLI"),
        ("opencode", "OpenCode"),
        ("grok", "Grok CLI"),
        ("pi", "Pi"),
        ("cursor", "Cursor"),
        ("kiro", "Kiro CLI"),
        ("kiro-ide", "Kiro IDE"),
        ("gemini", "Gemini CLI"),
    ]
}

fn allowed_hosts(address: SocketAddr) -> HashSet<String> {
    let port = address.port();
    [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
        format!("{}:{port}", address.ip()),
    ]
    .into_iter()
    .map(|value| value.to_ascii_lowercase())
    .collect()
}

fn format_http_url(address: SocketAddr) -> String {
    match address.ip() {
        IpAddr::V4(ip) => format!("http://{ip}:{}", address.port()),
        IpAddr::V6(ip) => format!("http://[{ip}]:{}", address.port()),
    }
}

fn discover_lan_urls(port: u16) -> Vec<String> {
    let mut urls = Vec::new();
    if let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) {
        if socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).is_ok() {
            if let Ok(address) = socket.local_addr() {
                if !address.ip().is_loopback() && !address.ip().is_unspecified() {
                    urls.push(format_http_url(SocketAddr::new(address.ip(), port)));
                }
            }
        }
    }
    urls.sort();
    urls.dedup();
    urls
}

fn record_server_exit(status: &Mutex<RemoteServerStatus>, error: Option<String>) {
    if let Ok(mut status) = status.lock() {
        status.running = false;
        status.error = error;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("memory-forge-remote-server-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_context(dir: &TestDir) -> RemoteServerContext {
        let db_path = dir.0.join("memory-forge.db");
        let db = DbState::new(db_path.to_string_lossy().as_ref()).expect("create database");
        {
            let conn = db.conn.lock().expect("lock database");
            database::init_tables(&conn).expect("initialize database");
        }
        drop(db);
        let settings = AppSettings {
            claude_home: Some(dir.0.join("claude").to_string_lossy().into_owned()),
            visible_platforms: vec!["claude".to_string()],
            ..AppSettings::default()
        };
        RemoteServerContext {
            db_path: db_path.to_string_lossy().into_owned(),
            settings: Arc::new(Mutex::new(settings)),
            server_id: Uuid::new_v4().to_string(),
            server_name: "Test Host".to_string(),
            server_version: "test".to_string(),
            web_root: Some(dir.0.join("web")),
            mutation_enabled: false,
            terminal_enabled: false,
            mutation_lock: Arc::new(Mutex::new(())),
            auth_required: false,
            access_token: None,
            terminal_state: EmbeddedTerminalState::default(),
            app_handle: None,
        }
    }

    #[test]
    fn kiro_ide_remote_mutations_are_rejected() {
        let edit = EditMessageMutation {
            device_id: "phone-1".to_string(),
            mutation_id: "mutation-edit".to_string(),
            platform: "kiro-ide".to_string(),
            session_key: "workspace::session".to_string(),
            message_id: "workspace::session::message".to_string(),
            content: "updated".to_string(),
            expected_revision: "revision".to_string(),
        };
        let edit_error = validate_edit_mutation("request-edit", &edit)
            .err()
            .expect("Kiro IDE edit must be rejected");
        assert_eq!(edit_error.status, StatusCode::BAD_REQUEST);
        assert_eq!(edit_error.body.error.code, "INVALID_REQUEST");

        let restore = RestoreMessageMutation {
            device_id: "phone-1".to_string(),
            mutation_id: "mutation-restore".to_string(),
            platform: "kiro-ide".to_string(),
            session_key: "workspace::session".to_string(),
            edit_log_id: 1,
            expected_revision: "revision".to_string(),
        };
        let restore_error = validate_restore_mutation("request-restore", &restore)
            .err()
            .expect("Kiro IDE restore must be rejected");
        assert_eq!(restore_error.status, StatusCode::BAD_REQUEST);
        assert_eq!(restore_error.body.error.code, "INVALID_REQUEST");
    }

    #[test]
    fn server_id_is_persisted_and_reused() {
        let dir = TestDir::new();
        let first = load_or_create_server_id(&dir.0).expect("create server id");
        let second = load_or_create_server_id(&dir.0).expect("reload server id");

        assert_eq!(first, second);
        assert!(Uuid::parse_str(&first).is_ok());
    }

    #[test]
    fn access_token_is_persisted_and_reused() {
        let dir = TestDir::new();
        let first = load_or_create_access_token(&dir.0).expect("create access token");
        let second = load_or_create_access_token(&dir.0).expect("reload access token");

        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = fs::metadata(dir.0.join("remote-access-token"))
                .expect("token metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0);
        }
    }

    #[test]
    fn authenticated_server_keeps_bootstrap_public_and_protects_snapshots() {
        let dir = TestDir::new();
        let server = RemoteServerState::default();
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let mut config = RemoteServerConfig::loopback_ephemeral();
        config.require_auth = true;
        config.access_token = Some(token.to_string());
        let status = server
            .start(config, test_context(&dir))
            .expect("start authenticated server");
        let client = reqwest::blocking::Client::new();
        (0..50)
            .find_map(
                |_| match client.get(format!("{}/health", status.url)).send() {
                    Ok(response) => Some(response),
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                        None
                    }
                },
            )
            .expect("remote server becomes ready");

        let bootstrap: serde_json::Value = client
            .get(format!("{}/api/v1/bootstrap", status.url))
            .send()
            .expect("public bootstrap")
            .error_for_status()
            .expect("bootstrap status")
            .json()
            .expect("bootstrap json");
        assert_eq!(bootstrap["data"]["auth"]["required"], true);

        let unauthorized = client
            .get(format!("{}/api/v1/dashboard", status.url))
            .send()
            .expect("unauthorized dashboard");
        assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);
        assert!(unauthorized.headers().contains_key(WWW_AUTHENTICATE));

        let authorized = client
            .get(format!("{}/api/v1/dashboard", status.url))
            .bearer_auth(token)
            .send()
            .expect("authorized dashboard");
        assert_eq!(authorized.status(), reqwest::StatusCode::OK);

        server.stop().expect("stop remote server");
    }

    #[test]
    fn lan_host_policy_only_accepts_private_numeric_hosts() {
        let policy = HostPolicy {
            allowed: Arc::new(HashSet::new()),
            port: 7331,
            allow_private_ip_hosts: true,
        };
        assert!(host_is_allowed(&policy, "192.168.1.25:7331"));
        assert!(host_is_allowed(&policy, "10.0.0.5:7331"));
        assert!(!host_is_allowed(&policy, "8.8.8.8:7331"));
        assert!(!host_is_allowed(&policy, "memory-forge.example:7331"));
        assert!(!host_is_allowed(&policy, "192.168.1.25:7332"));
    }

    #[test]
    fn loopback_server_exposes_versioned_bootstrap_and_rejects_bad_hosts() {
        let dir = TestDir::new();
        let project_dir = dir.0.join("claude/projects/project-1");
        fs::create_dir_all(&project_dir).expect("create platform directory");
        let web_root = dir.0.join("web");
        fs::create_dir_all(&web_root).expect("create web root");
        fs::write(web_root.join("index.html"), "<h1>Memory Forge</h1>").expect("write web fixture");
        let session_path = project_dir.join("session-1.jsonl");
        fs::write(
            &session_path,
            serde_json::json!({
                "sessionId": "session-1",
                "cwd": dir.0,
                "message": { "role": "user", "content": "hello remotely" }
            })
            .to_string()
                + "\n",
        )
        .expect("write session fixture");
        let outside_path = dir.0.join("outside.jsonl");
        fs::write(
            &outside_path,
            serde_json::json!({
                "sessionId": "outside-session",
                "cwd": dir.0,
                "message": { "role": "user", "content": "must stay outside remote scope" }
            })
            .to_string()
                + "\n",
        )
        .expect("write outside fixture");
        let server = RemoteServerState::default();
        let status = server
            .start(RemoteServerConfig::loopback_ephemeral(), test_context(&dir))
            .expect("start remote server");
        let client = reqwest::blocking::Client::new();

        let health = (0..50)
            .find_map(
                |_| match client.get(format!("{}/health", status.url)).send() {
                    Ok(response) => Some(response),
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                        None
                    }
                },
            )
            .expect("remote server becomes ready");
        assert_eq!(health.status(), reqwest::StatusCode::OK);

        let web = client
            .get(format!("{}/", status.url))
            .send()
            .expect("request web app")
            .error_for_status()
            .expect("web app status");
        assert!(web.headers().contains_key("content-security-policy"));
        assert_eq!(web.text().expect("web app body"), "<h1>Memory Forge</h1>");

        let deep_link = client
            .get(format!("{}/terminal-sessions", status.url))
            .send()
            .expect("request SPA deep link");
        assert_eq!(deep_link.status(), reqwest::StatusCode::OK);
        assert_eq!(
            deep_link.text().expect("SPA deep-link body"),
            "<h1>Memory Forge</h1>"
        );

        let bootstrap: serde_json::Value = client
            .get(format!("{}/api/v1/bootstrap", status.url))
            .header(REQUEST_ID_HEADER, "request-1")
            .send()
            .expect("request bootstrap")
            .error_for_status()
            .expect("bootstrap status")
            .json()
            .expect("bootstrap json");
        assert_eq!(bootstrap["protocolVersion"], REMOTE_PROTOCOL_VERSION);
        assert_eq!(bootstrap["requestId"], "request-1");
        assert_eq!(bootstrap["data"]["capabilities"]["sessionEdit"], false);
        assert_eq!(bootstrap["data"]["capabilities"]["terminal"], false);

        let terminal_disabled = client
            .get(format!("{}/api/v1/terminals", status.url))
            .query(&[("deviceId", "phone-disabled")])
            .send()
            .expect("request disabled terminal route");
        assert_eq!(terminal_disabled.status(), reqwest::StatusCode::FORBIDDEN);
        let terminal_disabled_body: serde_json::Value = terminal_disabled
            .json()
            .expect("disabled terminal error json");
        assert_eq!(
            terminal_disabled_body["error"]["code"],
            "REMOTE_CAPABILITY_UNAVAILABLE"
        );

        let dashboard: serde_json::Value = client
            .get(format!("{}/api/v1/dashboard", status.url))
            .send()
            .expect("request dashboard")
            .error_for_status()
            .expect("dashboard status")
            .json()
            .expect("dashboard json");
        assert_eq!(
            dashboard["data"]["platforms"][0]["items"][0]["editable"],
            false
        );
        assert_eq!(dashboard["data"]["recentSessions"][0]["editable"], false);

        let sessions: serde_json::Value = client
            .get(format!("{}/api/v1/sessions", status.url))
            .query(&[("platform", "claude"), ("limit", "10")])
            .send()
            .expect("request sessions")
            .error_for_status()
            .expect("sessions status")
            .json()
            .expect("sessions json");
        assert_eq!(sessions["data"]["total"], 1);
        assert_eq!(sessions["data"]["items"][0]["editable"], false);

        let session_key = sessions["data"]["items"][0]["sessionKey"]
            .as_str()
            .expect("authoritative session key")
            .to_string();
        let detail: serde_json::Value = client
            .get(format!("{}/api/v1/session-detail", status.url))
            .query(&[("platform", "claude"), ("sessionKey", session_key.as_str())])
            .send()
            .expect("request detail")
            .error_for_status()
            .expect("detail status")
            .json()
            .expect("detail json");
        assert_eq!(detail["data"]["blocks"][0]["content"], "hello remotely");
        assert_eq!(detail["data"]["blocks"][0]["editable"], false);
        assert_eq!(
            detail["data"]["revision"]
                .as_str()
                .expect("revision string")
                .len(),
            64
        );

        let outside_key = outside_path.to_string_lossy().into_owned();
        let outside = client
            .get(format!("{}/api/v1/session-detail", status.url))
            .query(&[("platform", "claude"), ("sessionKey", outside_key.as_str())])
            .send()
            .expect("request outside detail");
        assert_eq!(outside.status(), reqwest::StatusCode::NOT_FOUND);

        let logs: serde_json::Value = client
            .get(format!("{}/api/v1/edit-log", status.url))
            .query(&[("platform", "claude"), ("sessionKey", session_key.as_str())])
            .send()
            .expect("request edit log")
            .error_for_status()
            .expect("edit log status")
            .json()
            .expect("edit log json");
        assert_eq!(logs["data"], serde_json::json!([]));

        let rejected = client
            .get(format!("{}/health", status.url))
            .header(HOST, "evil.example")
            .send()
            .expect("request invalid host");
        assert_eq!(rejected.status(), reqwest::StatusCode::MISDIRECTED_REQUEST);

        let stopped = server.stop().expect("stop remote server");
        assert!(!stopped.running);
    }

    #[test]
    fn terminal_routes_enforce_auth_capability_ownership_and_input_limits() {
        let dir = TestDir::new();
        let terminal_id = "remote_http_owner";
        let owner_device_id = "phone-owner";
        let other_device_id = "phone-other";
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let context = test_context(&dir);
        context
            .terminal_state
            .seed_remote_for_test(terminal_id, owner_device_id)
            .expect("seed remote terminal record");

        let server = RemoteServerState::default();
        let mut config = RemoteServerConfig::loopback_ephemeral();
        config.enable_terminal = true;
        config.require_auth = true;
        config.access_token = Some(token.to_string());
        let status = server
            .start(config, context)
            .expect("start authenticated terminal server");
        assert!(status.terminal_enabled);
        assert!(status.auth_required);
        let client = reqwest::blocking::Client::new();
        (0..50)
            .find_map(
                |_| match client.get(format!("{}/health", status.url)).send() {
                    Ok(response) => Some(response),
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                        None
                    }
                },
            )
            .expect("remote terminal server becomes ready");

        let bootstrap: serde_json::Value = client
            .get(format!("{}/api/v1/bootstrap", status.url))
            .send()
            .expect("public terminal bootstrap")
            .error_for_status()
            .expect("terminal bootstrap status")
            .json()
            .expect("terminal bootstrap json");
        assert_eq!(bootstrap["data"]["capabilities"]["terminal"], true);
        assert_eq!(bootstrap["data"]["auth"]["required"], true);

        let unauthorized = client
            .get(format!("{}/api/v1/terminals", status.url))
            .query(&[("deviceId", owner_device_id)])
            .send()
            .expect("unauthorized terminal list");
        assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);

        let owner_list: serde_json::Value = client
            .get(format!("{}/api/v1/terminals", status.url))
            .bearer_auth(token)
            .query(&[("deviceId", owner_device_id)])
            .send()
            .expect("owner terminal list")
            .error_for_status()
            .expect("owner terminal list status")
            .json()
            .expect("owner terminal list json");
        assert_eq!(owner_list["data"].as_array().map(Vec::len), Some(1));
        assert_eq!(owner_list["data"][0]["terminalId"], terminal_id);

        let other_list: serde_json::Value = client
            .get(format!("{}/api/v1/terminals", status.url))
            .bearer_auth(token)
            .query(&[("deviceId", other_device_id)])
            .send()
            .expect("other device terminal list")
            .error_for_status()
            .expect("other device terminal list status")
            .json()
            .expect("other device terminal list json");
        assert_eq!(other_list["data"], serde_json::json!([]));

        let other_output = client
            .get(format!(
                "{}/api/v1/terminals/{terminal_id}/output",
                status.url
            ))
            .bearer_auth(token)
            .query(&[("deviceId", other_device_id)])
            .send()
            .expect("other device terminal output");
        assert_eq!(other_output.status(), reqwest::StatusCode::NOT_FOUND);

        let other_close = client
            .delete(format!("{}/api/v1/terminals/{terminal_id}", status.url))
            .bearer_auth(token)
            .query(&[("deviceId", other_device_id)])
            .send()
            .expect("other device terminal close");
        assert_eq!(other_close.status(), reqwest::StatusCode::NOT_FOUND);

        let owner_output: serde_json::Value = client
            .get(format!(
                "{}/api/v1/terminals/{terminal_id}/output",
                status.url
            ))
            .bearer_auth(token)
            .query(&[("deviceId", owner_device_id), ("cursor", "0")])
            .send()
            .expect("owner terminal output")
            .error_for_status()
            .expect("owner terminal output status")
            .json()
            .expect("owner terminal output json");
        assert_eq!(
            owner_output["data"]["chunks"].as_array().map(Vec::len),
            Some(1)
        );
        assert_eq!(owner_output["data"]["truncated"], false);

        let oversized_input = client
            .post(format!(
                "{}/api/v1/terminals/{terminal_id}/input",
                status.url
            ))
            .bearer_auth(token)
            .json(&serde_json::json!({
                "deviceId": owner_device_id,
                "data": "x".repeat(MAX_TERMINAL_INPUT_BYTES + 1),
                "binary": false,
            }))
            .send()
            .expect("oversized terminal input");
        assert_eq!(oversized_input.status(), reqwest::StatusCode::BAD_REQUEST);
        let oversized_body: serde_json::Value =
            oversized_input.json().expect("oversized input error json");
        assert_eq!(oversized_body["error"]["code"], "INVALID_REQUEST");

        let arbitrary_command = client
            .post(format!("{}/api/v1/terminals", status.url))
            .bearer_auth(token)
            .json(&serde_json::json!({
                "deviceId": owner_device_id,
                "terminalId": "remote_arbitrary_command",
                "platform": "claude",
                "sessionKey": "claude:test-session",
                "commandKind": "shell",
                "cols": 80,
                "rows": 24,
            }))
            .send()
            .expect("arbitrary terminal command");
        assert_eq!(arbitrary_command.status(), reqwest::StatusCode::BAD_REQUEST);
        let arbitrary_body: serde_json::Value = arbitrary_command
            .json()
            .expect("arbitrary command error json");
        assert_eq!(arbitrary_body["error"]["code"], "INVALID_REQUEST");

        let owner_close: serde_json::Value = client
            .delete(format!("{}/api/v1/terminals/{terminal_id}", status.url))
            .bearer_auth(token)
            .query(&[("deviceId", owner_device_id)])
            .send()
            .expect("owner terminal close")
            .error_for_status()
            .expect("owner terminal close status")
            .json()
            .expect("owner terminal close json");
        assert_eq!(owner_close["data"]["closed"], true);

        let empty_owner_list: serde_json::Value = client
            .get(format!("{}/api/v1/terminals", status.url))
            .bearer_auth(token)
            .query(&[("deviceId", owner_device_id)])
            .send()
            .expect("empty owner terminal list")
            .error_for_status()
            .expect("empty owner terminal list status")
            .json()
            .expect("empty owner terminal list json");
        assert_eq!(empty_owner_list["data"], serde_json::json!([]));

        server.stop().expect("stop terminal server");
    }

    #[test]
    fn mutation_routes_are_revision_safe_and_idempotent() {
        let dir = TestDir::new();
        let project_dir = dir.0.join("claude/projects/project-1");
        fs::create_dir_all(&project_dir).expect("create platform directory");
        let session_path = project_dir.join("session-1.jsonl");
        fs::write(
            &session_path,
            serde_json::json!({
                "sessionId": "session-1",
                "cwd": dir.0,
                "message": { "role": "user", "content": "before" }
            })
            .to_string()
                + "\n",
        )
        .expect("write session fixture");

        let server = RemoteServerState::default();
        let mut config = RemoteServerConfig::loopback_ephemeral();
        config.enable_mutations = true;
        let status = server
            .start(config, test_context(&dir))
            .expect("start writable remote server");
        assert!(!status.read_only);
        let client = reqwest::blocking::Client::new();
        (0..50)
            .find_map(
                |_| match client.get(format!("{}/health", status.url)).send() {
                    Ok(response) => Some(response),
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                        None
                    }
                },
            )
            .expect("remote server becomes ready");

        let sessions: serde_json::Value = client
            .get(format!("{}/api/v1/sessions", status.url))
            .query(&[("platform", "claude"), ("limit", "10")])
            .send()
            .expect("request sessions")
            .error_for_status()
            .expect("sessions status")
            .json()
            .expect("sessions json");
        let session_key = sessions["data"]["items"][0]["sessionKey"]
            .as_str()
            .expect("authoritative session key")
            .to_string();
        let detail: serde_json::Value = client
            .get(format!("{}/api/v1/session-detail", status.url))
            .query(&[("platform", "claude"), ("sessionKey", session_key.as_str())])
            .send()
            .expect("request detail")
            .error_for_status()
            .expect("detail status")
            .json()
            .expect("detail json");
        assert_eq!(detail["data"]["blocks"][0]["editable"], true);
        let revision = detail["data"]["revision"]
            .as_str()
            .expect("revision")
            .to_string();
        let message_id = detail["data"]["blocks"][0]["editTarget"]
            .as_str()
            .expect("edit target")
            .to_string();
        let mutation = serde_json::json!({
            "deviceId": "device-1",
            "mutationId": "mutation-1",
            "platform": "claude",
            "sessionKey": session_key.clone(),
            "messageId": message_id,
            "content": "after",
            "expectedRevision": revision,
        });

        let applied: serde_json::Value = client
            .post(format!("{}/api/v1/mutations/session-edit", status.url))
            .json(&mutation)
            .send()
            .expect("apply mutation")
            .error_for_status()
            .expect("mutation status")
            .json()
            .expect("mutation json");
        assert_eq!(applied["data"]["applied"], true);

        let replay: serde_json::Value = client
            .post(format!("{}/api/v1/mutations/session-edit", status.url))
            .json(&mutation)
            .send()
            .expect("replay mutation")
            .error_for_status()
            .expect("replay status")
            .json()
            .expect("replay json");
        assert_eq!(replay["data"]["mutationId"], "mutation-1");

        let mut reused = mutation.clone();
        reused["content"] = serde_json::Value::String("different".to_string());
        let reused_response = client
            .post(format!("{}/api/v1/mutations/session-edit", status.url))
            .json(&reused)
            .send()
            .expect("reuse mutation id");
        assert_eq!(reused_response.status(), reqwest::StatusCode::CONFLICT);
        let reused_error: serde_json::Value = reused_response.json().expect("reuse error json");
        assert_eq!(reused_error["error"]["code"], "MUTATION_ID_REUSED");

        let mut stale = mutation.clone();
        stale["mutationId"] = serde_json::Value::String("mutation-2".to_string());
        let stale_response = client
            .post(format!("{}/api/v1/mutations/session-edit", status.url))
            .json(&stale)
            .send()
            .expect("submit stale mutation");
        assert_eq!(stale_response.status(), reqwest::StatusCode::CONFLICT);
        let stale_error: serde_json::Value = stale_response.json().expect("stale error json");
        assert_eq!(
            stale_error["error"]["code"],
            session_service::SESSION_REVISION_CONFLICT
        );
        assert_eq!(
            stale_error["error"]["currentRevision"]
                .as_str()
                .expect("current revision")
                .len(),
            64
        );

        let logs: serde_json::Value = client
            .get(format!("{}/api/v1/edit-log", status.url))
            .query(&[("platform", "claude"), ("sessionKey", session_key.as_str())])
            .send()
            .expect("request edit log")
            .error_for_status()
            .expect("edit log status")
            .json()
            .expect("edit log json");
        assert_eq!(logs["data"].as_array().expect("log array").len(), 1);
        assert_eq!(logs["data"][0]["newContent"], "after");

        server.stop().expect("stop remote server");
    }
}
