//! Web Push delivery (spec 010, ADR 0011), what src/services/push.service.ts and src/lib/push/payload.ts do with the
//! web-push package: a best-effort, privacy-reduced copy of each notice, encrypted for the device (RFC 8291,
//! aes128gcm) and signed for the push service (RFC 8292, VAPID). Never retried; a failure costs only the push.

use crate::{config::Vapid, push_messages, routes::push::allowed_endpoint, AppState};
use aes_gcm::{aead::Aead, Aes128Gcm, KeyInit};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use hkdf::Hkdf;
use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey},
    elliptic_curve::sec1::ToEncodedPoint,
    PublicKey, SecretKey,
};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{sync::LazyLock, time::Duration};
use unicode_segmentation::UnicodeSegmentation;

const CONCURRENCY: usize = 10;
/// A notice older than a day is not worth a banner; the center still has it.
const TTL_SECONDS: u32 = 86_400;
const RECORD_SIZE: u32 = 4096;
const APP_NAME: &str = "Home Share";
const MAX_TITLE: usize = 40;
const MAX_DESCRIPTION: usize = 60;
const MAX_ACTOR: usize = 40;
const UNITS_PER_CHARACTER: usize = 8;

static CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("push HTTP client"));

// ---- encryption (RFC 8291) ----

/// The aes128gcm body for one device, with the sender key and salt given (tests pin them to the RFC's example).
pub fn encrypt_with(ua_public: &[u8], auth: &[u8], plaintext: &[u8], sender: &SecretKey, salt: [u8; 16]) -> Result<Vec<u8>, String> {
    let ua = PublicKey::from_sec1_bytes(ua_public).map_err(|_| "bad p256dh")?;
    let as_public = sender.public_key().to_encoded_point(false);
    let shared = p256::ecdh::diffie_hellman(sender.to_nonzero_scalar(), ua.as_affine());
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public.as_bytes());
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes()).expand(&key_info, &mut ikm).map_err(|_| "hkdf")?;
    let content = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
    content.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|_| "hkdf")?;
    content.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|_| "hkdf")?;
    let mut record = plaintext.to_vec();
    record.push(2); // last-record padding delimiter
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| "aes key")?;
    let sealed = cipher.encrypt(nonce.as_slice().into(), record.as_slice()).map_err(|_| "aes-gcm")?;
    let mut body = salt.to_vec();
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.as_bytes().len() as u8);
    body.extend_from_slice(as_public.as_bytes());
    body.extend_from_slice(&sealed);
    Ok(body)
}

fn encrypt(p256dh: &str, auth: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let (ua_public, auth) = (B64.decode(p256dh).map_err(|_| "bad p256dh")?, B64.decode(auth).map_err(|_| "bad auth")?);
    let mut salt = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut salt);
    encrypt_with(&ua_public, &auth, plaintext, &SecretKey::random(&mut rand_core::OsRng), salt)
}

// ---- VAPID (RFC 8292) ----

/// `vapid t=<ES256 JWT for the endpoint's origin, 12 h>, k=<public key>`, as web-push builds it.
pub fn vapid_authorization(vapid: &Vapid, endpoint: &str, now: i64) -> Result<String, String> {
    let key = SigningKey::from_slice(&B64.decode(&vapid.private_key).map_err(|_| "bad VAPID private key")?).map_err(|_| "bad VAPID private key")?;
    let host = endpoint.trim_start_matches("https://").split(['/', '?', '#']).next().unwrap_or_default();
    let header = B64.encode(r#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = B64.encode(json!({ "aud": format!("https://{host}"), "exp": now + 12 * 3600, "sub": vapid.subject }).to_string());
    let input = format!("{header}.{claims}");
    let signature: Signature = key.sign(input.as_bytes());
    Ok(format!("vapid t={input}.{}, k={}", B64.encode(signature.to_bytes()), vapid.public_key))
}

// ---- payload (src/lib/push/payload.ts) ----

fn messages(locale: &str) -> &'static [&'static str; 7] {
    let known = push_messages::MESSAGES.iter().find(|(l, _)| *l == locale).unwrap_or(&push_messages::MESSAGES[0]);
    &known.1
}

