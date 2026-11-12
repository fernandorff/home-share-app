//! The web app from the same process (spec 013, task 4.2, criteria 18-19): the Vite build in `WEB_DIR` (`npm run
//! build` → `dist/`), the page gate of `src/middleware.ts`, and the redirects, headers and Sentry tunnel of
//! `next.config.ts`. The Next app keeps its own copies on the `-next` host (task 5.3).

use crate::{
    auth::{self, Keys, GROUP_COOKIE, SESSION_COOKIE},
    observability, AppState,
};
use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use std::path::PathBuf;
use tower::ServiceExt;
use tower_http::services::ServeDir;

/// redirects() in next.config.ts: the page routes renamed from Portuguese, 308 like `permanent: true`.
const RENAMES: [(&str, &str); 8] = [
    ("despesas", "expenses"),
    ("saldos", "balances"),
    ("compras", "shopping"),
    ("catalogos", "catalogs"),
    ("atividade", "activity"),
    ("casa", "house"),
    ("conta", "settings/account"),
    ("account", "settings/account"),
];

/// CSP_PROD in next.config.ts.
const CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; \
font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/// headers() in next.config.ts, for every response. CSP and HSTS always: this server only ever serves the built app
/// (Next adds them for `NODE_ENV=production`, i.e. every deploy). X-Robots-Tag everywhere but production
/// (`APP_ENV=production`, the VERCEL_ENV rule of src/lib/deploy/robots.ts).
pub fn security_headers(production: bool) -> Vec<(HeaderName, HeaderValue)> {
    let mut headers = vec![
        (header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY")),
        (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
        (header::REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin")),
        (HeaderName::from_static("permissions-policy"), HeaderValue::from_static("camera=(), microphone=(), geolocation=()")),
        (header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP)),
        (header::STRICT_TRANSPORT_SECURITY, HeaderValue::from_static("max-age=63072000; includeSubDomains")),
    ];
    if !production {
        headers.push((HeaderName::from_static("x-robots-tag"), HeaderValue::from_static("noindex, nofollow")));
    }
    headers
}

pub async fn add_security_headers(State(headers): State<std::sync::Arc<Vec<(HeaderName, HeaderValue)>>>, request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    for (name, value) in headers.iter() {
        response.headers_mut().insert(name, value.clone());
    }
    response
}

/// Next's default `trailingSlash: false`: `/expenses/` → 308 `/expenses`, query kept, before anything else runs.
pub async fn strip_trailing_slash(request: Request, next: Next) -> Response {
    match trailing_slash_target(request.uri().path(), request.uri().query()) {
        Some(to) => redirect(StatusCode::PERMANENT_REDIRECT, &to, vec![]),
        None => next.run(request).await,
    }
}

fn trailing_slash_target(path: &str, query: Option<&str>) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.len() == path.len() || trimmed.is_empty() {
        return None;
    }
    Some(match query {
        Some(q) => format!("{trimmed}?{q}"),
        None => trimmed.to_string(),
    })
}

/// The old paths, `/` and the tunnel, then every other path through the files and the page gate.
pub fn routes(router: Router<AppState>, web_dir: PathBuf) -> Router<AppState> {
    let router = RENAMES.iter().fold(router, |r, (from, to)| {
        r.route(&format!("/{from}"), get(move |request: Request| async move { redirect(StatusCode::PERMANENT_REDIRECT, &with_query(to, &request), vec![]) }))
    });
    let files = ServeDir::new(&web_dir).append_index_html_on_directories(false);
    let index = web_dir.join("index.html");
    router
        .route("/monitoring", post(tunnel))
        .fallback(move |State(state): State<AppState>, request: Request| web(state, files.clone(), index.clone(), request))
}

fn with_query(to: &str, request: &Request) -> String {
    match request.uri().query() {
        Some(q) => format!("/{to}?{q}"),
        None => format!("/{to}"),
    }
}

fn redirect(status: StatusCode, location: &str, cookies: Vec<String>) -> Response {
    let mut response = (status, [(header::LOCATION, location)]).into_response();
    for c in cookies {
        response.headers_mut().append(header::SET_COOKIE, HeaderValue::from_str(&c).expect("cookie header"));
    }
    response
}

/// Hashed bundles never change; everything else (index.html, sw.js, manifest, icons) is checked on every load.
fn cache_control(path: &str) -> &'static str {
    if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

async fn web(state: AppState, files: ServeDir, index: PathBuf, request: Request) -> Response {
    let path = request.uri().path().to_string();
    // Unknown API paths stay a plain 404, never the app.
    if path == "/api" || path.starts_with("/api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let headers = request.headers().clone();
    let is_read = matches!(*request.method(), Method::GET | Method::HEAD);
    let mut response = files.oneshot(request).await.map(|r| r.map(Body::new)).unwrap_or_else(|e| match e {});
    if response.status() != StatusCode::NOT_FOUND {
        if response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED {
            response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_control(&path)));
        }
        return response;
    }
    // A missing file (the last segment has an extension) is a 404, not the app.
    if !is_read || path.rsplit('/').next().is_some_and(|last| last.contains('.')) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let now = chrono::Utc::now().timestamp();
    let (to, cookies) = gate(&state.keys, &headers, &path, now);
    if let Some(to) = to {
        return redirect(StatusCode::TEMPORARY_REDIRECT, to, cookies);
    }
    match tokio::fs::read(&index).await {
        Ok(html) => {
            let mut response =
                ([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")], html).into_response();
            for c in cookies {
                response.headers_mut().append(header::SET_COOKIE, HeaderValue::from_str(&c).expect("cookie header"));
            }
            response
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// middleware.ts for a page: `/auth/*` is public (signed in → /expenses), every other page needs a session
/// (none → /auth/login), and a signed-in page view renews the cookie at most once a day (ADR 0013) with the
/// house preference. `/` lands on /expenses (src/app/page.tsx). Only the JWT is checked, never the database.
fn gate(keys: &Keys, headers: &HeaderMap, path: &str, now: i64) -> (Option<&'static str>, Vec<String>) {
    let session = auth::read_cookie(headers, SESSION_COOKIE).and_then(|t| keys.verify(t));
    let Some(claims) = session else {
        return (if path.starts_with("/auth") { None } else { Some("/auth/login") }, vec![]);
    };
    if path.starts_with("/auth") {
        return (Some("/expenses"), vec![]);
    }
    let mut cookies = vec![];
    if let Some(token) = keys.renewed(&claims, now) {
        cookies.push(auth::cookie(SESSION_COOKIE, &token));
        if let Some(group) = auth::read_cookie(headers, GROUP_COOKIE) {
            cookies.push(auth::cookie(GROUP_COOKIE, group));
        }
    }
    (if path == "/" { Some("/expenses") } else { None }, cookies)
}

/// The browser SDK's same-origin tunnel (`tunnel: "/monitoring"`): the envelope's first line names its DSN, and only
/// envelopes for our own Sentry project (SENTRY_DSN) are forwarded. Public, like the middleware matcher.
async fn tunnel(body: Bytes) -> StatusCode {
    let Some(target) = observability::DSN.as_ref().map(|d| d.envelope.clone()) else {
        return StatusCode::NOT_FOUND;
    };
    if tunnel_target(&body).as_deref() != Some(target.as_str()) {
        return StatusCode::BAD_REQUEST;
    }
    match observability::CLIENT.post(target).header(header::CONTENT_TYPE, "application/x-sentry-envelope").body(body).send().await {
        Ok(r) => StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
        Err(_) => StatusCode::BAD_GATEWAY,
    }
}

/// The envelope URL of the DSN in the envelope header (its first line).
fn tunnel_target(body: &[u8]) -> Option<String> {
    let first = body.split(|b| *b == b'\n').next()?;
    let header: serde_json::Value = serde_json::from_slice(first).ok()?;
    observability::parse_dsn(header.get("dsn")?.as_str()?).map(|d| d.envelope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Claims;

    fn keys() -> Keys {
        Keys::new("test-secret")
    }

    fn cookies(session: Option<&str>, group: Option<&str>) -> HeaderMap {
        let mut parts = vec![];
        if let Some(s) = session {
            parts.push(format!("{SESSION_COOKIE}={s}"));
        }
        if let Some(g) = group {
            parts.push(format!("{GROUP_COOKIE}={g}"));
        }
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_str(&parts.join("; ")).unwrap());
        h
    }

    fn token(iat: i64) -> String {
        let claims = Claims { user_id: 1, public_id: "p".into(), name: "A".into(), session_version: 0, auth_at: None, iat, exp: None };
        keys().sign(&claims, iat, iat)
    }

    #[test]
    fn old_account_urls_go_straight_to_settings_account() {
        // Spec 011 (criteria 1, 8): permanent, no chain through another rename.
        for from in ["account", "conta"] {
            assert!(RENAMES.contains(&(from, "settings/account")), "{from}");
        }
        assert!(RENAMES.iter().all(|(_, to)| !RENAMES.iter().any(|(from, _)| from == to)));
    }

    #[test]
    fn page_gate_matches_the_middleware() {
        let now = chrono::Utc::now().timestamp();
        let fresh = token(now);
        let none = cookies(None, None);
        assert_eq!(gate(&keys(), &none, "/expenses", now), (Some("/auth/login"), vec![]));
        assert_eq!(gate(&keys(), &none, "/", now), (Some("/auth/login"), vec![]));
        assert_eq!(gate(&keys(), &none, "/auth/login", now), (None, vec![]));
        assert_eq!(gate(&keys(), &cookies(Some("garbage"), None), "/balances", now), (Some("/auth/login"), vec![]));
        let signed_in = cookies(Some(&fresh), Some("7"));
        assert_eq!(gate(&keys(), &signed_in, "/auth/register", now), (Some("/expenses"), vec![]));
        assert_eq!(gate(&keys(), &signed_in, "/balances", now), (None, vec![]));
        assert_eq!(gate(&keys(), &signed_in, "/", now), (Some("/expenses"), vec![]));
    }

    #[test]
    fn a_page_view_renews_a_day_old_session_with_the_house() {
        let now = chrono::Utc::now().timestamp();
        let old = token(now - auth::SESSION_RENEW_AFTER_SECONDS);
        let (to, set) = gate(&keys(), &cookies(Some(&old), Some("7")), "/shopping", now);
        assert_eq!(to, None);
        assert_eq!(set.len(), 2);
        assert!(set[0].starts_with("homeshare_session=") && !set[0].contains(&old));
        assert_eq!(set[1], auth::cookie(GROUP_COOKIE, "7"));
        let (_, without_house) = gate(&keys(), &cookies(Some(&old), None), "/shopping", now);
        assert_eq!(without_house.len(), 1);
    }

    #[test]
    fn a_trailing_slash_redirects_like_next() {
        assert_eq!(trailing_slash_target("/expenses/", Some("x=1")).as_deref(), Some("/expenses?x=1"));
        assert_eq!(trailing_slash_target("/settings/account/", None).as_deref(), Some("/settings/account"));
        assert_eq!(trailing_slash_target("/", None), None);
        assert_eq!(trailing_slash_target("/expenses", None), None);
    }

    #[test]
    fn hashed_assets_are_immutable_the_rest_revalidates() {
        assert_eq!(cache_control("/assets/index-a1b2.js"), "public, max-age=31536000, immutable");
        for p in ["/sw.js", "/manifest.json", "/icons/icon-192.png", "/icon.svg"] {
            assert_eq!(cache_control(p), "no-cache");
        }
    }

    #[test]
    fn robots_only_outside_production() {
        let names = |prod| security_headers(prod).into_iter().map(|(n, _)| n.to_string()).collect::<Vec<_>>();
        assert!(names(false).contains(&"x-robots-tag".to_string()));
        assert!(!names(true).contains(&"x-robots-tag".to_string()));
        assert!(names(true).contains(&"content-security-policy".to_string()));
        assert!(names(true).contains(&"strict-transport-security".to_string()));
    }

    #[test]
    fn tunnel_reads_the_dsn_of_the_envelope_header() {
        let body = b"{\"event_id\":\"x\",\"dsn\":\"https://k3y@o1.ingest.sentry.io/42\"}\n{\"type\":\"event\"}\n{}";
        assert_eq!(tunnel_target(body).as_deref(), Some("https://o1.ingest.sentry.io/api/42/envelope/"));
        assert_eq!(tunnel_target(b"{\"event_id\":\"x\"}\n{}"), None);
        assert_eq!(tunnel_target(b"not json"), None);
    }
}
