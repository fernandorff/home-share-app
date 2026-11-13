//! Auth basics (criteria 5–9), driven by the handler list so each entry is checked against a real extractor.

use super::*;
use crate::auth::Claims;

fn is_auth(path: &str) -> bool {
    path.starts_with("/api/auth")
}

/// No cookie, garbage, an expired token and a token signed with another secret, all for Alice's real id.
fn bad_cookies(alice: &User) -> Vec<Option<String>> {
    let claims = Claims { user_id: alice.id as i64, public_id: alice.public_id.clone(), name: alice.name.clone(), session_version: 0, auth_at: None, iat: 0, exp: None };
    let now = chrono::Utc::now().timestamp();
    let month_ago = now - 31 * 24 * 60 * 60;
    let expired = Keys::new(SECRET).sign(&claims, month_ago, month_ago);
    let foreign = Keys::new("another-secret").sign(&claims, now, now);
    [None, Some("garbage"), Some(expired.as_str()), Some(foreign.as_str())].map(|t| t.map(|t| format!("{SESSION_COOKIE}={t}"))).into()
}

/// Criteria 5 and 6.
#[tokio::test]
async fn requests_without_a_valid_session_are_refused() {
    let fx = two_houses().await;
    let (before_a, before_b) = (fingerprint(&fx.state, fx.a.id).await, fingerprint(&fx.state, fx.b.id).await);
    let gated: Vec<_> = HANDLERS.iter().filter(|h| matches!(h.2, Guard::House | Guard::Session)).collect();
    assert_eq!((gated.iter().filter(|h| !is_auth(h.1)).count(), gated.iter().filter(|h| is_auth(h.1)).count()), (57, 5));
    for cookie in bad_cookies(&fx.alice) {
        for (method, path, _) in &gated {
            let res = request(&fx.app, method, &fill(path), cookie.as_deref(), body_for(method)).await;
            if is_auth(path) {
                res.refused(401, "NOT_AUTHENTICATED");
            } else {
                assert_eq!(res.is(401).text, r#"{"error":"Not authenticated"}"#);
            }
        }
    }
    unchanged(&fx.state, fx.a.id, &before_a).await;
    unchanged(&fx.state, fx.b.id, &before_b).await;
}

/// Criterion 7.
#[tokio::test]
async fn a_revoked_session_is_refused_everywhere() {
    let fx = two_houses().await;
    let alice = fx.alice.in_house(fx.a.id);
    alice.send("POST", "/api/auth/logout-all", json!({})).await.is(200);
    let before = fingerprint(&fx.state, fx.a.id).await;
    let session: Vec<_> = HANDLERS.iter().filter(|h| matches!(h.2, Guard::House | Guard::Session)).collect();
    assert_eq!(session.len(), 62);
    for (method, path, _) in session {
        let res = alice.send(method, &fill(path), body_for(method)).await.refused(401, "SESSION_REVOKED");
        assert_eq!(res.cookie(SESSION_COOKIE).as_deref(), Some(""), "{method} {path} must clear the session cookie");
    }
    unchanged(&fx.state, fx.a.id, &before).await;
}

/// Criterion 8.
#[tokio::test]
async fn a_person_without_a_house_gets_no_group() {
    let (app, _) = server();
    let loner = register(&app, "Lone", &suffix()).await;
    let house: Vec<_> = HANDLERS.iter().filter(|h| h.2 == Guard::House).collect();
    assert_eq!(house.len(), 48);
    for (method, path, _) in house {
        loner.send(method, &fill(path), body_for(method)).await.refused(403, "NO_GROUP");
    }
}

/// Criterion 9 (the suite never sets CRON_SECRET; a wrong bearer is refused either way).
#[tokio::test]
async fn cron_routes_need_their_bearer() {
    let fx = two_houses().await;
    let (before_a, before_b) = (fingerprint(&fx.state, fx.a.id).await, fingerprint(&fx.state, fx.b.id).await);
    let cron: Vec<_> = HANDLERS.iter().filter(|h| h.2 == Guard::Bearer).collect();
    assert_eq!(cron.len(), 2);
    for (method, path, _) in cron {
        request(&fx.app, method, path, None, Value::Null).await.refused(401, "CRON_UNAUTHORIZED");
        request(&fx.app, method, path, Some(&fx.alice.cookie()), Value::Null).await.refused(401, "CRON_UNAUTHORIZED");
        let wrong = Request::builder().method(*method).uri(*path).header(header::AUTHORIZATION, "Bearer not-the-secret").body(Body::empty()).unwrap();
        assert_eq!(fx.app.clone().oneshot(wrong).await.unwrap().status(), StatusCode::UNAUTHORIZED, "{method} {path} with a wrong bearer");
    }
    unchanged(&fx.state, fx.a.id, &before_a).await;
    unchanged(&fx.state, fx.b.id, &before_b).await;
}