fn message(locale: &str, key: &str) -> &'static str {
    let at = push_messages::KEYS.iter().position(|k| *k == key).unwrap_or(0);
    messages(locale)[at]
}

fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// At most `max` graphemes and `max * 8` UTF-16 units; a cut text ends with "…".
fn truncate(text: &str, max: usize) -> String {
    let budget = max * UNITS_PER_CHARACTER;
    let graphemes: Vec<&str> = text.graphemes(true).collect();
    if graphemes.len() <= max && len16(text) <= budget {
        return text.to_string();
    }
    let mut kept = String::new();
    for g in graphemes.iter().take(max - 1) {
        if len16(&kept) + len16(g) > budget - 1 {
            break;
        }
        kept.push_str(g);
    }
    format!("{}…", kept.trim_end_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
}

/// One pass over `{name}` placeholders, so a value never gets substituted into.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}').and_then(|close| values.iter().find(|(k, _)| *k == &after[..close]).map(|(_, v)| (close, v))) {
            Some((close, value)) => {
                out.push_str(value);
                rest = &after[close + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn href(kind: &str) -> &'static str {
    match kind {
        "EXPENSE_NEW" => "/expenses",
        "RECURRING_DUE" => "/recurring",
        _ => "/balances",
    }
}

/// encodeURIComponent.
fn encode_component(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

pub struct NoticeRow {
    pub user_id: i32,
    pub group_id: i32,
    pub kind: String,
    pub actor_id: Option<i32>,
    pub params: Value,
}

pub fn payload(notice: &NoticeRow, locale: &str, house_name: &str, house_public_id: &str, actor_name: Option<&str>) -> Value {
    let actor = truncate(actor_name.unwrap_or(message(locale, "someone")), MAX_ACTOR);
    let description = truncate(notice.params["description"].as_str().unwrap_or(""), MAX_DESCRIPTION);
    let key = if notice.kind == "EXPENSE_NEW" && notice.params["recurring"] == Value::Bool(true) { "EXPENSE_NEW_RECURRING" } else { notice.kind.as_str() };
    json!({
        "title": truncate(house_name, MAX_TITLE),
        "body": fill(message(locale, key), &[("actor", &actor), ("description", &description)]),
        "url": format!("{}?house={}", href(&notice.kind), encode_component(house_public_id)),
        "tag": format!("{}:{house_public_id}", notice.kind),
    })
}

pub fn test_payload(locale: &str) -> Value {
    json!({ "title": APP_NAME, "body": message(locale, "TEST"), "url": "/notifications", "tag": "TEST" })
}

// ---- delivery ----

pub struct Subscription {
    pub id: i32,
    pub user_id: i32,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub locale: String,
}

pub async fn subscriptions(state: &AppState, user_ids: &[i32]) -> Result<Vec<Subscription>, Box<dyn std::error::Error + Send + Sync>> {
    let db = state.pool.get().await?;
    let rows = db
        .query(r#"SELECT "id", "userId", "endpoint", "p256dh", "auth", "locale" FROM "PushSubscription" WHERE "userId" = ANY($1) ORDER BY "id""#, &[&user_ids])
        .await?;
    Ok(rows
        .iter()
        .map(|r| Subscription { id: r.get(0), user_id: r.get(1), endpoint: r.get(2), p256dh: r.get(3), auth: r.get(4), locale: r.get(5) })
        .collect())
}

enum Outcome {
    Sent,
    Dead,
    Failed,
}

async fn send(vapid: &Vapid, sub: &Subscription, payload: &Value) -> Outcome {
    // Rows outlive validator changes: never POST to a URL the current allow-list rejects (SSRF).
    if !allowed_endpoint(&sub.endpoint) {
        return Outcome::Dead;
    }
    let host = sub.endpoint.trim_start_matches("https://").split('/').next().unwrap_or_default().to_string();
    let request = encrypt(&sub.p256dh, &sub.auth, payload.to_string().as_bytes())
        .and_then(|body| vapid_authorization(vapid, &sub.endpoint, chrono::Utc::now().timestamp()).map(|auth| (body, auth)));
    let (body, authorization) = match request {
        Ok(parts) => parts,
        Err(reason) => {
            eprintln!("push delivery failed (host {host}, reason {reason})");
            return Outcome::Failed;
        }
    };
    let response = CLIENT
        .post(&sub.endpoint)
        .header("TTL", TTL_SECONDS.to_string())
        .header("Urgency", "normal")
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("Authorization", authorization)
        .body(body)
        .send()
        .await;
    // Logged with the push service's host and status only: the endpoint is the device's token.
    match response {
        Ok(r) if r.status().is_success() => Outcome::Sent,
        Ok(r) if matches!(r.status().as_u16(), 404 | 410) => Outcome::Dead,
        Ok(r) => {
            eprintln!("push delivery failed (host {host}, status {})", r.status().as_u16());
            Outcome::Failed
        }
        Err(e) => {
            let reason = if e.is_timeout() { "timeout" } else if e.is_connect() { "connect" } else { "request_failed" };
            eprintln!("push delivery failed (host {host}, reason {reason})");
            Outcome::Failed
        }
    }
}

/// Sends every delivery, at most 10 in flight; expired (404/410) and no-longer-allowed rows are deleted.
pub async fn deliver(state: &AppState, vapid: &std::sync::Arc<Vapid>, deliveries: Vec<(Subscription, Value)>) -> (usize, usize) {
    let total = deliveries.len();
    let (mut sent, mut dead) = (0, Vec::new());
    let mut pending = deliveries.into_iter();
    loop {
        let mut batch = tokio::task::JoinSet::new();
        for (sub, payload) in pending.by_ref().take(CONCURRENCY) {
            let vapid = vapid.clone();
            batch.spawn(async move { (sub.id, send(&vapid, &sub, &payload).await) });
        }
        if batch.is_empty() {
            break;
        }
        while let Some(Ok((id, outcome))) = batch.join_next().await {
            match outcome {
                Outcome::Sent => sent += 1,
                Outcome::Dead => dead.push(id),
                Outcome::Failed => {}
            }
        }
    }
    if !dead.is_empty() {
        let removed = match state.pool.get().await {
            Ok(db) => db.execute(r#"DELETE FROM "PushSubscription" WHERE "id" = ANY($1)"#, &[&dead]).await.map(|_| ()).map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        if let Err(e) = removed {
            eprintln!("push: removing {} expired subscriptions failed: {e}", dead.len());
        }
    }
    (sent, total - sent)
}

/// After a notice insert: one push per subscription of each recipient, in that subscription's locale. Spawned, never
/// awaited by the request; a no-op while push is not configured.
pub fn schedule(state: &AppState, rows: Vec<NoticeRow>) {
    let Some(vapid) = state.vapid.clone() else { return };
    if rows.is_empty() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = dispatch(&state, &vapid, rows).await {
            eprintln!("push dispatch failed: {e}");
        }
    });
}

async fn dispatch(state: &AppState, vapid: &std::sync::Arc<Vapid>, rows: Vec<NoticeRow>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let users: Vec<i32> = rows.iter().map(|r| r.user_id).collect();
    let subs = subscriptions(state, &users).await?;
    if subs.is_empty() {
        return Ok(());
    }
    let db = state.pool.get().await?;
    let houses: Vec<i32> = rows.iter().map(|r| r.group_id).collect();
    let actors: Vec<i32> = rows.iter().filter_map(|r| r.actor_id).collect();
    let house_rows = db.query(r#"SELECT "id", "publicId"::text, "name" FROM "Group" WHERE "id" = ANY($1)"#, &[&houses]).await?;
    let actor_rows = db.query(r#"SELECT "id", "name" FROM "User" WHERE "id" = ANY($1)"#, &[&actors]).await?;
    drop(db);
    let mut deliveries = Vec::new();
    for row in &rows {
        // The house was deleted after the insert: nothing to open.
        let Some(house) = house_rows.iter().find(|h| h.get::<_, i32>(0) == row.group_id) else { continue };
        let actor = row.actor_id.and_then(|a| actor_rows.iter().find(|r| r.get::<_, i32>(0) == a)).map(|r| r.get::<_, String>(1));
        for sub in subs.iter().filter(|s| s.user_id == row.user_id) {
            let p = payload(row, &sub.locale, house.get(2), house.get(1), actor.as_deref());
            let copy = Subscription { id: sub.id, user_id: sub.user_id, endpoint: sub.endpoint.clone(), p256dh: sub.p256dh.clone(), auth: sub.auth.clone(), locale: sub.locale.clone() };
            deliveries.push((copy, p));
        }
    }
    deliver(state, vapid, deliveries).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Verifier, VerifyingKey};

    fn b64(s: &str) -> Vec<u8> {
        B64.decode(s).unwrap()
    }

    /// RFC 8291 §5 / Appendix A: the exact body the RFC's keys, salt and plaintext produce.
    #[test]
    fn rfc_8291_example() {
        let sender = SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let ua_public = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt_with(&ua_public, &b64("BTBZMqHH6r4Tts7J_aSIgg"), b"When I grow up, I want to be a watermelon", &sender, salt).unwrap();
        assert_eq!(
            B64.encode(body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn vapid_jwt_verifies_for_the_endpoint_origin() {
        let secret = SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let public = B64.encode(secret.public_key().to_encoded_point(false).as_bytes());
        let vapid = Vapid { public_key: public.clone(), private_key: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw".into(), subject: "mailto:a@b.c".into() };
        let header = vapid_authorization(&vapid, "https://fcm.googleapis.com/fcm/send/x", 1_000).unwrap();
        let (token, key) = header.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
        assert_eq!(key, public);
        let (input, signature) = token.rsplit_once('.').unwrap();
        let verifying = VerifyingKey::from_sec1_bytes(&b64(key)).unwrap();
        verifying.verify(input.as_bytes(), &Signature::from_slice(&b64(signature)).unwrap()).unwrap();
        let claims: Value = serde_json::from_slice(&b64(input.split_once('.').unwrap().1)).unwrap();
        assert_eq!(claims, json!({ "aud": "https://fcm.googleapis.com", "exp": 1_000 + 12 * 3600, "sub": "mailto:a@b.c" }));
    }

    #[test]
    fn payload_like_build_push_payload() {
        let notice = NoticeRow { user_id: 1, group_id: 1, kind: "EXPENSE_NEW".into(), actor_id: Some(2), params: json!({ "description": "Pizza", "recurring": false }) };
        let p = payload(&notice, "pt", "Casa", "00000000-0000-7000-8000-000000000101", Some("Bruno"));
        assert_eq!(p, json!({ "title": "Casa", "body": "Bruno adicionou “Pizza”", "url": "/expenses?house=00000000-0000-7000-8000-000000000101", "tag": "EXPENSE_NEW:00000000-0000-7000-8000-000000000101" }));
        let auto = NoticeRow { params: json!({ "description": "Luz", "recurring": true }), actor_id: None, ..notice };
        assert_eq!(payload(&auto, "xx", "Casa", "h", None)["body"], "“Luz” was posted automatically");
        assert_eq!(test_payload("fr")["body"], "Les notifications fonctionnent sur cet appareil");
    }

    #[test]
    fn truncation() {
        assert_eq!(truncate("Casa", 40), "Casa");
        assert_eq!(truncate(&"a".repeat(41), 40), format!("{}…", "a".repeat(39)));
        assert_eq!(truncate(&format!("{} b", "a".repeat(38)), 39), format!("{}…", "a".repeat(38)));
        assert_eq!(fill("{actor} x {description}", &[("actor", "{description}"), ("description", "d")]), "{description} x d");
    }
}
