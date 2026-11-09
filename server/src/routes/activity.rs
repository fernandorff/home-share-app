//! Activity › Summary (GET /api/activity, the AuditLog feed) and Activity › Detailed (GET /api/revisions, the
//! EntityRevision trail): same answers as src/app/api/activity, src/app/api/revisions, auditService.list and
//! revisionService.listForGroup.

use crate::{audit, errors::ApiError, house::ActiveHouse, AppState};
use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

const SUMMARY_LIMIT: i64 = 100;
const DETAILED_LIMIT: i64 = 100;
const ENTITY_TYPES: [&str; 9] = ["Expense", "Settlement", "ShoppingItem", "Category", "Platform", "PaymentMethod", "GroupMember", "Group", "RecurringExpense"];
const ISO: &str = r#"'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'"#;

pub async fn summary(State(state): State<AppState>, house: ActiveHouse) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to load history", e);
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let rows = db
        .query(
            &format!(
                r#"SELECT a."id", a."groupId", a."actorId", a."entityType", a."entityId", a."action", a."summary", a."changes",
                          to_char(a."createdAt", {ISO}), u."id", u."name"
                   FROM "AuditLog" a LEFT JOIN "User" u ON u."id" = a."actorId"
                   WHERE a."groupId" = $1 ORDER BY a."createdAt" DESC LIMIT $2"#
            ),
            &[&house.group_id, &(SUMMARY_LIMIT + 1)],
        )
        .await
        .map_err(|e| fail(&e))?;
    let has_more = rows.len() as i64 > SUMMARY_LIMIT;
    let entries: Vec<Value> = rows
        .iter()
        .take(SUMMARY_LIMIT as usize)
        .map(|r| {
            let actor = r.get::<_, Option<i32>>(9).map(|id| json!({ "id": id, "name": r.get::<_, String>(10) }));
            json!({
                "id": r.get::<_, i32>(0), "groupId": r.get::<_, i32>(1), "actorId": r.get::<_, Option<i32>>(2), "entityType": r.get::<_, String>(3),
                "entityId": r.get::<_, Option<String>>(4), "action": r.get::<_, String>(5), "summary": r.get::<_, String>(6),
                "changes": r.get::<_, Option<Value>>(7), "createdAt": r.get::<_, String>(8), "actor": actor,
            })
        })
        .collect();
    Ok(Json(json!({ "entries": entries, "hasMore": has_more })))
}

#[derive(Deserialize)]
pub struct DetailedParams {
    #[serde(rename = "entityType")]
    entity_type: Option<String>,
    limit: Option<String>,
}

/// `Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), 299)`.
fn page_size(raw: Option<&str>) -> i64 {
    let t = raw.map(str::trim).unwrap_or("");
    let n: f64 = if t.is_empty() {
        0.0
    } else if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        i64::from_str_radix(hex, 16).map_or(f64::NAN, |v| v as f64)
    } else if t.contains(['i', 'n', 'N']) && !matches!(t, "Infinity" | "+Infinity" | "-Infinity") {
        f64::NAN
    } else {
        t.replace("Infinity", "inf").parse().unwrap_or(f64::NAN)
    };
    let n = n.trunc();
    let n = if n.is_nan() || n == 0.0 { DETAILED_LIMIT as f64 } else { n };
    n.clamp(1.0, 299.0) as i64
}

pub async fn detailed(State(state): State<AppState>, house: ActiveHouse, Query(params): Query<DetailedParams>) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to load detailed history", e);
    let entity_type = params.entity_type.filter(|t| ENTITY_TYPES.contains(&t.as_str()));
    let limit = page_size(params.limit.as_deref());
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let rows = db
        .query(
            &format!(
                r#"SELECT r."id", r."entityType", r."entityId", r."action", r."actorId", u."name", to_char(r."createdAt", {ISO}), r."before", r."after"
                   FROM "EntityRevision" r LEFT JOIN "User" u ON u."id" = r."actorId"
                   WHERE r."groupId" = $1 AND ($2::text IS NULL OR r."entityType" = $2) AND r."entityId" NOT LIKE 'bulk:%'
                   ORDER BY r."createdAt" DESC, r."id" DESC LIMIT $3"#
            ),
            &[&house.group_id, &entity_type, &(limit + 1)],
        )
        .await
        .map_err(|e| fail(&e))?;
    let mut revisions: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<_, i32>(0), "entityType": r.get::<_, String>(1), "entityId": r.get::<_, String>(2), "action": r.get::<_, String>(3),
                "actorId": r.get::<_, Option<i32>>(4), "actorName": r.get::<_, Option<String>>(5), "createdAt": r.get::<_, String>(6),
                "before": r.get::<_, Option<Value>>(7).filter(|v| !v.is_null()), "after": r.get::<_, Option<Value>>(8).filter(|v| !v.is_null()),
            })
        })
        .collect();

    // An UPDATE stores only its after: its before is the previous revision's after (ADR 0009).
    for i in 0..revisions.len() {
        let r = &revisions[i];
        if r["action"] != "UPDATE" || !r["before"].is_null() {
            continue;
        }
        let previous: Option<Value> = db
            .query_opt(
                r#"SELECT "after" FROM "EntityRevision" WHERE "groupId" = $1 AND "entityType" = $2 AND "entityId" = $3 AND "id" < $4 AND "after" IS NOT NULL AND "after" <> 'null'::jsonb
                   ORDER BY "id" DESC LIMIT 1"#,
                &[&house.group_id, &r["entityType"].as_str(), &r["entityId"].as_str(), &(r["id"].as_i64().unwrap_or_default() as i32)],
            )
            .await
            .map_err(|e| fail(&e))?
            .map(|row| row.get(0));
        if let Some(previous) = previous {
            revisions[i]["before"] = previous;
        }
    }
    for r in &mut revisions {
        for key in ["before", "after"] {
            let v = r[key].take();
            r[key] = audit::sanitize(v);
        }
    }
    let has_more = revisions.len() as i64 > limit;
    revisions.truncate(limit as usize);
    Ok(Json(json!({ "revisions": revisions, "hasMore": has_more })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_size_like_js() {
        assert_eq!(page_size(None), 100);
        assert_eq!(page_size(Some("abc")), 100);
        assert_eq!(page_size(Some("5.9")), 5);
        assert_eq!(page_size(Some("-3")), 1);
        assert_eq!(page_size(Some("1e2")), 100);
        assert_eq!(page_size(Some("0x10")), 16);
        assert_eq!(page_size(Some("Infinity")), 299);
        assert_eq!(page_size(Some("1000")), 299);
    }
}
