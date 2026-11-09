//! This device's push subscription (spec 010): same answers and rows as src/app/api/push-subscriptions and
//! pushService.register/unregister. A subscription belongs to a person (no house); the owner always comes from the
//! session and the answer never echoes the endpoint or the keys.

use crate::{auth::Session, errors::ApiError, AppState};
use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

const MAX_SUBSCRIPTIONS: i64 = 10;
const MAX_ENDPOINT_LENGTH: usize = 1024;
const LOCALES: [&str; 4] = ["en", "pt", "es", "fr"];
pub const PUSH_SERVICE_HOSTS: [&str; 4] = ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

pub fn not_configured() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "Push notifications are not configured", "PUSH_NOT_CONFIGURED")
}

/// isJsonRequest (CSRF): a form or a no-cors fetch cannot send application/json.
pub fn require_json(headers: &HeaderMap) -> Result<(), ApiError> {
    let kind = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
    if kind.starts_with("application/json") {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Send application/json", "UNSUPPORTED_MEDIA_TYPE"))
    }
}

fn invalid() -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "Invalid push subscription", "PUSH_SUBSCRIPTION_INVALID")
}

fn is_push_host(host: &str) -> bool {
    let charset = !host.is_empty() && host.split('.').all(|label| !label.is_empty() && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'));
    charset && PUSH_SERVICE_HOSTS.iter().any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

/// isAllowedPushEndpoint: https, no userinfo or port, an allow-listed push host, and already in the exact form the
/// WHATWG URL parser would print (`url.href === value`). Anything the parser would rewrite is refused here.
pub fn allowed_endpoint(value: &str) -> bool {
    if value.encode_utf16().count() > MAX_ENDPOINT_LENGTH {
        return false;
    }
    let Some(rest) = value.strip_prefix("https://") else { return false };
    let split = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (host, tail) = rest.split_at(split);
    // A bare host gets a "/" appended by the parser, so it is never already in printed form.
    if !tail.starts_with('/') || !is_push_host(host) {
        return false;
    }
    let path = &tail[..tail.find(['?', '#']).unwrap_or(tail.len())];
    let dot_segment = path.split('/').any(|s| matches!(s.to_ascii_lowercase().as_str(), "." | ".." | "%2e" | ".%2e" | "%2e." | "%2e%2e"));
    let printable = tail.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~!$&()*+,;=:@/%?#".contains(&b));
    printable && !dot_segment
}

fn is_key(value: &Value, chars: usize) -> Option<String> {
    let s = value.as_str()?;
    (s.len() == chars && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).then(|| s.to_string())
}

struct Subscription {
    endpoint: String,
    p256dh: String,
    auth: String,
    locale: Option<String>,
}

/// parsePushSubscription: `{ endpoint, keys: { p256dh, auth }, locale? }`; the keys are a 65-byte P-256 public key and a
/// 16-byte secret in unpadded base64url (87 and 22 characters).
fn parse(body: &Value) -> Option<Subscription> {
    if !body.is_object() {
        return None;
    }
    let endpoint = body["endpoint"].as_str().filter(|e| allowed_endpoint(e))?.to_string();
    let keys = body.get("keys").filter(|k| k.is_object())?;
    let (p256dh, auth) = (is_key(&keys["p256dh"], 87)?, is_key(&keys["auth"], 22)?);
    let locale = match body.get("locale") {
        None => None,
        Some(v) => Some(v.as_str().filter(|l| LOCALES.contains(l))?.to_string()),
    };
    Some(Subscription { endpoint, p256dh, auth, locale })
}

/// pushService.register: one row per endpoint (moved to whoever registers it last, keys and locale refreshed; without
/// a locale a known row keeps its own), then the cap of 10 by least recent (re)registration. The member's row is locked
/// and its sessionVersion re-read first: a logout committing meanwhile wins and nothing is stored (401).
pub async fn register(State(state): State<AppState>, Session(session): Session, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to save push subscription", e);
    if state.vapid.is_none() {
        return Err(not_configured());
    }
    require_json(&headers)?;
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let input = parse(&body).ok_or_else(invalid)?;
    let me = session.user_id as i32;
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let version: Option<i32> = tx
        .query_opt(r#"SELECT "sessionVersion" FROM "User" WHERE "id" = $1 FOR UPDATE"#, &[&me])
        .await
        .map_err(|e| fail(&e))?
        .map(|r| r.get(0));
    if version.map(i64::from) != Some(session.session_version) {
        drop(tx);
        return Err(ApiError {
            set_cookie: Some("homeshare_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"),
            ..ApiError::new(StatusCode::UNAUTHORIZED, "Session expired, please log in again", "SESSION_REVOKED")
        });
    }
    let saved: i32 = tx
        .query_one(
            r#"INSERT INTO "PushSubscription" ("userId", "endpoint", "p256dh", "auth", "locale", "updatedAt")
               VALUES ($1, $2, $3, $4, COALESCE($5, 'en'), now() AT TIME ZONE 'UTC')
               ON CONFLICT ("endpoint") DO UPDATE SET "userId" = EXCLUDED."userId", "p256dh" = EXCLUDED."p256dh", "auth" = EXCLUDED."auth",
                 "locale" = COALESCE($5, "PushSubscription"."locale"), "updatedAt" = EXCLUDED."updatedAt"
               RETURNING "id""#,
            &[&me, &input.endpoint, &input.p256dh, &input.auth, &input.locale],
        )
        .await
        .map_err(|e| fail(&e))?
        .get(0);
    tx.execute(
        r#"DELETE FROM "PushSubscription" WHERE "id" IN (
             SELECT "id" FROM "PushSubscription" WHERE "userId" = $1 AND "id" <> $2 ORDER BY "updatedAt" DESC, "id" DESC OFFSET $3)"#,
        &[&me, &saved, &(MAX_SUBSCRIPTIONS - 1)],
    )
    .await
    .map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))).into_response())
}

