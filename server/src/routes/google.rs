//! Sign in with Google (OAuth code flow): same redirects, cookies and rows as src/app/api/auth/google/** and
//! authService.findOrCreateGoogleUser. Off (redirect with `google_unavailable`) without GOOGLE_CLIENT_ID/SECRET.

use crate::{
    audit::{self, Action, Revision},
    auth::{cookie, read_cookie, Claims, SESSION_COOKIE},
    AppState,
};
use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use deadpool_postgres::GenericClient;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::LazyLock, time::Duration};

const STATE_COOKIE: &str = "homeshare_oauth_state";
const ISO: &str = r#"'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'"#;

static CLIENT: LazyLock<reqwest::Client> =
    LazyLock::new(|| reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("Google HTTP client"));

fn credentials() -> Option<(String, String)> {
    let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    Some((get("GOOGLE_CLIENT_ID")?, get("GOOGLE_CLIENT_SECRET")?))
}

/// The public origin of this request (the proxy says https; the Host header names the site).
fn origin(headers: &HeaderMap) -> String {
    let get = |k: header::HeaderName| headers.get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    let proto = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()).unwrap_or("http").trim().to_string();
    let host = headers.get("x-forwarded-host").and_then(|v| v.to_str().ok()).map(str::to_string).or_else(|| get(header::HOST)).unwrap_or_default();
    format!("{proto}://{host}")
}

/// encodeURIComponent / URLSearchParams-safe encoding.
fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.*".contains(&b) { (b as char).to_string() } else if b == b' ' { "+".into() } else { format!("%{b:02X}") }).collect()
}

fn redirect(to: &str, cookies: &[String]) -> Response {
    let mut response = StatusCode::TEMPORARY_REDIRECT.into_response();
    if let Ok(v) = HeaderValue::from_str(to) {
        response.headers_mut().insert(header::LOCATION, v);
    }
    for c in cookies {
        if let Ok(v) = HeaderValue::from_str(c) {
            response.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    response
}

fn to_login(origin: &str, error: &str) -> Response {
    redirect(&format!("{origin}/auth/login?error={error}"), &[])
}

pub async fn start(headers: HeaderMap) -> Response {
    let origin = origin(&headers);
    let Some((client_id, _)) = credentials() else { return to_login(&origin, "google_unavailable") };
    let redirect_uri = format!("{origin}/api/auth/google/callback");
    let state = uuid::Uuid::now_v7().to_string();
    let url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&access_type=online&prompt=select_account",
        enc(&client_id), enc(&redirect_uri), enc("openid email profile"), enc(&state)
    );
    redirect(&url, &[format!("{STATE_COOKIE}={state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax")])
}

#[derive(Deserialize)]
pub struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

struct Profile {
    google_id: String,
    email: Option<String>,
    name: Option<String>,
}

async fn exchange(code: &str, redirect_uri: &str, client_id: &str, secret: &str) -> Result<Profile, Box<dyn std::error::Error + Send + Sync>> {
    let form: HashMap<&str, &str> = HashMap::from([("code", code), ("client_id", client_id), ("client_secret", secret), ("redirect_uri", redirect_uri), ("grant_type", "authorization_code")]);
    let token: Value = CLIENT.post("https://oauth2.googleapis.com/token").form(&form).send().await?.error_for_status()?.json().await?;
    let access = token["access_token"].as_str().ok_or("Google did not return an access_token")?;
    let info: Value = CLIENT.get("https://www.googleapis.com/oauth2/v3/userinfo").bearer_auth(access).send().await?.error_for_status()?.json().await?;
    Ok(Profile {
        google_id: info["sub"].as_str().ok_or("no sub")?.to_string(),
        email: info["email"].as_str().filter(|_| info["email_verified"] == Value::Bool(true)).map(str::to_string),
        name: info["name"].as_str().map(str::to_string),
    })
}

pub async fn callback(State(state): State<AppState>, headers: HeaderMap, Query(params): Query<CallbackParams>) -> Response {
    let origin = origin(&headers);
    let Some((client_id, secret)) = credentials() else { return to_login(&origin, "google_unavailable") };
    if params.error.is_some() {
        return to_login(&origin, "google_cancelled");
    }
    let cookie_state = read_cookie(&headers, STATE_COOKIE);
    let (Some(code), Some(given)) = (params.code.filter(|c| !c.is_empty()), params.state.filter(|s| !s.is_empty())) else {
        return to_login(&origin, "google_state");
    };
    if cookie_state.is_none_or(|c| c.is_empty() || c != given) {
        return to_login(&origin, "google_state");
    }
    let redirect_uri = format!("{origin}/api/auth/google/callback");
    let user = match exchange(&code, &redirect_uri, &client_id, &secret).await {
        Ok(profile) => find_or_create(&state, profile).await,
        Err(e) => Err(e),
    };
    let Ok((id, public_id, name, version)) = user else { return to_login(&origin, "google_failed") };
    let now = chrono::Utc::now().timestamp();
    let claims = Claims { user_id: id as i64, public_id, name, session_version: version as i64, auth_at: None, iat: 0, exp: None };
    let token = state.keys.sign(&claims, now, now);
    redirect(&format!("{origin}/"), &[cookie(SESSION_COOKIE, &token), format!("{STATE_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")])
}

/// The whole User row as Prisma returns it (the revision drops the password).
async fn row(db: &impl GenericClient, id: i32) -> Result<Value, tokio_postgres::Error> {
    let r = db
        .query_one(
            &format!(
                r#"SELECT "id", "publicId"::text, "name", "username", "password", "email", "emailVerified", "googleId", "sessionVersion",
                          to_char("deletedAt", {ISO}), to_char("createdAt", {ISO}), to_char("updatedAt", {ISO}) FROM "User" WHERE "id" = $1"#
            ),
            &[&id],
        )
        .await?;
    Ok(json!({
        "id": r.get::<_, i32>(0), "publicId": r.get::<_, String>(1), "name": r.get::<_, String>(2), "username": r.get::<_, String>(3),
        "password": r.get::<_, Option<String>>(4), "email": r.get::<_, Option<String>>(5), "emailVerified": r.get::<_, bool>(6),
        "googleId": r.get::<_, Option<String>>(7), "sessionVersion": r.get::<_, i32>(8), "deletedAt": r.get::<_, Option<String>>(9),
        "createdAt": r.get::<_, String>(10), "updatedAt": r.get::<_, String>(11),
    }))
}

/// uniqueUsernameFromEmail: the e-mail's local part reduced to the username alphabet, numbered on collision.
async fn unique_username(db: &impl GenericClient, email: Option<&str>, fallback: &str) -> Result<String, tokio_postgres::Error> {
    let local = email.map_or(fallback, |e| e.split('@').next().unwrap_or("")).to_lowercase();
    let mut base: String = local.chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(*c)).take(24).collect();
    if base.len() < 3 {
        base = format!("user{base}");
    }
    base.truncate(24);
    let mut candidate = base.clone();
    let mut n = 0;
    while !db.query(r#"SELECT 1 FROM "User" WHERE "username" = $1"#, &[&candidate]).await?.is_empty() {
        n += 1;
        candidate = format!("{base}{n}").chars().take(30).collect();
    }
    Ok(candidate)
}

