//! Home Share server (spec 013): one always-on Axum process for the API (and, later, the exported web app).

mod audit;
mod auth;
mod config;
mod csv;
mod db;
mod errors;
mod expense_input;
mod house;
mod input;
mod money;
mod notifications;
mod push;
mod push_messages;
mod recurrence;
mod system_defaults;
mod routes {
    pub mod account;
    pub mod activity;
    pub mod balances;
    pub mod expense_import;
    pub mod expense_more;
    pub mod expense_writes;
    pub mod expenses;
    pub mod groups;
    pub mod health;
    pub mod notifications;
    pub mod push;
    pub mod recurring;
    pub mod settlements;
    pub mod shopping;
    pub mod tags;
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
    pub vapid: Option<Arc<config::Vapid>>,
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
        .route("/api/balances", get(routes::balances::get))
        .route("/api/expenses", get(routes::expenses::list).post(routes::expense_writes::create))
        .route(
            "/api/expenses/{expense_id}",
            get(routes::expenses::get_one).put(routes::expense_writes::update).delete(routes::expense_writes::delete),
        )
        .route("/api/expenses/bulk-delete", axum::routing::post(routes::expense_more::bulk_delete))
        .route("/api/expenses/export", get(routes::expense_more::export))
        .route("/api/expenses/import", axum::routing::post(routes::expense_import::import))
        .route("/api/expenses/{expense_id}/history", get(routes::expense_more::history))
        .route("/api/categories", get(routes::tags::categories::list).post(routes::tags::categories::create))
        .route("/api/categories/{id}", axum::routing::delete(routes::tags::categories::delete))
        .route("/api/platforms", get(routes::tags::platforms::list).post(routes::tags::platforms::create))
        .route("/api/platforms/{id}", axum::routing::delete(routes::tags::platforms::delete))
        .route("/api/payment-methods", get(routes::tags::payment_methods::list).post(routes::tags::payment_methods::create))
        .route("/api/payment-methods/{id}", axum::routing::delete(routes::tags::payment_methods::delete))
        .route("/api/settlements", get(routes::settlements::get).post(routes::settlements::post))
        .route("/api/settlements/{settlement_id}", axum::routing::delete(routes::settlements::delete))
        .route("/api/groups", get(routes::groups::list).post(routes::groups::create))
        .route("/api/groups/join", axum::routing::post(routes::groups::join))
        .route("/api/groups/active", axum::routing::post(routes::groups::switch))
        .route("/api/groups/active/members", get(routes::groups::members))
        .route("/api/groups/active/members/{user_id}", axum::routing::delete(routes::groups::kick).patch(routes::groups::promote))
        .route("/api/groups/active/currency", axum::routing::post(routes::groups::currency))
        .route("/api/groups/active/regenerate-code", axum::routing::post(routes::groups::regenerate_code))
        .route("/api/groups/active/leave", axum::routing::post(routes::groups::leave))
        .route("/api/notifications", get(routes::notifications::list))
        .route("/api/notifications/unread-count", get(routes::notifications::unread_count))
        .route("/api/notifications/test", axum::routing::post(routes::push::test))
        .route("/api/notifications/read-all", axum::routing::post(routes::notifications::read_all))
        .route("/api/notifications/{notification_id}", axum::routing::patch(routes::notifications::mark_read).delete(routes::notifications::delete))
        .route("/api/notification-preferences", get(routes::notifications::get_preferences).put(routes::notifications::put_preference))
        .route("/api/push-subscriptions", axum::routing::post(routes::push::register).delete(routes::push::unregister))
        .route("/api/recurring-expenses", get(routes::recurring::list).post(routes::recurring::create))
        .route("/api/recurring-expenses/{id}", axum::routing::patch(routes::recurring::patch).delete(routes::recurring::delete))
        .route("/api/recurring-expenses/{id}/skips/{period}", axum::routing::put(routes::recurring::skip).delete(routes::recurring::unskip))
        .route("/api/activity", get(routes::activity::summary))
        .route("/api/revisions", get(routes::activity::detailed))
        .route("/api/auth/login", axum::routing::post(routes::account::login))
        .route("/api/auth/register", axum::routing::post(routes::account::register))
        .route("/api/auth/logout", axum::routing::post(routes::account::logout))
        .route("/api/auth/logout-all", axum::routing::post(routes::account::logout_all))
        .route("/api/auth/password", axum::routing::post(routes::account::password))
        .route("/api/auth/me", get(routes::account::me).patch(routes::account::update_me).delete(routes::account::delete_me))
        .route("/api/shopping-items", get(routes::shopping::list).post(routes::shopping::create))
        .route("/api/shopping-items/clear-purchased", axum::routing::delete(routes::shopping::clear_purchased))
        .route("/api/shopping-items/{item_id}", axum::routing::put(routes::shopping::update).delete(routes::shopping::delete))
        .route("/api/shopping-items/{item_id}/toggle", axum::routing::patch(routes::shopping::toggle))
        .route("/api/shopping-items/{item_id}/expenses", axum::routing::put(routes::shopping::replace_links))
        .layer(middleware::from_fn_with_state(state.clone(), api_gate))
        .with_state(state)
}

#[tokio::main]
async fn main() {
    let cfg = Config::from_env(|k| std::env::var(k).ok()).unwrap_or_else(|e| fail(&e));
    let state = AppState { pool: pool(&cfg), keys: Arc::new(auth::Keys::new(&cfg.jwt_secret)), vapid: cfg.vapid.map(Arc::new) };
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await.unwrap_or_else(|e| fail(&e.to_string()));
    axum::serve(listener, app(state)).await.unwrap_or_else(|e| fail(&e.to_string()));
}
