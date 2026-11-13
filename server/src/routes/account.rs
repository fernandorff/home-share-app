//! /api/auth/{login,register,logout,logout-all,password,me}: same answers and rows as the Next routes and authService
//! (src/app/api/auth/**, src/services/auth.service.ts). Passwords are bcrypt (cost 10), like bcryptjs.

use crate::{
    audit::{self, Action, Revision},
    auth::{cookie, read_cookie, Claims, Session, GROUP_COOKIE, SESSION_COOKIE},
    errors::{json_body, ApiError},
    expense_input::js_trim,
    AppState,
};
use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use deadpool_postgres::GenericClient;
use serde_json::{json, Value};
use std::time::Duration;

const REAUTH_WINDOW_SECONDS: i64 = 15 * 60;
const COMMON_PASSWORDS: [&str; 18] = [
    "password", "password1", "password123", "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop", "11111111", "00000000",
    "iloveyou", "admin123", "welcome1", "letmein1", "abc123456", "senha123", "senha1234", "brasil123",
];
const CLEAR_SESSION: &str = "homeshare_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
const CLEAR_HOUSE: &str = "homeshare_group=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
const ISO: &str = r#"'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'"#;

fn bad(status: StatusCode, message: &'static str, code: &'static str) -> ApiError {
    ApiError::new(status, message, code)
}

fn too_many() -> ApiError {
    bad(StatusCode::TOO_MANY_REQUESTS, "Too many attempts. Try again shortly.", "RATE_LIMITED")
}

fn limited(key: String) -> bool {
    crate::rate_limit::allow(key, 10, Duration::from_secs(60))
}

/// clientIp: x-real-ip, else the last x-forwarded-for hop; "unknown" (never rate limited) without either.
fn client_ip(headers: &HeaderMap) -> Option<String> {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    if let Some(ip) = get("x-real-ip").map(str::trim).filter(|v| !v.is_empty()) {
        return Some(ip.to_string());
    }
    get("x-forwarded-for").and_then(|f| f.split(',').map(str::trim).filter(|p| !p.is_empty()).last()).map(str::to_string)
}

fn valid_username(u: &str) -> bool {
    (3..=30).contains(&u.len()) && u.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

const USERNAME_RULE: &str = "Username must be 3-30 characters (lowercase letters, numbers, dot, hyphen or underscore)";

fn password_problem(p: &str) -> Option<(&'static str, &'static str)> {
    let len = p.encode_utf16().count();
    if len < 8 {
        return Some(("Password must be at least 8 characters", "INVALID_PASSWORD"));
    }
    if len > 72 {
        return Some(("Password must be at most 72 characters", "INVALID_PASSWORD"));
    }
    if COMMON_PASSWORDS.contains(&p.to_lowercase().as_str()) {
        return Some(("This password is too common. Pick one that is harder to guess", "PASSWORD_TOO_COMMON"));
    }
    if !p.bytes().any(|b| b.is_ascii_alphabetic()) || !p.bytes().any(|b| b.is_ascii_digit()) {
        return Some(("Password must contain letters and numbers", "PASSWORD_NO_COMPLEXITY"));
    }
    None
}

/// `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, at most 254 UTF-16 units.
fn valid_email(e: &str) -> bool {
    let plain = |s: &str| !s.is_empty() && !s.chars().any(|c| c == '@' || c.is_whitespace() || c == '\u{feff}');
    let Some((local, domain)) = e.split_once('@') else { return false };
    e.encode_utf16().count() <= 254 && plain(local) && domain.rfind('.').is_some_and(|dot| plain(&domain[..dot]) && plain(&domain[dot + 1..]))
}

fn hash(password: &str) -> Result<String, ApiError> {
    bcrypt::hash(password, 10).map_err(|e| ApiError::internal("Internal server error", e))
}

fn verify(password: &str, hashed: &str) -> bool {
    bcrypt::verify(password, hashed).unwrap_or(false)
}

fn sign(state: &AppState, id: i32, public_id: &str, name: &str, version: i32, auth_at: Option<i64>) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = Claims { user_id: id as i64, public_id: public_id.into(), name: name.into(), session_version: version as i64, auth_at: None, iat: 0, exp: None };
    state.keys.sign(&claims, auth_at.unwrap_or(now), now)
}

