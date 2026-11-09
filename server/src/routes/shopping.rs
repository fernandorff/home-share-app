//! /api/shopping-items/**: same answers and rows as the Next routes and shoppingItemService
//! (src/app/api/shopping-items/**, src/services/shopping-item.service.ts).

use crate::{
    audit::{self, Action, Activity, Revision},
    errors::ApiError,
    house::ActiveHouse,
    input, money, AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use deadpool_postgres::GenericClient;
use serde_json::{json, Value};

const ISO: &str = r#"'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'"#;

type Fail<'a> = &'a dyn Fn(&dyn std::fmt::Display) -> ApiError;

/// The ShoppingItem columns, as `RETURNING *` and Prisma's scalar result give them.
fn columns(r: &tokio_postgres::Row) -> Value {
    json!({
        "id": r.get::<_, i32>(0), "publicId": r.get::<_, String>(1), "groupId": r.get::<_, i32>(2),
        "name": r.get::<_, String>(3), "isPurchased": r.get::<_, bool>(4), "createdAt": r.get::<_, String>(5),
        "addedById": r.get::<_, Option<i32>>(6),
    })
}

fn select_columns(alias: &str) -> String {
    format!(
        r#"{a}"id", {a}"publicId"::text, {a}"groupId", {a}"name", {a}"isPurchased", to_char({a}"createdAt", {ISO}), {a}"addedById""#,
        a = alias
    )
}

/// The item with itemInclude, as Prisma returns it (the audit extension stores this shape).
async fn load(db: &impl GenericClient, where_sql: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)], order: &str) -> Result<Vec<Value>, tokio_postgres::Error> {
    let sql = format!(
        r#"SELECT {}, u."name" FROM "ShoppingItem" s LEFT JOIN "User" u ON u."id" = s."addedById" WHERE {where_sql} {order}"#,
        select_columns("s.")
    );
    let rows = db.query(&sql, params).await?;
    let ids: Vec<i32> = rows.iter().map(|r| r.get(0)).collect();
    let links = db
        .query(
            &format!(
                r#"SELECT l."shoppingItemId", l."expenseId", to_char(l."linkedAt", {ISO}), e."publicId"::text, e."description", e."amount"::text, to_char(e."date", {ISO})
                   FROM "ShoppingItemExpense" l JOIN "Expense" e ON e."id" = l."expenseId"
                   WHERE l."shoppingItemId" = ANY($1) ORDER BY e."date" DESC"#
            ),
            &[&ids],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let mut item = columns(r);
            let id: i32 = r.get(0);
            item["addedBy"] = match r.get::<_, Option<i32>>(6) {
                Some(user) => json!({ "id": user, "name": r.get::<_, Option<String>>(7) }),
                None => Value::Null,
            };
            item["expenseLinks"] = links
                .iter()
                .filter(|l| l.get::<_, i32>(0) == id)
                .map(|l| {
                    json!({
                        "shoppingItemId": id, "expenseId": l.get::<_, i32>(1), "linkedAt": l.get::<_, String>(2),
                        "expense": { "publicId": l.get::<_, String>(3), "description": l.get::<_, String>(4),
                                     "amount": money::number(money::parse_cents(l.get(5))), "date": l.get::<_, String>(6) },
                    })
                })
                .collect();
            item
        })
        .collect())
}

