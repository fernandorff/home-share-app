//! Server failures go to Sentry and to one JSON log line, correlated by request id (spec 007, ADR 0008), like
//! handleApiError + captureServerError. The event is built here field by field, so only what the privacy defaults
//! allow can leave: the route, the status, the error code, the request id, the member's opaque publicId and the
//! error text after redaction (no headers, cookies, bodies, query strings, e-mails, tokens or push URLs).
//! Without SENTRY_DSN nothing is sent. Expected 4xx answers are never reported.

use crate::routes::push::PUSH_SERVICE_HOSTS;
use axum::{
    extract::{MatchedPath, Request},
    middleware::Next,
    response::Response,
};
use serde_json::{json, Value};
use std::{cell::RefCell, sync::LazyLock, time::Duration};

#[derive(Default, Clone)]
pub struct RequestContext {
    pub route: Option<String>,
    pub request_id: String,
    pub user: Option<String>,
}

tokio::task_local! {
    static CONTEXT: RefCell<RequestContext>;
}

/// Middleware: the matched route and a fresh request id for everything this request logs or reports.
pub async fn observe(request: Request, next: Next) -> Response {
    let route = request.extensions().get::<MatchedPath>().map(|p| p.as_str().to_string());
    let context = RequestContext { route, request_id: uuid::Uuid::now_v7().to_string(), user: None };
    CONTEXT.scope(RefCell::new(context), next.run(request)).await
}

/// setObservedUser: the opaque publicId is the only user data Sentry ever gets.
pub fn set_user(public_id: &str) {
    let _ = CONTEXT.try_with(|c| c.borrow_mut().user = Some(public_id.to_string()));
}

fn current() -> RequestContext {
    CONTEXT.try_with(|c| c.borrow().clone()).unwrap_or_default()
}

pub(crate) struct Dsn {
    key: String,
    pub(crate) envelope: String,
    raw: String,
}

pub(crate) static DSN: LazyLock<Option<Dsn>> = LazyLock::new(|| parse_dsn(&std::env::var("SENTRY_DSN").unwrap_or_default()));

/// https://<public key>@<host>/<project id>
pub(crate) fn parse_dsn(raw: &str) -> Option<Dsn> {
    let raw = raw.trim();
    let (scheme, rest) = raw.split_once("://")?;
    let (key, rest) = rest.split_once('@')?;
    let (host, project) = rest.rsplit_once('/')?;
    (!key.is_empty() && !host.is_empty() && !project.is_empty())
        .then(|| Dsn { key: key.to_string(), envelope: format!("{scheme}://{host}/api/{project}/envelope/"), raw: raw.to_string() })
}

pub(crate) static CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| reqwest::Client::builder().timeout(Duration::from_secs(5)).build().expect("Sentry HTTP client"));

