//! A house's custom categories, platforms and payment methods (src/services/tag-service.ts and the
//! /api/categories, /api/platforms, /api/payment-methods routes): one implementation for the three.

use crate::{
    audit::{self, Action, Activity, Revision},
    errors::{json_body, ApiError},
    house::ActiveHouse,
    input, system_defaults, AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use deadpool_postgres::GenericClient;
use serde::Deserialize;
use serde_json::{json, Value};

pub struct Kind {
    table: &'static str,
    column: &'static str,
    /// Response key for one row / for the list.
    one: &'static str,
    many: &'static str,
    activity: &'static str,
    /// Lower-case words for the error messages ("payment method").
    label: &'static str,
    max: usize,
    system: &'static [&'static str],
    deleted: &'static str,
}

pub const CATEGORY: Kind = Kind {
    table: "Category", column: "categories", one: "category", many: "categories", activity: "CATEGORY", label: "category",
    max: 30, system: system_defaults::CATEGORY, deleted: "Category deleted successfully",
};
pub const PLATFORM: Kind = Kind {
    table: "Platform", column: "platforms", one: "platform", many: "platforms", activity: "PLATFORM", label: "platform",
    max: 80, system: system_defaults::PLATFORM, deleted: "Platform deleted successfully",
};
pub const PAYMENT: Kind = Kind {
    table: "PaymentMethod", column: "paymentMethods", one: "paymentMethod", many: "paymentMethods", activity: "PAYMENT_METHOD",
    label: "payment method", max: 30, system: system_defaults::PAYMENT, deleted: "Payment method deleted successfully",
};

/// Intl.Collator('pt-BR'): base sensitivity first (case and accents ignored), then the full comparison.
fn sort_by_name(rows: &mut [Value]) {
    use icu_collator::{options::CollatorOptions, options::Strength, Collator};
    let locale = icu_locale_core::locale!("pt-BR");
    let mut base = CollatorOptions::default();
    base.strength = Some(Strength::Primary);
    let primary = Collator::try_new(locale.clone().into(), base).expect("pt-BR collation data");
    let full = Collator::try_new(locale.into(), CollatorOptions::default()).expect("pt-BR collation data");
    let name = |v: &Value| v["name"].as_str().unwrap_or_default().to_string();
    rows.sort_by(|a, b| primary.compare(&name(a), &name(b)).then_with(|| full.compare(&name(a), &name(b))));
}

fn row_json(r: &tokio_postgres::Row) -> Value {
    json!({ "id": r.get::<_, i32>(0), "publicId": r.get::<_, String>(1), "groupId": r.get::<_, i32>(2), "name": r.get::<_, String>(3), "createdAt": r.get::<_, String>(4) })
}

const COLUMNS: &str = r#""id", "publicId"::text, "groupId", "name", to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')"#;

#[derive(Deserialize)]
pub struct ListParams {
    counts: Option<String>,
}