/// pushService.unregister: the caller's row for that endpoint, if any. Works while push is unconfigured.
pub async fn unregister(State(state): State<AppState>, Session(session): Session, headers: HeaderMap, body: Bytes) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to remove push subscription", e);
    require_json(&headers)?;
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let endpoint = body.get("endpoint").and_then(Value::as_str).filter(|e| body.is_object() && allowed_endpoint(e)).ok_or_else(invalid)?;
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    db.execute(r#"DELETE FROM "PushSubscription" WHERE "userId" = $1 AND "endpoint" = $2"#, &[&(session.user_id as i32), &endpoint])
        .await
        .map_err(|e| fail(&e))?;
    Ok(Json(json!({ "ok": true })))
}

/// "Send test notice" (spec 010): one push to every subscription of the session user, each in its locale; 1 per 10 s.
pub async fn test(State(state): State<AppState>, Session(session): Session, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to send the test notice", e);
    // Before the rate limit, so a deployment without push never spends the member's bucket; a refused form neither.
    let Some(vapid) = state.vapid.clone() else { return Err(not_configured()) };
    require_json(&headers)?;
    let me = session.user_id as i32;
    if !crate::rate_limit::allow(format!("push:test:{me}"), 1, std::time::Duration::from_secs(10)) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "Too many test notices. Try again shortly.", "RATE_LIMITED"));
    }
    let subs = crate::push::subscriptions(&state, &[me]).await.map_err(|e| fail(&e))?;
    if subs.is_empty() {
        return Err(ApiError::new(StatusCode::CONFLICT, "No push subscription for this account", "NO_PUSH_SUBSCRIPTION"));
    }
    let deliveries = subs.into_iter().map(|s| { let p = crate::push::test_payload(&s.locale); (s, p) }).collect();
    let (sent, failed) = crate::push::deliver(&state, &vapid, deliveries).await;
    Ok(Json(json!({ "sent": sent, "failed": failed })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_like_the_url_parser() {
        assert!(allowed_endpoint("https://fcm.googleapis.com/fcm/send/abc:DEF-123_x"));
        assert!(allowed_endpoint("https://updates.push.services.mozilla.com/wpush/v2/gAAAA"));
        assert!(allowed_endpoint("https://db5p.notify.windows.com/w/?token=AwYAAAB%2b"));
        assert!(!allowed_endpoint("https://fcm.googleapis.com"));
        assert!(!allowed_endpoint("http://fcm.googleapis.com/x"));
        assert!(!allowed_endpoint("https://FCM.googleapis.com/x"));
        assert!(!allowed_endpoint("https://fcm.googleapis.com:443/x"));
        assert!(!allowed_endpoint("https://a@fcm.googleapis.com/x"));
        assert!(!allowed_endpoint("https://evilfcm.googleapis.com.example.com/x"));
        assert!(!allowed_endpoint("https://example.com/fcm.googleapis.com"));
        assert!(!allowed_endpoint("https://fcm.googleapis.com/a/../b"));
        assert!(!allowed_endpoint("https://fcm.googleapis.com/a b"));
    }
}