fn is_push_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    PUSH_SERVICE_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// redactText: push endpoints keep only their origin; cookies, bearer tokens, JWTs and e-mails go.
pub fn redact(text: &str) -> String {
    let words: Vec<String> = text
        .split_inclusive(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .map(|chunk| {
            let (word, tail) = chunk.split_at(chunk.trim_end_matches(|c: char| c.is_whitespace() || c == '"' || c == '\'').len());
            let out = if let Some((scheme, rest)) = word.split_once("://").filter(|(s, _)| *s == "https" || *s == "http") {
                let cut = rest.find(['/', '?', '#']).unwrap_or(rest.len());
                let (authority, path) = rest.split_at(cut);
                let host = authority.rsplit('@').next().unwrap_or("").split(':').next().unwrap_or("");
                if is_push_host(host) && !(path.is_empty() || path == "/") { format!("{scheme}://{authority}/[Filtered]") } else { word.to_string() }
            } else if let Some((name, _)) = word.split_once('=').filter(|(n, _)| n.eq_ignore_ascii_case("homeshare_session") || n.eq_ignore_ascii_case("homeshare_group")) {
                format!("{name}=[Filtered]{}", if word.ends_with(';') { ";" } else { "" })
            } else if word.starts_with("eyJ") && word.matches('.').count() == 2 {
                "[jwt]".to_string()
            } else if word.contains('@') && word.rsplit('@').next().is_some_and(|d| d.contains('.')) && !word.starts_with('@') {
                "[email]".to_string()
            } else {
                word.to_string()
            };
            format!("{out}{tail}")
        })
        .collect();
    let joined = words.concat();
    // "Bearer <token>"
    let mut out = String::new();
    let mut rest = joined.as_str();
    while let Some(at) = rest.find("Bearer ") {
        out.push_str(&rest[..at + 7]);
        let after = &rest[at + 7..];
        let end = after.find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',').unwrap_or(after.len());
        out.push_str(if end > 0 { "[Filtered]" } else { "" });
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// The Sentry event for a server failure: only allow-listed fields.
pub fn event(message: &str, error: &str, status: u16, code: Option<&str>, context: &RequestContext) -> Value {
    let mut tags = json!({ "http_status": status.to_string(), "request_id": context.request_id });
    if let Some(route) = &context.route {
        tags["route"] = json!(route);
    }
    if let Some(code) = code {
        tags["api_error_code"] = json!(code);
    }
    let mut event = json!({
        "event_id": uuid::Uuid::now_v7().simple().to_string(),
        "timestamp": chrono::Utc::now().timestamp_millis() as f64 / 1000.0,
        "platform": "other",
        "level": "error",
        "logger": "home-share-server",
        "environment": std::env::var("SENTRY_ENVIRONMENT").ok().filter(|e| !e.trim().is_empty()).unwrap_or_else(|| "development".into()),
        "exception": { "values": [{ "type": message, "value": redact(error) }] },
        "tags": tags,
    });
    if let Ok(release) = std::env::var("SENTRY_RELEASE") {
        event["release"] = json!(release);
    }
    if let Some(user) = &context.user {
        event["user"] = json!({ "id": user });
    }
    event
}

/// handleApiError for an unexpected failure: one Sentry event (when configured) and one JSON log line.
pub fn report(message: &str, error: &dyn std::fmt::Display, status: u16, code: Option<&str>) {
    let context = current();
    let text = error.to_string();
    let mut sentry_event_id = None;
    if let Some(dsn) = DSN.as_ref() {
        let event = event(message, &text, status, code, &context);
        sentry_event_id = event["event_id"].as_str().map(str::to_string);
        let envelope = format!(
            "{}\n{}\n{}\n",
            json!({ "event_id": event["event_id"], "dsn": dsn.raw }),
            json!({ "type": "event" }),
            event
        );
        let auth = format!("Sentry sentry_version=7, sentry_key={}, sentry_client=home-share-server/0.1", dsn.key);
        let url = dsn.envelope.clone();
        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::spawn(async move {
                // Best effort: delivery never fails the answer.
                let _ = CLIENT.post(url).header("X-Sentry-Auth", auth).header("Content-Type", "application/x-sentry-envelope").body(envelope).send().await;
            });
        }
    }
    let line = json!({
        "level": "error", "msg": message, "route": context.route, "requestId": context.request_id, "status": status,
        "code": code, "sentryEventId": sentry_event_id, "error": redact(text.lines().last().unwrap_or("")),
    });
    eprintln!("{line}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_like_redact_text() {
        assert_eq!(redact("dup key (email)=(ana@example.com) exists"), "dup key [email] exists");
        assert_eq!(redact("POST https://fcm.googleapis.com/fcm/send/abc failed"), "POST https://fcm.googleapis.com/[Filtered] failed");
        assert_eq!(redact("https://example.com/x stays"), "https://example.com/x stays");
        assert_eq!(redact("cookie homeshare_session=eyJa.b.c; x"), "cookie homeshare_session=[Filtered]; x");
        assert_eq!(redact("Authorization: Bearer abc.def"), "Authorization: Bearer [Filtered]");
        assert_eq!(redact("token eyJhbGc.eyJzdWIi.sig"), "token [jwt]");
    }

    #[test]
    fn event_carries_only_allowed_fields() {
        let context = RequestContext { route: Some("/api/expenses".into()), request_id: "r1".into(), user: Some("pub-1".into()) };
        let e = event("Failed to create expense", "db error: ana@example.com", 500, None, &context);
        let keys: Vec<&str> = e.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["event_id", "timestamp", "platform", "level", "logger", "environment", "exception", "tags", "user"]);
        assert_eq!(e["user"], json!({ "id": "pub-1" }));
        assert_eq!(e["exception"]["values"][0]["value"], "db error: [email]");
        assert_eq!(e["tags"], json!({ "http_status": "500", "request_id": "r1", "route": "/api/expenses" }));
    }

    #[test]
    fn dsn() {
        let d = parse_dsn("https://k3y@o1.ingest.sentry.io/42").unwrap();
        assert_eq!((d.key.as_str(), d.envelope.as_str()), ("k3y", "https://o1.ingest.sentry.io/api/42/envelope/"));
        assert!(parse_dsn("").is_none());
    }
}
