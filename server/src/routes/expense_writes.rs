//! POST /api/expenses, PUT and DELETE /api/expenses/{id}: same answers, rows, revisions, activity and notices
//! as src/app/api/expenses/route.ts and [expenseId]/route.ts over expenseService.create/update/delete.

use super::expenses::find;
use crate::{
    audit::{self, Action, Activity, Revision},
    errors::{json_body, ApiError},
    expense_input::{self, js_trim, ExpenseInput, DEFAULT_CATEGORIES, DEFAULT_PAYMENT_METHODS, DEFAULT_PLATFORMS},
    house::ActiveHouse,
    input, money, notifications, AppState,
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

type Fail<'a> = &'a dyn Fn(&dyn std::fmt::Display) -> ApiError;

/// assertExpectedGroup: a form opened before a house switch in another tab must not write to the new house.
fn stale_group(group_id: i32, body: &Value) -> Result<(), ApiError> {
    match body["expectedGroupId"].as_f64() {
        Some(expected) if expected != group_id as f64 => Err(ApiError::new(
            StatusCode::CONFLICT,
            "Your active house changed in another tab. Reload to continue.",
            "STALE_GROUP",
        )),
        _ => Ok(()),
    }
}

/// A user id as Prisma would bind it to an Int column; anything else makes its query fail (500).
fn user_id(v: &Value, fail: Fail) -> Result<i32, ApiError> {
    input::integer(v).filter(|n| (i32::MIN as f64..=i32::MAX as f64).contains(n)).map(|n| n as i32).ok_or_else(|| fail(&"user id is not an Int"))
}

/// allActiveGroupMembers: every id is a CURRENT member (ex-members can't be put on an expense).
async fn all_active(db: &impl GenericClient, group_id: i32, ids: &[i32]) -> Result<bool, tokio_postgres::Error> {
    if ids.is_empty() {
        return Ok(true);
    }
    let mut distinct = ids.to_vec();
    distinct.sort_unstable();
    distinct.dedup();
    let count: i64 = db
        .query_one(r#"SELECT count(*) FROM "GroupMember" WHERE "groupId" = $1 AND "userId" = ANY($2) AND "leftAt" IS NULL"#, &[&group_id, &ids])
        .await?
        .get(0);
    Ok(count == distinct.len() as i64)
}

/// validateExpenseTags: each tag is a default or one of the house's own entries, categories first.
async fn check_tags(db: &impl GenericClient, group_id: i32, v: &ExpenseInput) -> Result<Result<(), ApiError>, tokio_postgres::Error> {
    let lists: [(&Vec<String>, &[&str], &str, &'static str, &'static str); 3] = [
        (&v.categories, &DEFAULT_CATEGORIES, "Category", "Invalid category", "INVALID_CATEGORY"),
        (&v.platforms, &DEFAULT_PLATFORMS, "Platform", "Invalid platform", "INVALID_PLATFORM"),
        (&v.payment_methods, &DEFAULT_PAYMENT_METHODS, "PaymentMethod", "Invalid payment method", "INVALID_PAYMENT"),
    ];
    for (tags, defaults, table, message, code) in lists {
        for tag in tags {
            if defaults.contains(&tag.as_str()) {
                continue;
            }
            let sql = format!(r#"SELECT 1 FROM "{table}" WHERE "groupId" = $1 AND "name" = $2 LIMIT 1"#);
            if db.query(&sql, &[&group_id, tag]).await?.is_empty() {
                return Ok(Err(ApiError::new(StatusCode::BAD_REQUEST, message, code)));
            }
        }
    }
    Ok(Ok(()))
}

/// groupService.listMembers: (id, active) in join order.
async fn members(db: &impl GenericClient, group_id: i32) -> Result<Vec<(i32, bool)>, tokio_postgres::Error> {
    Ok(db
        .query(r#"SELECT "userId", "leftAt" IS NULL FROM "GroupMember" WHERE "groupId" = $1 ORDER BY "createdAt""#, &[&group_id])
        .await?
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect())
}

/// The shares to store: an equal split over `member_ids` (remainder cent by cent from the first), or the custom split.
fn shares(v: &ExpenseInput, member_ids: &[i32], fail: Fail) -> Result<Vec<(i32, i64)>, ApiError> {
    if v.split_equally || v.participants.is_empty() {
        let split = money::split_cents(v.cents, member_ids.len() as i64);
        return Ok(member_ids.iter().copied().zip(split).collect());
    }
    v.participants.iter().map(|(id, cents)| Ok((user_id(id, fail)?, *cents))).collect()
}

pub(crate) async fn insert_participants(db: &impl GenericClient, expense_id: i32, shares: &[(i32, i64)]) -> Result<(), tokio_postgres::Error> {
    for (user, cents) in shares {
        db.execute(
            r#"INSERT INTO "ExpenseParticipant" ("expenseId", "userId", "amount") VALUES ($1, $2, $3::text::numeric)"#,
            &[&expense_id, user, &money::number(*cents)],
        )
        .await?;
    }
    Ok(())
}

fn notes(v: &ExpenseInput) -> Option<String> {
    v.notes.as_deref().map(js_trim).filter(|n| !n.is_empty()).map(str::to_string)
}

pub async fn create(State(state): State<AppState>, house: ActiveHouse, body: Bytes) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to create expense", e);
    let body = json_body(&body)?;
    stale_group(house.group_id, &body)?;
    let v = expense_input::validate(&body)?;
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;

    let mut involved = vec![user_id(&v.payer_id, &fail)?];
    for (id, _) in &v.participants {
        involved.push(user_id(id, &fail)?);
    }
    if !all_active(&db, house.group_id, &involved).await.map_err(|e| fail(&e))? {
        return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Payer or participant is not a member of this house"));
    }
    check_tags(&db, house.group_id, &v).await.map_err(|e| fail(&e))??;
    let member_ids: Vec<i32> = members(&db, house.group_id).await.map_err(|e| fail(&e))?.into_iter().filter(|m| m.1).map(|m| m.0).collect();
    let shares = shares(&v, &member_ids, &fail)?;

    let actor = house.session.user_id as i32;
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let id: i32 = tx
        .query_one(
            r#"INSERT INTO "Expense" ("publicId", "groupId", "payerId", "platforms", "paymentMethods", "description", "notes", "categories", "amount", "date", "recurringExpenseId", "updatedAt")
               VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7, $8, $9::text::numeric, COALESCE($10, now() AT TIME ZONE 'UTC'), NULL, now() AT TIME ZONE 'UTC')
               RETURNING "id""#,
            &[&uuid::Uuid::now_v7().to_string(), &house.group_id, &involved[0], &v.platforms, &v.payment_methods,
              &js_trim(&v.description), &notes(&v), &v.categories, &money::number(v.cents), &v.date],
        )
        .await
        .map_err(|e| fail(&e))?
        .get(0);
    insert_participants(&tx, id, &shares).await.map_err(|e| fail(&e))?;
    let expense = find_in(&tx, house.group_id, id).await.map_err(|e| fail(&e))?;
    let revision = Revision { entity_type: "Expense", entity_id: id.to_string(), group_id: Some(house.group_id), action: Action::Create, actor_id: Some(actor), row: expense.clone(), fields_set: &[] };
    audit::record(&tx, revision).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;

    let public_id = expense["publicId"].as_str().unwrap_or_default().to_string();
    let description = expense["description"].as_str().unwrap_or_default().to_string();
    audit::activity(&db, Activity {
        group_id: house.group_id, actor_id: Some(actor), entity_type: "EXPENSE", entity_id: Some(public_id.clone()),
        action: "CREATE", summary: description.clone(), changes: Some(json!({ "amount": money::number(v.cents) })),
    })
    .await;
    // EXPENSE_NEW to the payer and everyone with a share > 0, minus the actor.
    let params = json!({ "expensePublicId": public_id, "description": description, "amount": money::fixed2(v.cents), "recurring": false });
    let mut to: Vec<(i32, Value)> = vec![(involved[0], params.clone())];
    to.extend(shares.iter().filter(|(_, c)| *c > 0).map(|(u, _)| (*u, params.clone())));
    notifications::create(&state, house.group_id, "EXPENSE_NEW", Some(actor), to).await;

    Ok((StatusCode::CREATED, Json(json!({ "expense": expense }))).into_response())
}

/// The expense in the detail shape, read inside the write's transaction.
pub(crate) async fn find_in(db: &impl GenericClient, group_id: i32, id: i32) -> Result<Value, tokio_postgres::Error> {
    let public_id: String = db.query_one(r#"SELECT "publicId"::text FROM "Expense" WHERE "id" = $1"#, &[&id]).await?.get(0);
    super::expenses::find_with(db, group_id, &public_id).await.map(|e| e.expect("just written"))
}

fn invalid_id() -> ApiError {
    ApiError::plain(StatusCode::BAD_REQUEST, "Invalid ID")
}

fn not_found() -> ApiError {
    ApiError::plain(StatusCode::NOT_FOUND, "Expense not found")
}

pub async fn update(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>, body: Bytes) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to update expense", e);
    if !input::is_uuid(&public_id) {
        return Err(invalid_id());
    }
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let existing = find(&db, house.group_id, &public_id).await.map_err(|e| fail(&e))?.ok_or_else(not_found)?;
    let body = json_body(&body)?;
    stale_group(house.group_id, &body)?;
    let v = expense_input::validate(&body)?;
    let expected_updated_at = body["expectedUpdatedAt"].as_str().map(str::to_string);

    // An ex-member already on THIS expense stays (grandfathered); only newly introduced people must be active.
    let id = existing["id"].as_i64().unwrap_or_default() as i32;
    let mut existing_involved = vec![existing["payerId"].as_i64().unwrap_or_default() as i32];
    existing_involved.extend(existing["participants"].as_array().into_iter().flatten().map(|p| p["userId"].as_i64().unwrap_or_default() as i32));
    let mut involved = vec![user_id(&v.payer_id, &fail)?];
    for (pid, _) in &v.participants {
        involved.push(user_id(pid, &fail)?);
    }
    let newly: Vec<i32> = involved.iter().copied().filter(|u| !existing_involved.contains(u)).collect();
    if !all_active(&db, house.group_id, &newly).await.map_err(|e| fail(&e))? {
        return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Payer or participant is not a member of this house"));
    }
    check_tags(&db, house.group_id, &v).await.map_err(|e| fail(&e))??;
    let member_ids: Vec<i32> = members(&db, house.group_id).await.map_err(|e| fail(&e))?
        .into_iter().filter(|(u, active)| *active || existing_involved.contains(u)).map(|m| m.0).collect();
    let shares = shares(&v, &member_ids, &fail)?;

    let actor = house.session.user_id as i32;
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let row = tx
        .query_opt(r#"SELECT "payerId", to_char("updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM "Expense" WHERE "id" = $1 AND "groupId" = $2 FOR UPDATE"#, &[&id, &house.group_id])
        .await
        .map_err(|e| fail(&e))?
        .ok_or_else(|| ApiError::plain(StatusCode::NOT_FOUND, "Expense not found in this house"))?;
    if !house.is_admin && row.get::<_, i32>(0) != actor {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "You can only edit expenses you paid (or be a house admin)", "NOT_EXPENSE_OWNER"));
    }
    if expected_updated_at.as_deref().is_some_and(|e| !e.is_empty() && e != row.get::<_, String>(1)) {
        return Err(ApiError::new(StatusCode::CONFLICT, "This expense was changed by someone else. Reload to see the latest version.", "STALE_EXPENSE"));
    }
    let removed = tx.execute(r#"DELETE FROM "ExpenseParticipant" WHERE "expenseId" = $1"#, &[&id]).await.map_err(|e| fail(&e))?;
    // deleteMany is a bulk write for the audit extension: one marker with its targeting clause. Its house comes
    // only from the audit context, which the Next app loses inside the extension, so it is stored as null there;
    // kept null here too so both servers write the same trail.
    let marker = Revision {
        entity_type: "ExpenseParticipant", entity_id: format!("bulk:{removed}"), group_id: None, action: Action::Update,
        actor_id: Some(actor), row: json!({ "where": { "expenseId": id }, "data": null }), fields_set: &[],
    };
    audit::bulk(&tx, marker, "DELETE").await.map_err(|e| fail(&e))?;
    tx.execute(
        r#"UPDATE "Expense" SET "payerId" = $2, "platforms" = $3, "paymentMethods" = $4, "description" = $5,
               "notes" = CASE WHEN $6 THEN $7 ELSE "notes" END, "categories" = $8, "amount" = $9::text::numeric,
               "date" = COALESCE($10, "date"), "updatedAt" = now() AT TIME ZONE 'UTC'
           WHERE "id" = $1"#,
        &[&id, &involved[0], &v.platforms, &v.payment_methods, &js_trim(&v.description), &v.notes_present, &notes(&v),
          &v.categories, &money::number(v.cents), &v.date],
    )
    .await
    .map_err(|e| fail(&e))?;
    insert_participants(&tx, id, &shares).await.map_err(|e| fail(&e))?;
    let expense = find_in(&tx, house.group_id, id).await.map_err(|e| fail(&e))?;
    let revision = Revision { entity_type: "Expense", entity_id: id.to_string(), group_id: Some(house.group_id), action: Action::Update, actor_id: Some(actor), row: expense.clone(), fields_set: &[] };
    audit::record(&tx, revision).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;

    // Field-level diff for Activity: only what changed (description as sent, amount as a JS number string).
    let mut changes = serde_json::Map::new();
    let old_description = existing["description"].as_str().unwrap_or_default();
    if old_description != v.description {
        changes.insert("description".into(), json!({ "from": old_description, "to": v.description }));
    }
    let old_cents = money::parse_cents(existing["amount"].as_str().unwrap_or("0"));
    if old_cents != v.cents {
        changes.insert("amount".into(), json!({ "from": money::number(old_cents), "to": money::number(v.cents) }));
    }
    audit::activity(&db, Activity {
        group_id: house.group_id, actor_id: Some(actor), entity_type: "EXPENSE", entity_id: expense["publicId"].as_str().map(str::to_string),
        action: "UPDATE", summary: expense["description"].as_str().unwrap_or_default().to_string(),
        changes: (!changes.is_empty()).then_some(Value::Object(changes)),
    })
    .await;
    Ok(Json(json!({ "expense": expense })))
}

pub async fn delete(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to delete expense", e);
    if !input::is_uuid(&public_id) {
        return Err(invalid_id());
    }
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let existing = find(&db, house.group_id, &public_id).await.map_err(|e| fail(&e))?.ok_or_else(not_found)?;
    let id = existing["id"].as_i64().unwrap_or_default() as i32;
    let actor = house.session.user_id as i32;
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    if !house.is_admin && existing["payerId"].as_i64() != Some(actor as i64) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "You can only delete expenses you paid (or be a house admin)", "NOT_EXPENSE_OWNER"));
    }
    // Prisma's delete returns every scalar column (no include, no omit), legacy ones too.
    let row: Value = tx
        .query_one(
            r#"DELETE FROM "Expense" WHERE "id" = $1 RETURNING json_build_object(
                 'id', "id", 'publicId', "publicId", 'groupId', "groupId", 'payerId', "payerId", 'platformId', "platformId",
                 'platformIds', "platformIds", 'description', "description", 'notes', "notes", 'category', "category",
                 'categories', "categories", 'platforms', "platforms", 'paymentMethods', "paymentMethods",
                 'amount', "amount"::text, 'date', to_char("date", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'createdAt', to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'updatedAt', to_char("updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'recurringExpenseId', "recurringExpenseId")"#,
            &[&id],
        )
        .await
        .map_err(|e| fail(&e))?
        .get(0);
    let mut row = row;
    row["amount"] = json!(money::number(money::parse_cents(row["amount"].as_str().unwrap_or("0"))));
    let revision = Revision { entity_type: "Expense", entity_id: id.to_string(), group_id: Some(house.group_id), action: Action::Delete, actor_id: Some(actor), row, fields_set: &[] };
    audit::record(&tx, revision).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    audit::activity(&db, Activity {
        group_id: house.group_id, actor_id: Some(actor), entity_type: "EXPENSE", entity_id: Some(public_id),
        action: "DELETE", summary: existing["description"].as_str().unwrap_or_default().to_string(),
        changes: Some(json!({ "amount": existing["amount"] })),
    })
    .await;
    Ok(Json(json!({ "message": "Expense deleted successfully" })))
}
