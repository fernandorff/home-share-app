//! The notification center and its switches (spec 009): same answers and rows as src/app/api/notifications/**,
//! src/app/api/notification-preferences and notificationService. Notices are personal: every query filters by the
//! member AND the server-resolved active house; another member's or house's notice is a 404.

use crate::{auth::Session, errors::ApiError, house::ActiveHouse, input, AppState};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use deadpool_postgres::GenericClient;
use serde::Deserialize;
use serde_json::{json, Map, Value};

pub const TYPES: [&str; 4] = ["EXPENSE_NEW", "PAYMENT_RECEIVED", "DEBT_REMINDER", "RECURRING_DUE"];
const LIST_LIMIT: i64 = 50;
const ISO: &str = r#"'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'"#;

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Notice not found", "NOTIFICATION_NOT_FOUND")
}

async fn unread(db: &impl GenericClient, user_id: i32, group_id: i32) -> Result<i64, tokio_postgres::Error> {
    Ok(db
        .query_one(r#"SELECT count(*) FROM "Notification" WHERE "userId" = $1 AND "groupId" = $2 AND "readAt" IS NULL"#, &[&user_id, &group_id])
        .await?
        .get(0))
}

#[derive(Deserialize)]
pub struct ListParams {
    filter: Option<String>,
}

pub async fn list(State(state): State<AppState>, house: ActiveHouse, Query(params): Query<ListParams>) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to list notices", e);
    let me = house.session.user_id as i32;
    let unread_only = params.filter.as_deref() == Some("unread");
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    // A batch insert stamps its rows with one createdAt: the id keeps the order stable.
    let sql = format!(
        r#"SELECT "publicId"::text, "type"::text, "actorId", "params", "readAt" IS NOT NULL, to_char("createdAt", {ISO})
           FROM "Notification" WHERE "userId" = $1 AND "groupId" = $2 {} ORDER BY "createdAt" DESC, "id" DESC LIMIT {LIST_LIMIT}"#,
        if unread_only { r#"AND "readAt" IS NULL"# } else { "" }
    );
    let rows = db.query(&sql, &[&me, &house.group_id]).await.map_err(|e| fail(&e))?;
    let notifications: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({ "publicId": r.get::<_, String>(0), "type": r.get::<_, String>(1), "actorId": r.get::<_, Option<i32>>(2),
                    "params": r.get::<_, Value>(3), "read": r.get::<_, bool>(4), "createdAt": r.get::<_, String>(5) })
        })
        .collect();
    let unread_count = unread(&db, me, house.group_id).await.map_err(|e| fail(&e))?;
    Ok(Json(json!({ "notifications": notifications, "unreadCount": unread_count, "groupId": house.group_id })))
}

pub async fn unread_count(State(state): State<AppState>, house: ActiveHouse) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to count unread notices", e);
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let count = unread(&db, house.session.user_id as i32, house.group_id).await.map_err(|e| fail(&e))?;
    Ok(Json(json!({ "count": count, "groupId": house.group_id })))
}

pub async fn read_all(State(state): State<AppState>, house: ActiveHouse) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to mark notices read", e);
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    db.execute(
        r#"UPDATE "Notification" SET "readAt" = date_trunc('milliseconds', now() AT TIME ZONE 'UTC') WHERE "userId" = $1 AND "groupId" = $2 AND "readAt" IS NULL"#,
        &[&(house.session.user_id as i32), &house.group_id],
    )
    .await
    .map_err(|e| fail(&e))?;
    Ok(Json(json!({ "unreadCount": 0 })))
}

/// `{ read: true }` only; idempotent (an already-read notice keeps its first readAt).
pub async fn mark_read(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>, body: Bytes) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to update notice", e);
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if body["read"] != Value::Bool(true) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Send { \"read\": true }", "NOTIFICATION_PATCH_INVALID"));
    }
    if !input::is_uuid(&public_id) {
        return Err(not_found());
    }
    let me = house.session.user_id as i32;
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let scope = r#""publicId" = $1::text::uuid AND "userId" = $2 AND "groupId" = $3"#;
    let changed = db
        .execute(&format!(r#"UPDATE "Notification" SET "readAt" = date_trunc('milliseconds', now() AT TIME ZONE 'UTC') WHERE {scope} AND "readAt" IS NULL"#), &[&public_id, &me, &house.group_id])
        .await
        .map_err(|e| fail(&e))?;
    if changed == 0 && db.query(&format!(r#"SELECT 1 FROM "Notification" WHERE {scope}"#), &[&public_id, &me, &house.group_id]).await.map_err(|e| fail(&e))?.is_empty() {
        return Err(not_found());
    }
    let count = unread(&db, me, house.group_id).await.map_err(|e| fail(&e))?;
    Ok(Json(json!({ "unreadCount": count })))
}

pub async fn delete(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to remove notice", e);
    if !input::is_uuid(&public_id) {
        return Err(not_found());
    }
    let me = house.session.user_id as i32;
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let removed = db
        .execute(r#"DELETE FROM "Notification" WHERE "publicId" = $1::text::uuid AND "userId" = $2 AND "groupId" = $3"#, &[&public_id, &me, &house.group_id])
        .await
        .map_err(|e| fail(&e))?;
    if removed == 0 {
        return Err(not_found());
    }
    let count = unread(&db, me, house.group_id).await.map_err(|e| fail(&e))?;
    Ok(Json(json!({ "unreadCount": count })))
}

/// Every type with its effective value, in enum order: only overrides are stored, a type without a row is on.
async fn preferences(db: &impl GenericClient, user_id: i32) -> Result<Value, tokio_postgres::Error> {
    let rows = db.query(r#"SELECT "type"::text, "enabled" FROM "NotificationPreference" WHERE "userId" = $1"#, &[&user_id]).await?;
    let map: Map<String, Value> = TYPES
        .iter()
        .map(|t| {
            let stored = rows.iter().find(|r| r.get::<_, String>(0) == *t).map(|r| r.get::<_, bool>(1));
            (t.to_string(), Value::Bool(stored.unwrap_or(true)))
        })
        .collect();
    Ok(Value::Object(map))
}

pub async fn get_preferences(State(state): State<AppState>, Session(session): Session) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to load notice preferences", e);
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let preferences = preferences(&db, session.user_id as i32).await.map_err(|e| fail(&e))?;
    Ok(Json(json!({ "preferences": preferences })))
}

pub async fn put_preference(State(state): State<AppState>, Session(session): Session, body: Bytes) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to save notice preference", e);
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let (Some(kind), Some(enabled)) = (body["type"].as_str().filter(|t| TYPES.contains(t)), body["enabled"].as_bool()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Invalid notice preference", "NOTIFICATION_PREF_INVALID"));
    };
    let me = session.user_id as i32;
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    db.execute(
        r#"INSERT INTO "NotificationPreference" ("userId", "type", "enabled", "updatedAt") VALUES ($1, $2::text::"NotificationType", $3, now() AT TIME ZONE 'UTC')
           ON CONFLICT ("userId", "type") DO UPDATE SET "enabled" = EXCLUDED."enabled", "updatedAt" = EXCLUDED."updatedAt""#,
        &[&me, &kind, &enabled],
    )
    .await
    .map_err(|e| fail(&e))?;
    let preferences = preferences(&db, me).await.map_err(|e| fail(&e))?;
    Ok(Json(json!({ "preferences": preferences })))
}
