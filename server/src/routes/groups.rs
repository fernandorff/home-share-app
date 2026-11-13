//! /api/groups/**: same answers and rows as the Next routes and groupService
//! (src/app/api/groups/**, src/services/group.service.ts, src/lib/join-code.ts).

use crate::{
    audit::{self, Action, Activity, Revision},
    auth::{cookie, Session, GROUP_COOKIE},
    errors::{json_body, ApiError},
    expense_input::js_trim,
    house::ActiveHouse,
    input, AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use deadpool_postgres::GenericClient;
use serde_json::{json, Value};
use std::time::Duration;

const ISO: &str = r#"'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'"#;
const CURRENCIES: [&str; 4] = ["BRL", "USD", "EUR", "GBP"];
const MEMBER_COLORS_COUNT: i64 = 12;
// Join codes avoid ambiguous characters (0/O, 1/I/L) so they survive being read aloud.
const JOIN_CODE_ALPHABET: &str = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

fn with_house_cookie(status: StatusCode, group_id: i32, body: Value) -> Response {
    (status, [(header::SET_COOKIE, cookie(GROUP_COOKIE, &group_id.to_string()))], Json(body)).into_response()
}

fn generate_join_code() -> String {
    let alphabet = JOIN_CODE_ALPHABET.as_bytes();
    // The last six bytes of a v7 UUID are random.
    uuid::Uuid::now_v7().as_bytes()[10..16].iter().map(|b| alphabet[*b as usize % alphabet.len()] as char).collect()
}

fn valid_join_code(code: &str) -> bool {
    code.encode_utf16().count() == 6 && code.chars().all(|c| JOIN_CODE_ALPHABET.contains(c))
}

// ---- rows as Prisma returns them (the audit extension stores these) ----

const MEMBER_COLUMNS: &str = r#""id", "userId", "groupId", "role"::text, "colorIndex", to_char("createdAt", "#;

fn member_sql(where_sql: &str) -> String {
    format!(r#"SELECT {MEMBER_COLUMNS}{ISO}), to_char("leftAt", {ISO}) FROM "GroupMember" WHERE {where_sql}"#)
}

fn member_row(r: &tokio_postgres::Row) -> Value {
    json!({
        "id": r.get::<_, i32>(0), "userId": r.get::<_, i32>(1), "groupId": r.get::<_, i32>(2), "role": r.get::<_, String>(3),
        "colorIndex": r.get::<_, i32>(4), "createdAt": r.get::<_, String>(5), "leftAt": r.get::<_, Option<String>>(6),
    })
}

async fn membership(db: &impl GenericClient, user_id: i32, group_id: i32) -> Result<Option<Value>, tokio_postgres::Error> {
    Ok(db.query(&member_sql(r#""userId" = $1 AND "groupId" = $2"#), &[&user_id, &group_id]).await?.first().map(member_row))
}

fn group_sql(where_sql: &str) -> String {
    format!(
        r#"SELECT "id", "publicId"::text, "name", "description", "joinCode", "currency", to_char("createdAt", {ISO}), to_char("updatedAt", {ISO})
           FROM "Group" WHERE {where_sql}"#
    )
}

fn group_row(r: &tokio_postgres::Row) -> Value {
    json!({
        "id": r.get::<_, i32>(0), "publicId": r.get::<_, String>(1), "name": r.get::<_, String>(2), "description": r.get::<_, Option<String>>(3),
        "joinCode": r.get::<_, Option<String>>(4), "currency": r.get::<_, String>(5), "createdAt": r.get::<_, String>(6), "updatedAt": r.get::<_, String>(7),
    })
}

async fn group_by_id(db: &impl GenericClient, id: i32) -> Result<Value, tokio_postgres::Error> {
    Ok(group_row(&db.query_one(&group_sql(r#""id" = $1"#), &[&id]).await?))
}

fn id_of(row: &Value) -> i32 {
    row["id"].as_i64().unwrap_or_default() as i32
}

/// One revision per single-row write, as the audit extension stores it.
async fn revise(db: &impl GenericClient, entity: &'static str, group_id: i32, action: Action, actor: i32, row: Value, fields_set: &'static [&'static str]) -> Result<(), tokio_postgres::Error> {
    audit::record(db, Revision { entity_type: entity, entity_id: id_of(&row).to_string(), group_id: Some(group_id), action, actor_id: Some(actor), row, fields_set }).await
}

// ---- routes ----

pub async fn list(State(state): State<AppState>, Session(session): Session) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to list houses", e);
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let rows = db
        .query(
            r#"SELECT g."id", g."publicId"::text, g."name", g."currency", m."role"::text, m."colorIndex"
               FROM "GroupMember" m JOIN "Group" g ON g."id" = m."groupId"
               WHERE m."userId" = $1 AND m."leftAt" IS NULL ORDER BY m."createdAt""#,
            &[&(session.user_id as i32)],
        )
        .await
        .map_err(|e| fail(&e))?;
    let groups: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({ "id": r.get::<_, i32>(0), "publicId": r.get::<_, String>(1), "name": r.get::<_, String>(2), "currency": r.get::<_, String>(3),
                    "role": r.get::<_, String>(4), "colorIndex": r.get::<_, i32>(5) })
        })
        .collect();
    Ok(Json(json!({ "groups": groups })))
}

pub async fn create(State(state): State<AppState>, Session(session): Session, body: Bytes) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to create house", e);
    let body = json_body(&body)?;
    let name = body["name"].as_str().map(js_trim).unwrap_or("");
    if name.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "House name is required", "NAME_REQUIRED"));
    }
    if name.encode_utf16().count() > 80 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "House name too long (max 80 characters)", "NAME_TOO_LONG"));
    }
    let actor = session.user_id as i32;
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let id: i32 = tx
        .query_one(
            r#"INSERT INTO "Group" ("publicId", "name", "joinCode", "updatedAt") VALUES ($1::text::uuid, $2, $3, now() AT TIME ZONE 'UTC') RETURNING "id""#,
            &[&uuid::Uuid::now_v7().to_string(), &name, &generate_join_code()],
        )
        .await
        .map_err(|e| fail(&e))?
        .get(0);
    let group = group_by_id(&tx, id).await.map_err(|e| fail(&e))?;
    revise(&tx, "Group", id, Action::Create, actor, group.clone(), &[]).await.map_err(|e| fail(&e))?;
    let member = tx
        .query_one(
            &format!(r#"INSERT INTO "GroupMember" ("userId", "groupId", "role", "colorIndex") VALUES ($1, $2, 'ADMIN', 0) RETURNING {MEMBER_COLUMNS}{ISO}), to_char("leftAt", {ISO})"#),
            &[&actor, &id],
        )
        .await
        .map_err(|e| fail(&e))?;
    revise(&tx, "GroupMember", id, Action::Create, actor, member_row(&member), &[]).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    let out = json!({ "group": { "id": id, "publicId": group["publicId"], "name": group["name"], "joinCode": group["joinCode"] } });
    Ok(with_house_cookie(StatusCode::CREATED, id, out))
}

/// JS Number(value) for a JSON value.
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::Bool(b) => *b as i32 as f64,
        Value::Null => 0.0,
        Value::String(s) => {
            let t = js_trim(s);
            if t.is_empty() { 0.0 } else { t.parse().ok().filter(|_| !t.contains(['i', 'I', 'n', 'N'])).unwrap_or(f64::NAN) }
        }
        Value::Array(items) if items.is_empty() => 0.0,
        Value::Array(items) if items.len() == 1 => match &items[0] {
            Value::Array(_) | Value::Object(_) => js_number(&items[0]),
            Value::Null => 0.0,
            other => js_number(&Value::String(other.as_str().map(str::to_string).unwrap_or_else(|| other.to_string()))),
        },
        _ => f64::NAN,
    }
}

