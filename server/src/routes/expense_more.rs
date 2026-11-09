//! POST /api/expenses/bulk-delete, GET /api/expenses/{id}/history and GET /api/expenses/export: same answers
//! and rows as the Next routes (bulk-delete/route.ts, [expenseId]/history/route.ts, export/route.ts).

use super::expenses::find;
use crate::{
    audit::{self, Action, Revision},
    errors::ApiError,
    house::ActiveHouse,
    input, money, AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub async fn bulk_delete(State(state): State<AppState>, house: ActiveHouse, body: Bytes) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to delete expenses", e);
    let body: Value = serde_json::from_slice(&body).map_err(|e| fail(&e))?;
    let ids = match &body["publicIds"] {
        Value::Array(items) if !items.is_empty() => items,
        _ => return Err(ApiError::plain(StatusCode::BAD_REQUEST, "ID list is required")),
    };
    if ids.len() > 1000 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Maximum of 1000 expenses at a time", "TOO_MANY"));
    }
    let mut public_ids = Vec::with_capacity(ids.len());
    for id in ids {
        match id.as_str().filter(|s| input::is_uuid(s)) {
            Some(s) => public_ids.push(s.to_string()),
            // `${id}` of a non-string: JS String() of the JSON value.
            None => return Err(ApiError::plain(StatusCode::BAD_REQUEST, format!("Invalid ID: {}", js_string(id)))),
        }
    }
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    // Same query as Prisma's findMany (no ORDER BY), so the ids come in the same order.
    let found: Vec<i32> = db
        .query(r#"SELECT "id" FROM "Expense" WHERE "publicId" = ANY($1::text[]::uuid[]) AND "groupId" = $2"#, &[&public_ids, &house.group_id])
        .await
        .map_err(|e| fail(&e))?
        .iter()
        .map(|r| r.get(0))
        .collect();
    if found.is_empty() {
        return Err(ApiError::plain(StatusCode::NOT_FOUND, "No expenses found"));
    }
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let deleted = tx
        .execute(r#"DELETE FROM "Expense" WHERE "id" = ANY($1) AND "groupId" = $2"#, &[&found, &house.group_id])
        .await
        .map_err(|e| fail(&e))?;
    // deleteMany marker; its house comes from the audit context, null in the Next app (see expense_writes.rs).
    let marker = Revision {
        entity_type: "Expense", entity_id: format!("bulk:{deleted}"), group_id: None, action: Action::Delete,
        actor_id: Some(house.session.user_id as i32), row: json!({ "where": { "id": { "in": found }, "groupId": house.group_id }, "data": null }),
        fields_set: &[],
    };
    audit::bulk(&tx, marker, "DELETE").await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    Ok(Json(json!({ "message": format!("{deleted} expense(s) deleted successfully"), "deleted": deleted })))
}

/// JS String(value) for a JSON value (template literal).
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Array(items) => items.iter().map(|i| if i.is_null() { String::new() } else { js_string(i) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

/// revisionService.listForEntity: the entity's trail, oldest first, with the actor's name, secrets redacted.
pub async fn history(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to load expense history", e);
    if !input::is_uuid(&public_id) {
        return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Invalid ID"));
    }
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let expense = find(&db, house.group_id, &public_id).await.map_err(|e| fail(&e))?.ok_or_else(|| ApiError::plain(StatusCode::NOT_FOUND, "Expense not found"))?;
    let rows = db
        .query(
            r#"SELECT r."id", r."entityType", r."entityId", r."action", r."actorId", u."name",
                      to_char(r."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), r."before", r."after"
               FROM "EntityRevision" r LEFT JOIN "User" u ON u."id" = r."actorId"
               WHERE r."groupId" = $1 AND r."entityType" = 'Expense' AND r."entityId" = $2
               ORDER BY r."createdAt", r."id""#,
            &[&house.group_id, &expense["id"].to_string()],
        )
        .await
        .map_err(|e| fail(&e))?;
    let revisions: Vec<Value> = rows
        .iter()
        .map(|r| {
            let snapshot = |v: Option<Value>| v.filter(|v| !v.is_null()).map(audit::sanitize);
            json!({
                "id": r.get::<_, i32>(0), "entityType": r.get::<_, String>(1), "entityId": r.get::<_, String>(2),
                "action": r.get::<_, String>(3), "actorId": r.get::<_, Option<i32>>(4), "actorName": r.get::<_, Option<String>>(5),
                "createdAt": r.get::<_, String>(6), "before": snapshot(r.get(7)), "after": snapshot(r.get(8)),
            })
        })
        .collect();
    Ok(Json(json!({ "revisions": revisions })))
}

/// escapeCSVField: formula-looking cells get a leading apostrophe; commas, quotes and newlines get quoted.
fn csv_field(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let safe = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{value}") } else { value.to_string() };
    if safe.contains([',', '"', '\n']) { format!("\"{}\"", safe.replace('"', "\"\"")) } else { safe }
}

#[derive(Deserialize)]
pub struct ExportParams {
    date: Option<String>,
}

/// sanitizeDefaultDate: the browser's local day, accepted only within one day of the UTC day.
fn local_day(raw: Option<&str>) -> Option<String> {
    let raw = raw.filter(|r| r.len() == 10 && r.as_bytes()[4] == b'-' && r.as_bytes()[7] == b'-' && r.bytes().filter(u8::is_ascii_digit).count() == 8)?;
    let day = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d").ok()?;
    let today = chrono::Utc::now().date_naive();
    ((day - today).num_days().abs() <= 1).then(|| raw.to_string())
}

pub async fn export(State(state): State<AppState>, house: ActiveHouse, Query(params): Query<ExportParams>) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError { code: Some("EXPORT_FAILED"), ..ApiError::internal("Failed to export expenses", e) };
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    // Same ORDER BY as Prisma (date only), so ties come out in the same order.
    let rows = db
        .query(
            r#"SELECT e."id", to_char(e."date", 'DD/MM/YYYY'), e."description", e."notes", e."amount"::text, p."name",
                      e."platforms", e."paymentMethods", e."categories"
               FROM "Expense" e JOIN "User" p ON p."id" = e."payerId" WHERE e."groupId" = $1 ORDER BY e."date" DESC"#,
            &[&house.group_id],
        )
        .await
        .map_err(|e| fail(&e))?;
    let ids: Vec<i32> = rows.iter().map(|r| r.get(0)).collect();
    let names = db
        .query(
            r#"SELECT x."expenseId", u."name" FROM "ExpenseParticipant" x JOIN "User" u ON u."id" = x."userId"
               WHERE x."expenseId" = ANY($1) ORDER BY x."expenseId", x."id""#,
            &[&ids],
        )
        .await
        .map_err(|e| fail(&e))?;
    let mut lines = vec!["Date,Description,Notes,Amount,Paid by,Platforms,Payment,Categories,Participants".to_string()];
    for r in &rows {
        let id: i32 = r.get(0);
        let participants: Vec<String> = names.iter().filter(|n| n.get::<_, i32>(0) == id).map(|n| n.get(1)).collect();
        let list = |col: usize| csv_field(&r.get::<_, Vec<String>>(col).join("; "));
        lines.push(
            [
                r.get::<_, String>(1),
                csv_field(r.get(2)),
                csv_field(r.get::<_, Option<&str>>(3).unwrap_or("")),
                money::fixed2(money::parse_cents(r.get(4))),
                csv_field(r.get(5)),
                list(6),
                list(7),
                list(8),
                csv_field(&participants.join("; ")),
            ]
            .join(","),
        );
    }
    let csv = format!("\u{feff}{}", lines.join("\n"));
    let day = local_day(params.date.as_deref()).unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"home-share-expenses-{day}.csv\"")),
        ],
        csv,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_fields_like_escape_csv_field() {
        assert_eq!(csv_field(""), "");
        assert_eq!(csv_field("Mercado"), "Mercado");
        assert_eq!(csv_field("=HYPERLINK(1)"), "'=HYPERLINK(1)");
        assert_eq!(csv_field("a, b"), "\"a, b\"");
        assert_eq!(csv_field("diz \"oi\""), "\"diz \"\"oi\"\"\"");
        assert_eq!(csv_field("-1,5"), "\"'-1,5\"");
    }

    #[test]
    fn js_string_of_json_values() {
        assert_eq!(js_string(&serde_json::json!(5)), "5");
        assert_eq!(js_string(&serde_json::json!(null)), "null");
        assert_eq!(js_string(&serde_json::json!({ "a": 1 })), "[object Object]");
        assert_eq!(js_string(&serde_json::json!([1, "b"])), "1,b");
    }
}