pub async fn list(kind: &'static Kind, state: AppState, house: ActiveHouse, params: ListParams) -> Result<Json<Value>, ApiError> {
    let message: &'static str = match kind.one {
        "category" => "Failed to list categories",
        "platform" => "Failed to list platforms",
        _ => "Failed to list payment methods",
    };
    let fail = |e: &dyn std::fmt::Display| ApiError::internal(message, e);
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let sql = format!(r#"SELECT {COLUMNS} FROM "{}" WHERE "groupId" = $1 ORDER BY "name""#, kind.table);
    let mut rows: Vec<Value> = db.query(&sql, &[&house.group_id]).await.map_err(|e| fail(&e))?.iter().map(row_json).collect();
    sort_by_name(&mut rows);
    if params.counts.as_deref() == Some("true") && !rows.is_empty() {
        let sql = format!(r#"SELECT tag, COUNT(*)::bigint FROM "Expense", unnest("{}") AS tag WHERE "groupId" = $1 GROUP BY tag"#, kind.column);
        let counts: Vec<(String, i64)> = db.query(&sql, &[&house.group_id]).await.map_err(|e| fail(&e))?.iter().map(|r| (r.get(0), r.get(1))).collect();
        for row in &mut rows {
            let n = counts.iter().find(|(t, _)| Some(t.as_str()) == row["name"].as_str()).map_or(0, |c| c.1);
            row["_count"] = json!({ "expenses": n });
        }
    }
    Ok(Json(Value::Object([(kind.many.to_string(), Value::Array(rows))].into_iter().collect())))
}

pub async fn create(kind: &'static Kind, state: AppState, house: ActiveHouse, body: Bytes) -> Result<Response, ApiError> {
    let message: &'static str = match kind.one {
        "category" => "Failed to create category",
        "platform" => "Failed to create platform",
        _ => "Failed to create payment method",
    };
    let fail = |e: &dyn std::fmt::Display| ApiError::internal(message, e);
    let body: Value = json_body(&body)?;
    let name = body.get("name").and_then(Value::as_str).map(|n| crate::expense_input::js_trim(n).to_string()).unwrap_or_default();
    if name.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Name is required", "NAME_REQUIRED"));
    }
    if name.encode_utf16().count() > kind.max {
        return Err(ApiError { code: Some("NAME_TOO_LONG"), ..ApiError::plain(StatusCode::BAD_REQUEST, format!("Name too long (max {} characters)", kind.max)) });
    }
    // A name equal to a system default's label in any language would read as the same tag.
    if kind.system.contains(&name.to_lowercase().as_str()) {
        let m = format!("That {} already exists as a system default", kind.label);
        return Err(ApiError { code: Some("SYSTEM_DEFAULT_COLLISION"), ..ApiError::plain(StatusCode::CONFLICT, m) });
    }
    let duplicate = || ApiError { code: Some("DUPLICATE_NAME"), ..ApiError::plain(StatusCode::CONFLICT, format!("A {} with that name already exists", kind.label)) };
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let exists = db
        .query(&format!(r#"SELECT 1 FROM "{}" WHERE "groupId" = $1 AND "name" = $2 LIMIT 1"#, kind.table), &[&house.group_id, &name])
        .await
        .map_err(|e| fail(&e))?;
    if !exists.is_empty() {
        return Err(duplicate());
    }
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let sql = format!(r#"INSERT INTO "{}" ("publicId", "groupId", "name") VALUES ($1::text::uuid, $2, $3) ON CONFLICT DO NOTHING RETURNING {COLUMNS}"#, kind.table);
    let Some(row) = tx.query_opt(&sql, &[&uuid::Uuid::now_v7().to_string(), &house.group_id, &name]).await.map_err(|e| fail(&e))? else {
        return Err(duplicate()); // lost the race to a concurrent create (Prisma's P2002)
    };
    let row = row_json(&row);
    let actor = Some(house.session.user_id as i32);
    let revision = Revision { entity_type: kind.table, entity_id: row["id"].to_string(), group_id: Some(house.group_id), action: Action::Create, actor_id: actor, row: row.clone(), fields_set: &[] };
    audit::record(&tx, revision).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    audit::activity(&db, Activity {
        group_id: house.group_id, actor_id: actor, entity_type: kind.activity, entity_id: row["publicId"].as_str().map(str::to_string),
        action: "CREATE", summary: name, changes: None,
    })
    .await;
    Ok((StatusCode::CREATED, Json(Value::Object([(kind.one.to_string(), row)].into_iter().collect()))).into_response())
}

pub async fn delete(kind: &'static Kind, state: AppState, house: ActiveHouse, public_id: String) -> Result<Json<Value>, ApiError> {
    let message: &'static str = match kind.one {
        "category" => "Failed to delete category",
        "platform" => "Failed to delete platform",
        _ => "Failed to delete payment method",
    };
    let fail = |e: &dyn std::fmt::Display| ApiError::internal(message, e);
    if !input::is_uuid(&public_id) {
        return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Invalid ID"));
    }
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let found = db
        .query(&format!(r#"SELECT {COLUMNS} FROM "{}" WHERE "publicId" = $1::text::uuid AND "groupId" = $2"#, kind.table), &[&public_id, &house.group_id])
        .await
        .map_err(|e| fail(&e))?;
    let Some(row) = found.first().map(row_json) else {
        let label = kind.label[..1].to_uppercase() + &kind.label[1..];
        return Err(ApiError::plain(StatusCode::NOT_FOUND, format!("{label} not found")));
    };
    let name = row["name"].as_str().unwrap_or_default().to_string();
    let actor = Some(house.session.user_id as i32);
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    // Pull the tag off every expense of this house that used it; the sub-select hands back the old array.
    let col = kind.column;
    let detached: Vec<(i32, Vec<String>)> = tx
        .query(
            &format!(
                r#"UPDATE "Expense" AS e SET "{col}" = array_remove(e."{col}", $1)
                   FROM (SELECT id, "{col}" AS prev FROM "Expense" WHERE "groupId" = $2 AND $1 = ANY("{col}") FOR UPDATE) AS old
                   WHERE e.id = old.id AND e."groupId" = $2 RETURNING e.id, old.prev"#
            ),
            &[&name, &house.group_id],
        )
        .await
        .map_err(|e| fail(&e))?
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    // Raw SQL is invisible to the Next audit extension, so the service writes these revisions itself (ADR 0009):
    // the expense before (old tags) and after, in the expense snapshot shape, in id order like its findMany.
    let mut ids: Vec<i32> = detached.iter().map(|d| d.0).collect();
    ids.sort_unstable();
    for id in ids {
        let public: String = tx.query_one(r#"SELECT "publicId"::text FROM "Expense" WHERE "id" = $1"#, &[&id]).await.map_err(|e| fail(&e))?.get(0);
        let after = super::expenses::find_with(&tx, house.group_id, &public).await.map_err(|e| fail(&e))?.expect("expense of this house");
        let mut before = after.clone();
        before[col] = json!(detached.iter().find(|d| d.0 == id).map(|d| d.1.clone()));
        tx.execute(
            r#"INSERT INTO "EntityRevision" ("entityType", "entityId", "groupId", "action", "actorId", "before", "after", "createdAt")
               VALUES ('Expense', $1, $2, 'UPDATE', $3, $4, $5, clock_timestamp() AT TIME ZONE 'UTC')"#,
            &[&id.to_string(), &house.group_id, &actor, &audit::sanitize(before), &audit::sanitize(after)],
        )
        .await
        .map_err(|e| fail(&e))?;
    }
    tx.execute(&format!(r#"DELETE FROM "{}" WHERE "id" = $1"#, kind.table), &[&row["id"].as_i64().map(|i| i as i32)]).await.map_err(|e| fail(&e))?;
    let revision = Revision { entity_type: kind.table, entity_id: row["id"].to_string(), group_id: Some(house.group_id), action: Action::Delete, actor_id: actor, row: row.clone(), fields_set: &[] };
    audit::record(&tx, revision).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    audit::activity(&db, Activity {
        group_id: house.group_id, actor_id: actor, entity_type: kind.activity, entity_id: Some(public_id),
        action: "DELETE", summary: name, changes: None,
    })
    .await;
    Ok(Json(json!({ "message": kind.deleted })))
}

// Axum handlers, one set per kind.
macro_rules! handlers {
    ($m:ident, $kind:expr) => {
        pub mod $m {
            use super::*;
            pub async fn list(State(s): State<AppState>, h: ActiveHouse, Query(p): Query<ListParams>) -> Result<Json<Value>, ApiError> { super::list(&$kind, s, h, p).await }
            pub async fn create(State(s): State<AppState>, h: ActiveHouse, b: Bytes) -> Result<Response, ApiError> { super::create(&$kind, s, h, b).await }
            pub async fn delete(State(s): State<AppState>, h: ActiveHouse, Path(id): Path<String>) -> Result<Json<Value>, ApiError> { super::delete(&$kind, s, h, id).await }
        }
    };
}
handlers!(categories, CATEGORY);
handlers!(platforms, PLATFORM);
handlers!(payment_methods, PAYMENT);