pub async fn switch(State(state): State<AppState>, Session(session): Session, body: Bytes) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to switch house", e);
    let body = json_body(&body)?;
    let group_id = js_number(&body["groupId"]);
    if group_id.fract() != 0.0 || !group_id.is_finite() || group_id <= 0.0 {
        return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Invalid house"));
    }
    // Beyond Int4, Prisma's query fails (500).
    let Some(group_id) = (group_id <= i32::MAX as f64).then_some(group_id as i32) else { return Err(fail(&"groupId out of range")) };
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let found = membership(&db, session.user_id as i32, group_id).await.map_err(|e| fail(&e))?;
    if !found.is_some_and(|m| m["leftAt"].is_null()) {
        return Err(ApiError::plain(StatusCode::FORBIDDEN, "You are not a member of this house"));
    }
    Ok(with_house_cookie(StatusCode::OK, group_id, json!({ "ok": true, "groupId": group_id })))
}

/// MEMBER, unless the house has no active admin: then the joiner becomes its admin.
async fn role_for_joiner(db: &impl GenericClient, group_id: i32) -> Result<&'static str, tokio_postgres::Error> {
    let admins: i64 = db
        .query_one(r#"SELECT count(*) FROM "GroupMember" WHERE "groupId" = $1 AND "role" = 'ADMIN' AND "leftAt" IS NULL"#, &[&group_id])
        .await?
        .get(0);
    Ok(if admins > 0 { "MEMBER" } else { "ADMIN" })
}

