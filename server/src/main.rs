//! Home Share server (spec 013): one always-on Axum process for the API (and, later, the exported web app).

mod config;
mod routes {
    pub mod health;
}

use axum::{routing::get, Router};
use config::Config;
use deadpool_postgres::{Manager, Pool};
use std::str::FromStr;

#[derive(Clone)]
pub struct AppState {
    pub pool: Pool,
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
    Router::new().route("/api/health", get(routes::health::get)).with_state(state)
}

#[tokio::main]
async fn main() {
    let cfg = Config::from_env(|k| std::env::var(k).ok()).unwrap_or_else(|e| fail(&e));
    let state = AppState { pool: pool(&cfg) };
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await.unwrap_or_else(|e| fail(&e.to_string()));
    axum::serve(listener, app(state)).await.unwrap_or_else(|e| fail(&e.to_string()));
}