async fn load_one(db: &impl GenericClient, id: i32) -> Result<Value, tokio_postgres::Error> {
    Ok(load(db, r#"s."id" = $1"#, &[&id], "").await?.remove(0))
}

/// serializeItem: expenseLinks becomes linkedExpenses (the expense of each link).
fn serialize(mut item: Value) -> Value {
    let links = item.as_object_mut().and_then(|o| o.remove("expenseLinks")).unwrap_or_default();
    item["linkedExpenses"] = Value::Array(links.as_array().into_iter().flatten().map(|l| l["expense"].clone()).collect());
    item
}

fn invalid_item() -> ApiError {
    ApiError::plain(StatusCode::BAD_REQUEST, "Invalid item ID")
}

fn not_found() -> ApiError {
    ApiError::plain(StatusCode::NOT_FOUND, "Item not found")
}

/// findOwned: the bare row, scoped to the house.
async fn find_owned(db: &impl GenericClient, group_id: i32, public_id: &str) -> Result<Option<Value>, tokio_postgres::Error> {
    let sql = format!(r#"SELECT {} FROM "ShoppingItem" WHERE "publicId" = $1::text::uuid AND "groupId" = $2 LIMIT 1"#, select_columns(""));
    Ok(db.query(&sql, &[&public_id, &group_id]).await?.first().map(columns))
}

fn revision(item: &Value, action: Action, actor: i32, row: Value) -> Revision<'static> {
    Revision {
        entity_type: "ShoppingItem",
        entity_id: item["id"].to_string(),
        group_id: item["groupId"].as_i64().map(|g| g as i32),
        action,
        actor_id: Some(actor),
        row,
        fields_set: &[],
    }
}

fn activity(house: &ActiveHouse, entity_id: Option<String>, action: &'static str, summary: String, changes: Option<Value>) -> Activity<'static> {
    Activity { group_id: house.group_id, actor_id: Some(house.session.user_id as i32), entity_type: "SHOPPING_ITEM", entity_id, action, summary, changes }
}

fn parse(body: &Bytes, fail: Fail) -> Result<Value, ApiError> {
    serde_json::from_slice(body).map_err(|e| fail(&e))
}

pub async fn list(State(state): State<AppState>, house: ActiveHouse) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to list items", e);
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let items = load(&db, r#"s."groupId" = $1"#, &[&house.group_id], r#"ORDER BY s."isPurchased", s."createdAt" DESC"#).await.map_err(|e| fail(&e))?;
    Ok(Json(json!({ "items": items.into_iter().map(serialize).collect::<Vec<_>>() })))
}

pub async fn create(State(state): State<AppState>, house: ActiveHouse, body: Bytes) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to create item", e);
    let body = parse(&body, &fail)?;
    let Some(name) = body["name"].as_str().map(crate::expense_input::js_trim).filter(|n| !n.is_empty()) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Name is required", "NAME_REQUIRED"));
    };
    if name.encode_utf16().count() > 200 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Name too long (max 200 characters)", "NAME_TOO_LONG"));
    }
    let actor = house.session.user_id as i32;
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let id: i32 = tx
        .query_one(
            r#"INSERT INTO "ShoppingItem" ("publicId", "groupId", "name", "addedById") VALUES ($1::text::uuid, $2, $3, $4) RETURNING "id""#,
            &[&uuid::Uuid::now_v7().to_string(), &house.group_id, &name, &actor],
        )
        .await
        .map_err(|e| fail(&e))?
        .get(0);
    let item = load_one(&tx, id).await.map_err(|e| fail(&e))?;
    audit::record(&tx, revision(&item, Action::Create, actor, item.clone())).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    let item = serialize(item);
    let public_id = item["publicId"].as_str().map(str::to_string);
    audit::activity(&db, activity(&house, public_id, "CREATE", name.to_string(), None)).await;
    Ok((StatusCode::CREATED, Json(json!({ "item": item }))).into_response())
}

pub async fn update(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>, body: Bytes) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to update item", e);
    if !input::is_uuid(&public_id) {
        return Err(invalid_item());
    }
    let body = parse(&body, &fail)?;
    // `!name || !name.trim()`: a truthy non-string has no trim() and fails as a 500.
    let name = match &body["name"] {
        Value::String(s) if !crate::expense_input::js_trim(s).is_empty() => crate::expense_input::js_trim(s).to_string(),
        other if !input::truthy(other) || other.is_string() => return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Name is required")),
        _ => return Err(fail(&"name.trim is not a function")),
    };
    let actor = house.session.user_id as i32;
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let Some(existing) = find_owned(&db, house.group_id, &public_id).await.map_err(|e| fail(&e))? else { return Err(not_found()) };
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let id = existing["id"].as_i64().unwrap_or_default() as i32;
    tx.execute(r#"UPDATE "ShoppingItem" SET "name" = $1 WHERE "id" = $2"#, &[&name, &id]).await.map_err(|e| fail(&e))?;
    let item = load_one(&tx, id).await.map_err(|e| fail(&e))?;
    audit::record(&tx, revision(&item, Action::Update, actor, item.clone())).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    let before = existing["name"].as_str().unwrap_or_default();
    let changes = (before != name).then(|| json!({ "name": { "from": before, "to": name } }));
    audit::activity(&db, activity(&house, Some(public_id), "UPDATE", name.clone(), changes)).await;
    Ok(Json(json!({ "item": serialize(item) })))
}