pub async fn join(State(state): State<AppState>, Session(session): Session, body: Bytes) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to join house", e);
    let actor = session.user_id as i32;
    if !crate::rate_limit::allow(format!("join:user:{actor}"), 20, Duration::from_secs(60)) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "Too many attempts. Try again shortly.", "RATE_LIMITED"));
    }
    let body = json_body(&body)?;
    let code = body["code"].as_str().map(|c| js_trim(c).to_uppercase()).unwrap_or_default();
    if !valid_join_code(&code) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Invalid code — must be 6 characters", "INVALID_CODE_FORMAT"));
    }
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let Some(group) = db.query(&group_sql(r#""joinCode" = $1"#), &[&code]).await.map_err(|e| fail(&e))?.first().map(group_row) else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Invalid code — check with whoever invited you", "INVALID_CODE"));
    };
    let group_id = id_of(&group);
    if let Some(existing) = membership(&db, actor, group_id).await.map_err(|e| fail(&e))? {
        // Rejoining reactivates the same row; the old role does not survive it.
        if !existing["leftAt"].is_null() {
            let role = role_for_joiner(&db, group_id).await.map_err(|e| fail(&e))?;
            let sql = format!(r#"UPDATE "GroupMember" SET "leftAt" = NULL, "role" = $1::text::"GroupRole" WHERE "id" = $2 RETURNING {MEMBER_COLUMNS}{ISO}), to_char("leftAt", {ISO})"#);
            let row = db.query_one(&sql, &[&role, &id_of(&existing)]).await.map_err(|e| fail(&e))?;
            revise(&db, "GroupMember", group_id, Action::Update, actor, member_row(&row), &[]).await.map_err(|e| fail(&e))?;
        }
    } else {
        // Every row ever created counts, so an ex-member's color slot isn't handed to someone new.
        let count: i64 = db.query_one(r#"SELECT count(*) FROM "GroupMember" WHERE "groupId" = $1"#, &[&group_id]).await.map_err(|e| fail(&e))?.get(0);
        let role = role_for_joiner(&db, group_id).await.map_err(|e| fail(&e))?;
        let sql = format!(
            r#"INSERT INTO "GroupMember" ("userId", "groupId", "role", "colorIndex") VALUES ($1, $2, $3::text::"GroupRole", $4)
               ON CONFLICT ("userId", "groupId") DO NOTHING RETURNING {MEMBER_COLUMNS}{ISO}), to_char("leftAt", {ISO})"#
        );
        // A concurrent double-tap already made the membership: joining stays idempotent.
        if let Some(row) = db.query_opt(&sql, &[&actor, &group_id, &role, &((count % MEMBER_COLORS_COUNT) as i32)]).await.map_err(|e| fail(&e))? {
            revise(&db, "GroupMember", group_id, Action::Create, actor, member_row(&row), &[]).await.map_err(|e| fail(&e))?;
        }
    }
    let out = json!({ "group": { "id": group_id, "publicId": group["publicId"], "name": group["name"] } });
    Ok(with_house_cookie(StatusCode::OK, group_id, out))
}

pub async fn members(State(state): State<AppState>, house: ActiveHouse) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Erro ao listar membros", e);
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let rows = db
        .query(
            r#"SELECT u."id", u."publicId"::text, u."name", u."username", m."role"::text, m."colorIndex", m."leftAt" IS NULL, u."deletedAt" IS NOT NULL
               FROM "GroupMember" m JOIN "User" u ON u."id" = m."userId" WHERE m."groupId" = $1 ORDER BY m."createdAt""#,
            &[&house.group_id],
        )
        .await
        .map_err(|e| fail(&e))?;
    let members: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({ "id": r.get::<_, i32>(0), "publicId": r.get::<_, String>(1), "name": r.get::<_, String>(2), "username": r.get::<_, Option<String>>(3),
                    "role": r.get::<_, String>(4), "colorIndex": r.get::<_, i32>(5), "active": r.get::<_, bool>(6), "deleted": r.get::<_, bool>(7) })
        })
        .collect();
    Ok(Json(json!({ "members": members, "groupId": house.group_id })))
}