fn with_cookies(status: StatusCode, cookies: &[String], body: Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    for c in cookies {
        if let Ok(v) = HeaderValue::from_str(c) {
            response.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    response
}

/// A User revision as the audit extension stores it: the write's returned fields, no house.
async fn revise(db: &impl GenericClient, entity_id: String, action: Action, actor: Option<i32>, row: Value, fields_set: &'static [&'static str]) -> Result<(), tokio_postgres::Error> {
    audit::record(db, Revision { entity_type: "User", entity_id, group_id: None, action, actor_id: actor, row, fields_set }).await
}

struct UserRow {
    id: i32,
    public_id: String,
    name: String,
    username: String,
    email: Option<String>,
    password: Option<String>,
    google_id: Option<String>,
    session_version: i32,
}

async fn user_by(db: &impl GenericClient, column: &str, value: &(dyn tokio_postgres::types::ToSql + Sync)) -> Result<Option<UserRow>, tokio_postgres::Error> {
    let sql = format!(r#"SELECT "id", "publicId"::text, "name", "username", "email", "password", "googleId", "sessionVersion" FROM "User" WHERE "{column}" = $1"#);
    Ok(db.query_opt(&sql, &[value]).await?.map(|r| UserRow {
        id: r.get(0), public_id: r.get(1), name: r.get(2), username: r.get(3), email: r.get(4), password: r.get(5), google_id: r.get(6), session_version: r.get(7),
    }))
}

/// The whole User row (an update without `select` returns it; the snapshot drops the password).
async fn full_row(db: &impl GenericClient, id: i32) -> Result<Value, tokio_postgres::Error> {
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

pub async fn login(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to sign in", e);
    let body = json_body(&body)?;
    let username = body["username"].as_str().map(|u| js_trim(u).to_lowercase()).unwrap_or_default();
    let password = body["password"].as_str().unwrap_or("");
    if username.is_empty() {
        return Err(bad(StatusCode::BAD_REQUEST, "Username is required", "MISSING_USERNAME"));
    }
    if let Some(ip) = client_ip(&headers) {
        if !crate::rate_limit::allow(format!("login:ip:{ip}"), 30, Duration::from_secs(60)) {
            return Err(too_many());
        }
    }
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let user = user_by(&db, "username", &username).await.map_err(|e| fail(&e))?;
    let invalid = || bad(StatusCode::UNAUTHORIZED, "Incorrect username or password", "INVALID_CREDENTIALS");
    let Some(user) = user else { return Err(invalid()) };
    match &user.password {
        None if user.google_id.is_some() => Err(bad(StatusCode::UNAUTHORIZED, "This account signs in with Google", "USE_GOOGLE")),
        None => Err(invalid()),
        Some(h) if !verify(password, h) => Err(invalid()),
        Some(_) => {
            let token = sign(&state, user.id, &user.public_id, &user.name, user.session_version, None);
            let out = json!({ "user": { "id": user.id, "publicId": user.public_id, "name": user.name } });
            Ok(with_cookies(StatusCode::OK, &[cookie(SESSION_COOKIE, &token)], out))
        }
    }
}

pub async fn register(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to create account", e);
    let body = json_body(&body)?;
    let name = body["name"].as_str().map(js_trim).unwrap_or("").to_string();
    let username = body["username"].as_str().map(|u| js_trim(u).to_lowercase()).unwrap_or_default();
    let password = body["password"].as_str().unwrap_or("");
    if let Some(ip) = client_ip(&headers) {
        if !crate::rate_limit::allow(format!("register:ip:{ip}"), 15, Duration::from_secs(60)) {
            return Err(too_many());
        }
    }
    if name.is_empty() || name.encode_utf16().count() > 80 {
        return Err(bad(StatusCode::BAD_REQUEST, "Name is required (max 80 characters)", "INVALID_NAME"));
    }
    if !valid_username(&username) {
        return Err(bad(StatusCode::BAD_REQUEST, USERNAME_RULE, "INVALID_USERNAME"));
    }
    if let Some((message, code)) = password_problem(password) {
        return Err(bad(StatusCode::BAD_REQUEST, message, code));
    }
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    if user_by(&db, "username", &username).await.map_err(|e| fail(&e))?.is_some() {
        return Err(bad(StatusCode::CONFLICT, "This username already exists", "USERNAME_TAKEN"));
    }
    let hashed = hash(password)?;
    let row = db
        .query_one(
            r#"INSERT INTO "User" ("publicId", "name", "username", "password", "updatedAt") VALUES ($1::text::uuid, $2, $3, $4, now() AT TIME ZONE 'UTC')
               RETURNING "id", "publicId"::text, "name""#,
            &[&uuid::Uuid::now_v7().to_string(), &name, &username, &hashed],
        )
        .await
        .map_err(|e| fail(&e))?;
    let (id, public_id, name): (i32, String, String) = (row.get(0), row.get(1), row.get(2));
    let user = json!({ "id": id, "publicId": public_id, "name": name });
    revise(&db, id.to_string(), Action::Create, None, user.clone(), &[]).await.map_err(|e| fail(&e))?;
    let token = sign(&state, id, &public_id, &name, 0, None);
    Ok(with_cookies(StatusCode::CREATED, &[cookie(SESSION_COOKIE, &token)], json!({ "user": user })))
}

pub async fn logout() -> Response {
    with_cookies(StatusCode::OK, &[CLEAR_SESSION.into(), CLEAR_HOUSE.into()], json!({ "ok": true }))
}

/// Bumps sessionVersion (every session ends) and drops every push subscription, atomically.
async fn bump(db: &mut deadpool_postgres::Object, user_id: i32, password: Option<&str>) -> Result<i32, tokio_postgres::Error> {
    let tx = db.transaction().await?;
    let version: i32 = tx
        .query_one(
            r#"UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1, "password" = COALESCE($2, "password"), "updatedAt" = now() AT TIME ZONE 'UTC'
               WHERE "id" = $1 RETURNING "sessionVersion""#,
            &[&user_id, &password],
        )
        .await?
        .get(0);
    tx.execute(r#"DELETE FROM "PushSubscription" WHERE "userId" = $1"#, &[&user_id]).await?;
    let fields: &'static [&'static str] = if password.is_some() { &["password"] } else { &[] };
    revise(&tx, user_id.to_string(), Action::Update, Some(user_id), json!({ "sessionVersion": version }), fields).await?;
    tx.commit().await?;
    Ok(version)
}

pub async fn logout_all(State(state): State<AppState>, Session(session): Session) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to log out of all devices", e);
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    bump(&mut db, session.user_id as i32, None).await.map_err(|e| fail(&e))?;
    Ok(with_cookies(StatusCode::OK, &[CLEAR_SESSION.into(), CLEAR_HOUSE.into()], json!({ "ok": true })))
}

fn current_password_error(user: &UserRow, current: Option<&str>) -> Option<ApiError> {
    let hashed = user.password.as_deref()?;
    match current.filter(|c| !c.is_empty()) {
        None => Some(bad(StatusCode::UNAUTHORIZED, "Current password is required", "CURRENT_PASSWORD_REQUIRED")),
        Some(c) if !verify(c, hashed) => Some(bad(StatusCode::UNAUTHORIZED, "Current password is incorrect", "CURRENT_PASSWORD_INVALID")),
        Some(_) => None,
    }
}

pub async fn password(State(state): State<AppState>, Session(session): Session, body: Bytes) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to update password", e);
    let me = session.user_id as i32;
    if !limited(format!("account:pw:{me}")) {
        return Err(too_many());
    }
    let body = json_body(&body)?;
    let current = body["currentPassword"].as_str();
    let new_password = body["newPassword"].as_str().unwrap_or("");
    if let Some((message, code)) = password_problem(new_password) {
        return Err(bad(StatusCode::BAD_REQUEST, message, code));
    }
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let Some(user) = user_by(&db, "id", &me).await.map_err(|e| fail(&e))? else {
        return Err(bad(StatusCode::NOT_FOUND, "User not found", "NOT_FOUND"));
    };
    let auth_at = session.auth_at.unwrap_or(session.iat);
    if user.password.is_some() {
        if let Some(e) = current_password_error(&user, current) {
            return Err(e);
        }
    } else if chrono::Utc::now().timestamp() - auth_at > REAUTH_WINDOW_SECONDS {
        // An account without a password (Google) sets one only right after a login.
        return Err(bad(StatusCode::UNAUTHORIZED, "Log in again to set a password", "REAUTH_REQUIRED"));
    }
    let hashed = hash(new_password)?;
    let version = bump(&mut db, me, Some(&hashed)).await.map_err(|e| fail(&e))?;
    // Same login time: changing the password is not a new login.
    let token = sign(&state, me, &session.public_id, &session.name, version, Some(auth_at));
    Ok(with_cookies(StatusCode::OK, &[cookie(SESSION_COOKIE, &token)], json!({ "ok": true })))
}

/// The houses where this member is the only active admin while others remain (what leaving would refuse).
async fn last_admin_houses(db: &impl GenericClient, user_id: i32) -> Result<Vec<i32>, tokio_postgres::Error> {
    Ok(db
        .query(
            r#"SELECT m."groupId" FROM "GroupMember" m WHERE m."userId" = $1 AND m."leftAt" IS NULL AND m."role" = 'ADMIN'
                 AND NOT EXISTS (SELECT 1 FROM "GroupMember" o WHERE o."groupId" = m."groupId" AND o."leftAt" IS NULL AND o."role" = 'ADMIN' AND o."userId" <> $1)
                 AND EXISTS (SELECT 1 FROM "GroupMember" o WHERE o."groupId" = m."groupId" AND o."leftAt" IS NULL AND o."userId" <> $1)
               ORDER BY m."groupId""#,
            &[&user_id],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect())
}

pub async fn me(State(state): State<AppState>, Session(session): Session, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to load session", e);
    let me = session.user_id as i32;
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let Some(user) = user_by(&db, "id", &me).await.map_err(|e| fail(&e))? else {
        return Err(ApiError::plain(StatusCode::NOT_FOUND, "User not found"));
    };
    let blocked = last_admin_houses(&db, me).await.map_err(|e| fail(&e))?;
    let rows = db
        .query(
            r#"SELECT g."id", g."publicId"::text, g."name", g."currency", m."role"::text, m."colorIndex", g."joinCode"
               FROM "GroupMember" m JOIN "Group" g ON g."id" = m."groupId" WHERE m."userId" = $1 AND m."leftAt" IS NULL ORDER BY m."createdAt""#,
            &[&me],
        )
        .await
        .map_err(|e| fail(&e))?;
    let groups: Vec<Value> = rows
        .iter()
        .map(|r| {
            let id: i32 = r.get(0);
            let admin = r.get::<_, String>(4) == "ADMIN";
            json!({ "id": id, "publicId": r.get::<_, String>(1), "name": r.get::<_, String>(2), "currency": r.get::<_, String>(3),
                    "role": r.get::<_, String>(4), "colorIndex": r.get::<_, i32>(5),
                    "joinCode": if admin { r.get::<_, Option<String>>(6) } else { None }, "lastAdmin": blocked.contains(&id) })
        })
        .collect();
    let preferred = read_cookie(&headers, GROUP_COOKIE).and_then(|v| v.trim().parse::<f64>().ok());
    let active = groups.iter().find(|g| g["id"].as_f64() == preferred).or(groups.first()).map(|g| g["id"].clone()).unwrap_or(Value::Null);
    Ok(Json(json!({
        "user": { "id": user.id, "publicId": user.public_id, "name": user.name, "username": user.username, "email": user.email,
                  "hasPassword": user.password.is_some(), "groups": groups },
        "activeGroupId": active,
    })))
}

pub async fn update_me(State(state): State<AppState>, Session(session): Session, body: Bytes) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to update account", e);
    let body = json_body(&body)?;
    let name = body["name"].as_str().map(|n| js_trim(n).to_string());
    let email = body["email"].as_str().map(|e| js_trim(e).to_lowercase());
    let username = body["username"].as_str().map(|u| js_trim(u).to_lowercase());
    let current = body["currentPassword"].as_str();
    if name.is_none() && email.is_none() && username.is_none() {
        return Err(bad(StatusCode::BAD_REQUEST, "Provide at least one field to update", "NO_FIELDS"));
    }
    if name.as_deref().is_some_and(|n| n.is_empty() || n.encode_utf16().count() > 80) {
        return Err(bad(StatusCode::BAD_REQUEST, "Name is required (max 80 characters)", "INVALID_NAME"));
    }
    if email.as_deref().is_some_and(|e| !valid_email(e)) {
        return Err(bad(StatusCode::BAD_REQUEST, "Invalid e-mail", "INVALID_EMAIL"));
    }
    if username.as_deref().is_some_and(|u| !valid_username(u)) {
        return Err(bad(StatusCode::BAD_REQUEST, USERNAME_RULE, "INVALID_USERNAME"));
    }
    let me = session.user_id as i32;
    if (email.is_some() || username.is_some()) && !limited(format!("account:pw:{me}")) {
        return Err(too_many());
    }
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let Some(user) = user_by(&db, "id", &me).await.map_err(|e| fail(&e))? else {
        return Err(bad(StatusCode::NOT_FOUND, "User not found", "NOT_FOUND"));
    };
    let email_changing = email.as_ref().is_some_and(|e| Some(e) != user.email.as_ref());
    let username_changing = username.as_ref().is_some_and(|u| *u != user.username);
    if email_changing || username_changing {
        if let Some(e) = current_password_error(&user, current) {
            return Err(e);
        }
    }
    let email_taken = || bad(StatusCode::CONFLICT, "This e-mail is already in use", "EMAIL_TAKEN");
    let username_taken = || bad(StatusCode::CONFLICT, "This username already exists", "USERNAME_TAKEN");
    if email_changing && user_by(&db, "email", &email).await.map_err(|e| fail(&e))?.is_some() {
        return Err(email_taken());
    }
    if username_changing && user_by(&db, "username", &username).await.map_err(|e| fail(&e))?.is_some() {
        return Err(username_taken());
    }
    let updated = db
        .query_one(
            r#"UPDATE "User" SET "name" = COALESCE($2, "name"),
                   "email" = CASE WHEN $3 THEN $4 ELSE "email" END, "emailVerified" = CASE WHEN $3 THEN false ELSE "emailVerified" END,
                   "username" = CASE WHEN $5 THEN $6 ELSE "username" END, "updatedAt" = now() AT TIME ZONE 'UTC'
               WHERE "id" = $1 RETURNING "id", "publicId"::text, "name", "username", "email""#,
            &[&me, &name, &email_changing, &email, &username_changing, &username.as_deref().unwrap_or("")],
        )
        .await;
    let row = match updated {
        Ok(row) => row,
        Err(e) if e.code() == Some(&tokio_postgres::error::SqlState::UNIQUE_VIOLATION) && email_changing => return Err(email_taken()),
        Err(e) if e.code() == Some(&tokio_postgres::error::SqlState::UNIQUE_VIOLATION) && username_changing => return Err(username_taken()),
        Err(e) => return Err(fail(&e)),
    };
    let snapshot = json!({ "id": row.get::<_, i32>(0), "publicId": row.get::<_, String>(1), "name": row.get::<_, String>(2),
                           "username": row.get::<_, String>(3), "email": row.get::<_, Option<String>>(4) });
    revise(&db, me.to_string(), Action::Update, Some(me), snapshot.clone(), &[]).await.map_err(|e| fail(&e))?;
    let mut out = snapshot;
    out["hasPassword"] = json!(user.password.is_some());
    Ok(Json(json!({ "user": out })))
}

pub async fn delete_me(State(state): State<AppState>, Session(session): Session, body: Bytes) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to delete account", e);
    let body: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let current = body["currentPassword"].as_str();
    let me = session.user_id as i32;
    if !limited(format!("account:pw:{me}")) {
        return Err(too_many());
    }
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let Some(user) = user_by(&db, "id", &me).await.map_err(|e| fail(&e))? else {
        return Err(bad(StatusCode::NOT_FOUND, "User not found", "NOT_FOUND"));
    };
    if let Some(e) = current_password_error(&user, current) {
        return Err(e);
    }
    if !last_admin_houses(&db, me).await.map_err(|e| fail(&e))?.is_empty() {
        return Err(bad(StatusCode::CONFLICT, "This house would be left without an admin — promote another member first", "LAST_ADMIN"));
    }
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let left_at: String = tx.query_one(&format!("SELECT to_char(date_trunc('milliseconds', now() AT TIME ZONE 'UTC'), {ISO})"), &[]).await.map_err(|e| fail(&e))?.get(0);
    let left = tx
        .execute(r#"UPDATE "GroupMember" SET "leftAt" = $2::text::timestamp WHERE "userId" = $1 AND "leftAt" IS NULL"#, &[&me, &left_at.trim_end_matches('Z')])
        .await
        .map_err(|e| fail(&e))?;
    // updateMany marker; its house comes from the audit context only: null, like the Next app.
    let marker = Revision {
        entity_type: "GroupMember", entity_id: format!("bulk:{left}"), group_id: None, action: Action::Update, actor_id: Some(me),
        row: json!({ "where": { "userId": me, "leftAt": null }, "data": { "leftAt": left_at } }), fields_set: &[],
    };
    audit::bulk(&tx, marker, "UPDATE").await.map_err(|e| fail(&e))?;
    tx.execute(r#"DELETE FROM "Notification" WHERE "userId" = $1"#, &[&me]).await.map_err(|e| fail(&e))?;
    tx.execute(r#"DELETE FROM "NotificationPreference" WHERE "userId" = $1"#, &[&me]).await.map_err(|e| fail(&e))?;
    // The account is anonymized in place (BL-23): history keeps pointing at the row.
    tx.execute(
        r#"UPDATE "User" SET "name" = 'Deleted user', "username" = $2, "email" = NULL, "emailVerified" = false, "password" = NULL, "googleId" = NULL,
               "deletedAt" = $3::text::timestamp, "sessionVersion" = "sessionVersion" + 1, "updatedAt" = now() AT TIME ZONE 'UTC'
           WHERE "id" = $1"#,
        &[&me, &format!("deleted_user_{me}"), &left_at.trim_end_matches('Z')],
    )
    .await
    .map_err(|e| fail(&e))?;
    let row = full_row(&tx, me).await.map_err(|e| fail(&e))?;
    revise(&tx, me.to_string(), Action::Update, Some(me), row, &["password"]).await.map_err(|e| fail(&e))?;
    tx.execute(r#"DELETE FROM "PushSubscription" WHERE "userId" = $1"#, &[&me]).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    Ok(with_cookies(StatusCode::OK, &[CLEAR_SESSION.into(), CLEAR_HOUSE.into()], json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules() {
        assert!(valid_username("ana.b-1_") && !valid_username("An") && !valid_username("ana b"));
        assert_eq!(password_problem("abc").map(|p| p.1), Some("INVALID_PASSWORD"));
        assert_eq!(password_problem("Senha123").map(|p| p.1), Some("PASSWORD_TOO_COMMON"));
        assert_eq!(password_problem("abcdefgh").map(|p| p.1), Some("PASSWORD_NO_COMPLEXITY"));
        assert_eq!(password_problem("casa2026x"), None);
        // Hashed by bcryptjs 3 (scratch script, 2026-11-09): the Next app's stored passwords must keep working.
        assert!(verify("casa2026x", "$2b$10$pTuCNkatQG7PKTLTqynANujp28EZDR8amieMFkuki9bMIGzCaUQfu"));
        assert!(!verify("casa2026y", "$2b$10$pTuCNkatQG7PKTLTqynANujp28EZDR8amieMFkuki9bMIGzCaUQfu"));
        assert!(verify("casa2026x", &hash("casa2026x").unwrap()));
        assert!(valid_email("a@b.co") && !valid_email("a@b") && !valid_email("a b@c.d") && !valid_email("a@@b.c"));
    }
}