/// findOrCreateGoogleUser: by googleId; else link a verified password account with the same e-mail; else a new account
/// (without the e-mail when another account already has it).
async fn find_or_create(state: &AppState, p: Profile) -> Result<(i32, String, String, i32), Box<dyn std::error::Error + Send + Sync>> {
    let db = state.pool.get().await?;
    let pick = |r: &tokio_postgres::Row| (r.get::<_, i32>(0), r.get::<_, String>(1), r.get::<_, String>(2), r.get::<_, i32>(3));
    if let Some(r) = db.query_opt(r#"SELECT "id", "publicId"::text, "name", "sessionVersion" FROM "User" WHERE "googleId" = $1"#, &[&p.google_id]).await? {
        return Ok(pick(&r));
    }
    let mut email_for_new = p.email.clone();
    if let Some(email) = &p.email {
        let by_email = db.query_opt(r#"SELECT "id", "googleId", "emailVerified" FROM "User" WHERE "email" = $1"#, &[email]).await?;
        if let Some(found) = by_email {
            let (id, google, verified): (i32, Option<String>, bool) = (found.get(0), found.get(1), found.get(2));
            if google.is_none() && verified {
                db.execute(r#"UPDATE "User" SET "googleId" = $2, "updatedAt" = now() AT TIME ZONE 'UTC' WHERE "id" = $1"#, &[&id, &p.google_id]).await?;
                let snapshot = row(&db, id).await?;
                audit::record(&db, Revision { entity_type: "User", entity_id: id.to_string(), group_id: None, action: Action::Update, actor_id: None, row: snapshot, fields_set: &[] }).await?;
                let r = db.query_one(r#"SELECT "id", "publicId"::text, "name", "sessionVersion" FROM "User" WHERE "id" = $1"#, &[&id]).await?;
                return Ok(pick(&r));
            }
            email_for_new = None;
        }
    }
    let username = unique_username(&db, p.email.as_deref(), &p.google_id).await?;
    let name = p
        .name
        .as_deref()
        .map(crate::expense_input::js_trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .or_else(|| p.email.as_deref().map(|e| e.split('@').next().unwrap_or("").to_string()).filter(|n| !n.is_empty()))
        .unwrap_or_else(|| "User".into());
    let created = db
        .query_one(
            r#"INSERT INTO "User" ("publicId", "name", "username", "email", "emailVerified", "googleId", "password", "updatedAt")
               VALUES ($1::text::uuid, $2, $3, $4, $5, $6, NULL, now() AT TIME ZONE 'UTC') RETURNING "id", "publicId"::text, "name", "sessionVersion""#,
            &[&uuid::Uuid::now_v7().to_string(), &name, &username, &email_for_new, &email_for_new.is_some(), &p.google_id],
        )
        .await?;
    let user = pick(&created);
    let snapshot = row(&db, user.0).await?;
    audit::record(&db, Revision { entity_type: "User", entity_id: user.0.to_string(), group_id: None, action: Action::Create, actor_id: None, row: snapshot, fields_set: &[] }).await?;
    Ok(user)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_and_encoding() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "homeshare.example".parse().unwrap());
        assert_eq!(origin(&h), "http://homeshare.example");
        h.insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(origin(&h), "https://homeshare.example");
        assert_eq!(enc("openid email profile"), "openid+email+profile");
        assert_eq!(enc("https://a.b/c?d"), "https%3A%2F%2Fa.b%2Fc%3Fd");
    }
}