fn not_admin(message: &'static str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, message, "NOT_ADMIN")
}

pub async fn currency(State(state): State<AppState>, house: ActiveHouse, body: Bytes) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to change currency", e);
    if !house.is_admin {
        return Err(not_admin("Only the house admin can change the currency"));
    }
    let body = json_body(&body)?;
    let Some(currency) = body["currency"].as_str().filter(|c| CURRENCIES.contains(c)) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Invalid currency", "INVALID_CURRENCY"));
    };
    let actor = house.session.user_id as i32;
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let current = group_by_id(&db, house.group_id).await.map_err(|e| fail(&e))?;
    let previous = current["currency"].as_str().unwrap_or_default().to_string();
    // Re-picking the active currency writes nothing: no revision, no activity entry.
    if previous != currency {
        let tx = db.transaction().await.map_err(|e| fail(&e))?;
        tx.execute(r#"UPDATE "Group" SET "currency" = $1, "updatedAt" = now() AT TIME ZONE 'UTC' WHERE "id" = $2"#, &[&currency, &house.group_id])
            .await
            .map_err(|e| fail(&e))?;
        let group = group_by_id(&tx, house.group_id).await.map_err(|e| fail(&e))?;
        revise(&tx, "Group", house.group_id, Action::Update, actor, group, &[]).await.map_err(|e| fail(&e))?;
        tx.commit().await.map_err(|e| fail(&e))?;
        audit::activity(&db, Activity {
            group_id: house.group_id, actor_id: Some(actor), entity_type: "GROUP", entity_id: None, action: "UPDATE",
            summary: currency.to_string(), changes: Some(json!({ "currency": { "from": previous, "to": currency } })),
        })
        .await;
    }
    Ok(Json(json!({ "currency": currency })))
}

pub async fn regenerate_code(State(state): State<AppState>, house: ActiveHouse) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to regenerate code", e);
    if !house.is_admin {
        return Err(not_admin("Only the house admin can regenerate the code"));
    }
    let actor = house.session.user_id as i32;
    let join_code = generate_join_code();
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    tx.execute(r#"UPDATE "Group" SET "joinCode" = $1, "updatedAt" = now() AT TIME ZONE 'UTC' WHERE "id" = $2"#, &[&join_code, &house.group_id])
        .await
        .map_err(|e| fail(&e))?;
    let group = group_by_id(&tx, house.group_id).await.map_err(|e| fail(&e))?;
    revise(&tx, "Group", house.group_id, Action::Update, actor, group, &["joinCode"]).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    // Only a marker goes into the feed: the code itself is admin-only, the feed is readable by every member.
    audit::activity(&db, Activity {
        group_id: house.group_id, actor_id: Some(actor), entity_type: "GROUP", entity_id: None, action: "UPDATE",
        summary: String::new(), changes: Some(json!({ "joinCodeChanged": true })),
    })
    .await;
    Ok(Json(json!({ "joinCode": join_code })))
}

fn last_admin() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "This house would be left without an admin — promote another member first", "LAST_ADMIN")
}

fn member_gone() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "This person is no longer a member of this house", "MEMBER_NOT_FOUND")
}

