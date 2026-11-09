//! Home Share server (spec 013): one always-on Axum process for the API (and, later, the exported web app).

mod auth;
mod config;
mod db;
mod errors;
mod house;
mod money;
mod routes {
    pub mod health;
}

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use config::Config;
use deadpool_postgres::{Manager, Pool};
use std::{str::FromStr, sync::Arc};

#[derive(Clone)]
pub struct AppState {
    pub pool: Pool,
    pub keys: Arc<auth::Keys>,
}

// Routes that authenticate themselves (src/middleware.ts): login/register, health, and the cron jobs (bearer).
const PUBLIC_API_PREFIXES: [&str; 3] = ["/api/auth", "/api/health", "/api/cron/"];

/// The middleware's API gate: no or invalid JWT → 401 with no `code` (unlike requireSession), no DB read.
async fn api_gate(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let public = PUBLIC_API_PREFIXES.iter().any(|p| path.starts_with(p));
    let signed_in = auth::read_cookie(request.headers(), auth::SESSION_COOKIE).and_then(|t| state.keys.verify(t)).is_some();
    if !public && path.starts_with("/api") && !signed_in {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "Not authenticated" }))).into_response();
    }
    next.run(request).await
}

fn pool(cfg: &Config) -> Pool {
    // TLS when the URL asks for it (Neon: sslmode=require); a local database without TLS still connects.
    let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let tls = rustls::ClientConfig::builder_with_provider(rustls::crypto::ring::default_provider().into())
        .with_safe_default_protocol_versions()
        .expect("TLS protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    let pg = tokio_postgres::Config::from_str(&cfg.database_url).unwrap_or_else(|_| fail("DATABASE_URL is not a valid Postgres URL"));
    let mgr = Manager::new(pg, tokio_postgres_rustls::MakeRustlsConnect::new(tls));
    Pool::builder(mgr).max_size(cfg.pool_max).build().expect("pool")
}

fn fail(message: &str) -> ! {
    eprintln!("home-share-server: {message}");
    std::process::exit(1)
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(routes::health::get))
        .layer(middleware::from_fn_with_state(state.clone(), api_gate))
        .with_state(state)
}

#[tokio::main]
async fn main() {
    let cfg = Config::from_env(|k| std::env::var(k).ok()).unwrap_or_else(|e| fail(&e));
    let state = AppState { pool: pool(&cfg), keys: Arc::new(auth::Keys::new(&cfg.jwt_secret)) };
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await.unwrap_or_else(|e| fail(&e.to_string()));
    axum::serve(listener, app(state)).await.unwrap_or_else(|e| fail(&e.to_string()));
}