pub async fn delete(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to delete item", e);
    if !input::is_uuid(&public_id) {
        return Err(invalid_item());
    }
    let actor = house.session.user_id as i32;
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let Some(item) = find_owned(&db, house.group_id, &public_id).await.map_err(|e| fail(&e))? else { return Err(not_found()) };
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    tx.execute(r#"DELETE FROM "ShoppingItem" WHERE "id" = $1"#, &[&(item["id"].as_i64().unwrap_or_default() as i32)]).await.map_err(|e| fail(&e))?;
    audit::record(&tx, revision(&item, Action::Delete, actor, item.clone())).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    let name = item["name"].as_str().unwrap_or_default().to_string();
    audit::activity(&db, activity(&house, Some(public_id), "DELETE", name, None)).await;
    Ok(Json(json!({ "success": true })))
}

/// The flip runs in the database (NOT "isPurchased") so concurrent taps land on the right state; its revision
/// is explicit (raw SQL skips the audit extension) and best-effort, like the Next service.
pub async fn toggle(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to toggle item", e);
    if !input::is_uuid(&public_id) {
        return Err(invalid_item());
    }
    let actor = house.session.user_id as i32;
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let Some(item) = find_owned(&db, house.group_id, &public_id).await.map_err(|e| fail(&e))? else { return Err(not_found()) };
    let id = item["id"].as_i64().unwrap_or_default() as i32;
    let sql = format!(r#"UPDATE "ShoppingItem" SET "isPurchased" = NOT "isPurchased" WHERE "id" = $1 RETURNING {}"#, select_columns(""));
    let Some(row) = db.query(&sql, &[&id]).await.map_err(|e| fail(&e))?.first().map(columns) else { return Err(not_found()) };
    let purchased = row["isPurchased"].as_bool().unwrap_or_default();
    let mut before = row.clone();
    before["isPurchased"] = json!(!purchased);
    let written = db
        .execute(
            r#"INSERT INTO "EntityRevision" ("entityType", "entityId", "groupId", "action", "actorId", "before", "after", "createdAt")
               VALUES ('ShoppingItem', $1, $2, 'UPDATE', $3, $4, $5, clock_timestamp() AT TIME ZONE 'UTC')"#,
            &[&id.to_string(), &house.group_id, &actor, &audit::sanitize(before), &audit::sanitize(row)],
        )
        .await;
    if let Err(e) = written {
        eprintln!("audit revision failed (ShoppingItem): {e}");
    }
    let item = load_one(&db, id).await.map_err(|e| fail(&e))?;
    let name = item["name"].as_str().unwrap_or_default().to_string();
    let changes = json!({ "purchased": { "from": !purchased, "to": purchased } });
    audit::activity(&db, activity(&house, Some(public_id), "UPDATE", name, Some(changes))).await;
    Ok(Json(json!({ "item": serialize(item) })))
}

pub async fn clear_purchased(State(state): State<AppState>, house: ActiveHouse) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Erro ao limpar itens comprados", e);
    let actor = house.session.user_id as i32;
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let deleted = tx
        .execute(r#"DELETE FROM "ShoppingItem" WHERE "groupId" = $1 AND "isPurchased" = true"#, &[&house.group_id])
        .await
        .map_err(|e| fail(&e))?;
    // deleteMany marker; its house comes from the audit context, null in the Next app (see expense_writes.rs).
    let marker = Revision {
        entity_type: "ShoppingItem", entity_id: format!("bulk:{deleted}"), group_id: None, action: Action::Delete,
        actor_id: Some(actor), row: json!({ "where": { "groupId": house.group_id, "isPurchased": true }, "data": null }), fields_set: &[],
    };
    audit::bulk(&tx, marker, "DELETE").await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    if deleted > 0 {
        audit::activity(&db, activity(&house, None, "CLEAR", deleted.to_string(), None)).await;
    }
    Ok(Json(json!({ "deleted": deleted })))
}

const MAX_LINKS: usize = 100;

pub async fn replace_links(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>, body: Bytes) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to link expenses", e);
    let invalid = |message: &'static str| ApiError::new(StatusCode::BAD_REQUEST, message, "INVALID_EXPENSE_LINKS");
    if !input::is_uuid(&public_id) {
        return Err(invalid("Invalid item ID"));
    }
    let body = parse(&body, &fail)?;
    if let Some(expected) = body["expectedGroupId"].as_f64() {
        if expected != house.group_id as f64 {
            return Err(ApiError::new(StatusCode::CONFLICT, "Your active house changed in another tab. Reload to continue.", "STALE_GROUP"));
        }
    }
    let Some(raw) = body["expenseIds"].as_array().filter(|ids| ids.iter().all(|id| id.as_str().is_some_and(input::is_uuid))) else {
        return Err(invalid("Expense IDs must be valid UUIDs"));
    };
    let mut expense_ids: Vec<String> = Vec::with_capacity(raw.len());
    for id in raw.iter().filter_map(Value::as_str) {
        if !expense_ids.iter().any(|e| e == id) {
            expense_ids.push(id.to_string());
        }
    }
    if expense_ids.len() > MAX_LINKS {
        return Err(invalid("At most 100 expenses can be linked"));
    }

    let actor = house.session.user_id as i32;
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let Some(item) = find_owned(&tx, house.group_id, &public_id).await.map_err(|e| fail(&e))? else { return Err(not_found()) };
    let id = item["id"].as_i64().unwrap_or_default() as i32;
    let linked: Vec<i32> = tx
        .query(r#"SELECT "expenseId" FROM "ShoppingItemExpense" WHERE "shoppingItemId" = $1"#, &[&id])
        .await
        .map_err(|e| fail(&e))?
        .iter()
        .map(|r| r.get(0))
        .collect();
    // An item unchecked after being linked keeps its links editable; linking a never-purchased item is refused.
    if !item["isPurchased"].as_bool().unwrap_or_default() && linked.is_empty() {
        return Err(ApiError::new(StatusCode::CONFLICT, "Only purchased items can be linked to expenses", "ITEM_NOT_PURCHASED"));
    }
    // Same query as Prisma's findMany (no ORDER BY), so the links are created in the same order.
    let expenses: Vec<i32> = tx
        .query(r#"SELECT "id" FROM "Expense" WHERE "groupId" = $1 AND "publicId" = ANY($2::text[]::uuid[])"#, &[&house.group_id, &expense_ids])
        .await
        .map_err(|e| fail(&e))?
        .iter()
        .map(|r| r.get(0))
        .collect();
    if expenses.len() != expense_ids.len() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "One or more expenses were not found in this house", "EXPENSE_NOT_FOUND"));
    }
    if linked.len() == expenses.len() && expenses.iter().all(|e| linked.contains(e)) {
        let current = load_one(&tx, id).await.map_err(|e| fail(&e))?;
        return Ok(Json(json!({ "item": serialize(current) })));
    }

    let removed = tx.execute(r#"DELETE FROM "ShoppingItemExpense" WHERE "shoppingItemId" = $1"#, &[&id]).await.map_err(|e| fail(&e))?;
    // Both markers' house comes from the audit context only (the link rows have no groupId): null, like the Next app.
    let marker = Revision {
        entity_type: "ShoppingItemExpense", entity_id: format!("bulk:{removed}"), group_id: None, action: Action::Delete,
        actor_id: Some(actor), row: json!({ "where": { "shoppingItemId": id }, "data": null }), fields_set: &[],
    };
    audit::bulk(&tx, marker, "DELETE").await.map_err(|e| fail(&e))?;
    if !expenses.is_empty() {
        tx.execute(
            r#"INSERT INTO "ShoppingItemExpense" ("shoppingItemId", "expenseId") SELECT $1, unnest($2::int[])"#,
            &[&id, &expenses],
        )
        .await
        .map_err(|e| fail(&e))?;
        let data: Vec<Value> = expenses.iter().map(|e| json!({ "shoppingItemId": id, "expenseId": e })).collect();
        let marker = Revision {
            entity_type: "ShoppingItemExpense", entity_id: format!("bulk:{}", data.len()), group_id: None, action: Action::Create,
            actor_id: Some(actor), row: Value::Array(data), fields_set: &[],
        };
        audit::bulk(&tx, marker, "CREATE").await.map_err(|e| fail(&e))?;
    }
    let updated = load_one(&tx, id).await.map_err(|e| fail(&e))?;
    // The links live in ShoppingItemExpense, which Activity › Detailed doesn't list: the change is recorded on the
    // item (linked-expense count before → after), in the same transaction as the links.
    let row = |count: usize| {
        let mut r = item.clone();
        r["linkedExpenses"] = json!(count);
        audit::sanitize(r)
    };
    tx.execute(
        r#"INSERT INTO "EntityRevision" ("entityType", "entityId", "groupId", "action", "actorId", "before", "after", "createdAt")
           VALUES ('ShoppingItem', $1, $2, 'UPDATE', $3, $4, $5, clock_timestamp() AT TIME ZONE 'UTC')"#,
        &[&id.to_string(), &house.group_id, &actor, &row(linked.len()), &row(expenses.len())],
    )
    .await
    .map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    let item = serialize(updated);
    let name = item["name"].as_str().unwrap_or_default().to_string();
    audit::activity(&db, activity(&house, Some(public_id), "UPDATE", name, Some(json!({ "linkedExpenseIds": expense_ids })))).await;
    Ok(Json(json!({ "item": item })))
}