/// assertCanLeave + removeMember: soft-removes the membership (the row stays, so history keeps the real name) and
/// drops that person's notices in the house. The last-admin rule is re-checked inside the same transaction.
async fn remove_member(state: &AppState, group_id: i32, user_id: i32, actor: i32, message: &'static str) -> Result<(), ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal(message, e);
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let target = membership(&db, user_id, group_id).await.map_err(|e| fail(&e))?;
    let Some(target) = target.filter(|t| t["leftAt"].is_null()) else { return Err(member_gone()) };
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let sql = format!(r#"UPDATE "GroupMember" SET "leftAt" = date_trunc('milliseconds', now() AT TIME ZONE 'UTC') WHERE "id" = $1 RETURNING {MEMBER_COLUMNS}{ISO}), to_char("leftAt", {ISO})"#);
    let row = tx.query_one(&sql, &[&id_of(&target)]).await.map_err(|e| fail(&e))?;
    let counts = tx
        .query_one(
            r#"SELECT count(*) FILTER (WHERE "role" = 'ADMIN'), count(*) FROM "GroupMember" WHERE "groupId" = $1 AND "leftAt" IS NULL"#,
            &[&group_id],
        )
        .await
        .map_err(|e| fail(&e))?;
    let (admins, members): (i64, i64) = (counts.get(0), counts.get(1));
    if admins == 0 && members > 0 {
        return Err(last_admin()); // the transaction rolls back on drop
    }
    tx.execute(r#"DELETE FROM "Notification" WHERE "userId" = $1 AND "groupId" = $2"#, &[&user_id, &group_id]).await.map_err(|e| fail(&e))?;
    revise(&tx, "GroupMember", group_id, Action::Update, actor, member_row(&row), &[]).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    Ok(())
}

pub async fn leave(State(state): State<AppState>, house: ActiveHouse) -> Result<Json<Value>, ApiError> {
    let me = house.session.user_id as i32;
    remove_member(&state, house.group_id, me, me, "Failed to leave house").await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn kick(State(state): State<AppState>, house: ActiveHouse, Path(target): Path<String>) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to remove member", e);
    if !house.is_admin {
        return Err(not_admin("Only the house admin can remove members"));
    }
    if !input::is_uuid(&target) {
        return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Invalid ID"));
    }
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let found = db.query(r#"SELECT "id" FROM "User" WHERE "publicId" = $1::text::uuid"#, &[&target]).await.map_err(|e| fail(&e))?;
    let Some(user_id) = found.first().map(|r| r.get::<_, i32>(0)) else {
        return Err(member_gone()); // same answer as another house's member: an admin can't probe which ids exist
    };
    let me = house.session.user_id as i32;
    if user_id == me {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Use \"Leave house\" to remove yourself", "CANNOT_REMOVE_SELF"));
    }
    drop(db);
    remove_member(&state, house.group_id, user_id, me, "Failed to remove member").await?;
    Ok(Json(json!({ "ok": true })))
}

/// promoteToAdmin: only `{ role: "ADMIN" }`; the target must be an active member of this house; idempotent.
pub async fn promote(State(state): State<AppState>, house: ActiveHouse, Path(target): Path<String>, body: Bytes) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to change member role", e);
    if !input::is_uuid(&target) {
        return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Invalid ID"));
    }
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if body["role"].as_str() != Some("ADMIN") {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Only promotion to ADMIN is supported", "INVALID_ROLE"));
    }
    if !house.is_admin {
        return Err(not_admin("Only the house admin can change roles"));
    }
    let actor = house.session.user_id as i32;
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let found = db
        .query(
            r#"SELECT m."id", m."role"::text FROM "GroupMember" m JOIN "User" u ON u."id" = m."userId"
               WHERE m."groupId" = $1 AND m."leftAt" IS NULL AND u."publicId" = $2::text::uuid LIMIT 1"#,
            &[&house.group_id, &target],
        )
        .await
        .map_err(|e| fail(&e))?;
    let Some((id, role)) = found.first().map(|r| (r.get::<_, i32>(0), r.get::<_, String>(1))) else { return Err(member_gone()) };
    if role != "ADMIN" {
        let tx = db.transaction().await.map_err(|e| fail(&e))?;
        let sql = format!(r#"UPDATE "GroupMember" SET "role" = 'ADMIN' WHERE "id" = $1 RETURNING {MEMBER_COLUMNS}{ISO}), to_char("leftAt", {ISO})"#);
        let row = tx.query_one(&sql, &[&id]).await.map_err(|e| fail(&e))?;
        revise(&tx, "GroupMember", house.group_id, Action::Update, actor, member_row(&row), &[]).await.map_err(|e| fail(&e))?;
        tx.commit().await.map_err(|e| fail(&e))?;
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_codes() {
        let code = generate_join_code();
        assert!(valid_join_code(&code), "{code}");
        assert!(!valid_join_code("ABC12O"));
        assert!(!valid_join_code("ABCDEFG"));
    }

    #[test]
    fn numbers_like_js() {
        assert_eq!(js_number(&json!("2")), 2.0);
        assert_eq!(js_number(&json!(true)), 1.0);
        assert_eq!(js_number(&json!(null)), 0.0);
        assert_eq!(js_number(&json!([3])), 3.0);
        assert!(js_number(&json!("x")).is_nan());
        assert!(js_number(&json!({})).is_nan());
    }

}
