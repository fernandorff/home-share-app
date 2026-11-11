//! /api/settlements and /api/settlements/{id}: same answers and rows as the Next routes
//! (src/app/api/settlements/**, settlement.service.ts, validateSettlementInput).

use crate::{
    audit::{self, Action, Activity, Revision},
    db::Cached,
    errors::ApiError,
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
use serde_json::{json, Value};
use deadpool_postgres::GenericClient;

/// One payment as settlementService returns it: the row plus fromUser/toUser { id, name }.
pub struct Settlement {
    pub id: i32,
    pub public_id: String,
    pub group_id: i32,
    pub from: (i32, String),
    pub to: (i32, String),
    pub cents: i64,
    pub note: Option<String>,
    pub date: String,
    pub created_by: Option<i32>,
    pub created_at: String,
    pub updated_at: String,
}

impl Settlement {
    /// The bare row (what Prisma's delete returns, without the include).
    pub fn row(&self) -> Value {
        json!({
            "id": self.id, "publicId": self.public_id, "groupId": self.group_id,
            "fromUserId": self.from.0, "toUserId": self.to.0, "amount": money::number(self.cents),
            "note": self.note, "date": self.date, "createdById": self.created_by,
            "createdAt": self.created_at, "updatedAt": self.updated_at,
        })
    }

    pub fn json(&self) -> Value {
        let mut v = self.row();
        v["fromUser"] = json!({ "id": self.from.0, "name": self.from.1 });
        v["toUser"] = json!({ "id": self.to.0, "name": self.to.1 });
        v
    }
}

const SELECT: &str = r#"SELECT s."id", s."publicId"::text, s."groupId", s."fromUserId", s."toUserId", s."amount"::text, s."note",
       to_char(s."date", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), s."createdById",
       to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(s."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       f."name", t."name"
  FROM "Settlement" s JOIN "User" f ON f."id" = s."fromUserId" JOIN "User" t ON t."id" = s."toUserId""#;

fn from_row(r: &tokio_postgres::Row) -> Settlement {
    Settlement {
        id: r.get(0),
        public_id: r.get(1),
        group_id: r.get(2),
        from: (r.get(3), r.get(11)),
        to: (r.get(4), r.get(12)),
        cents: money::parse_cents(r.get(5)),
        note: r.get(6),
        date: r.get(7),
        created_by: r.get(8),
        created_at: r.get(9),
        updated_at: r.get(10),
    }
}

/// settlementService.list: newest first.
pub async fn list(db: &deadpool_postgres::Client, group_id: i32) -> Result<Vec<Settlement>, tokio_postgres::Error> {
    let sql = format!(r#"{SELECT} WHERE s."groupId" = $1 ORDER BY s."date" DESC, s."id" DESC"#);
    Ok(db.cq(&sql, &[&group_id]).await?.iter().map(from_row).collect())
}

async fn by_id(db: &impl GenericClient, id: i32) -> Result<Settlement, tokio_postgres::Error> {
    Ok(from_row(&db.query_one(&format!(r#"{SELECT} WHERE s."id" = $1"#), &[&id]).await?))
}

pub async fn get(State(state): State<AppState>, house: ActiveHouse) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to list settlements", e);
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let settlements: Vec<Value> = list(&db, house.group_id).await.map_err(|e| fail(&e))?.iter().map(Settlement::json).collect();
    Ok(Json(json!({ "settlements": settlements })))
}

fn bad(message: &'static str, code: &'static str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, message, code)
}

pub async fn post(State(state): State<AppState>, house: ActiveHouse, body: Bytes) -> Result<Response, ApiError> {
    const FAILED: &str = "Failed to record settlement";
    let fail = |e: &dyn std::fmt::Display| ApiError::internal(FAILED, e);
    let body: Value = serde_json::from_slice(&body).map_err(|e| fail(&e))?;

    // validateSettlementInput, in its order.
    let (Some(from), Some(to)) = (input::integer(&body["fromUserId"]), input::integer(&body["toUserId"])) else {
        return Err(bad("Payer and recipient are required", "SETTLEMENT_USERS_REQUIRED"));
    };
    if from == to {
        return Err(bad("The payment must be between two different people", "SETTLEMENT_SAME_USER"));
    }
    let Some(amount) = body["amount"].as_f64().filter(|a| a.is_finite() && *a > 0.0) else {
        return Err(bad("Amount must be greater than zero", "AMOUNT_INVALID"));
    };
    if !input::is_cents(amount) {
        return Err(bad("Amount must have at most 2 decimal places", "AMOUNT_PRECISION"));
    }
    let cents = input::to_cents(amount);
    if cents > 9_999_999_999 {
        return Err(bad("Amount too high (max 99,999,999.99)", "AMOUNT_TOO_HIGH"));
    }
    let note = match &body["note"] {
        Value::String(s) if s.encode_utf16().count() > 500 => return Err(bad("Note too long (max 500 characters)", "NOTE_TOO_LONG")),
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Null | Value::String(_) => None,
        // A truthy non-string note passes the length check and then fails in the database, like Prisma.
        other if input::truthy(other) => return Err(fail(&"note is not a string")),
        _ => None,
    };
    let date = match input::date(&body["date"]) {
        input::Date::Missing => None,
        input::Date::Invalid => return Err(bad("Invalid date", "DATE_INVALID")),
        input::Date::At(at) => Some(at),
    };

    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    // allGroupMembers: ever a member (ex-members too, so their locked balance can be settled).
    // An id beyond int4 makes Prisma's query fail (500), not a 400.
    let in_range = |n: f64| (i32::MIN as f64..=i32::MAX as f64).contains(&n).then_some(n as i32);
    let (Some(from), Some(to)) = (in_range(from), in_range(to)) else { return Err(fail(&"user id out of range")) };
    let ids = vec![from, to];
    let members: i64 = db
        .cq(r#"SELECT count(*) FROM "GroupMember" WHERE "groupId" = $1 AND "userId" = ANY($2)"#, &[&house.group_id, &ids])
        .await
        .map_err(|e| fail(&e))?[0]
        .get(0);
    if members != 2 {
        return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Payer or recipient is not a member of this house"));
    }

    let actor = house.session.user_id as i32;
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let id: i32 = tx
        .query_one(
            r#"INSERT INTO "Settlement" ("publicId", "groupId", "fromUserId", "toUserId", "amount", "note", "date", "createdById", "updatedAt")
               VALUES ($1::text::uuid, $2, $3, $4, $5::text::numeric, $6, COALESCE($7, now() AT TIME ZONE 'UTC'), $8, now() AT TIME ZONE 'UTC')
               RETURNING "id""#,
            &[&uuid::Uuid::now_v7().to_string(), &house.group_id, &ids[0], &ids[1], &money::number(cents), &note, &date, &actor],
        )
        .await
        .map_err(|e| fail(&e))?
        .get(0);
    let settlement = by_id(&tx, id).await.map_err(|e| fail(&e))?;
    let revision = Revision {
        entity_type: "Settlement",
        entity_id: id.to_string(),
        group_id: Some(house.group_id),
        action: Action::Create,
        actor_id: Some(actor),
        row: settlement.json(),
        fields_set: &[],
    };
    audit::record(&tx, revision).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;

    // summary is a name snapshot; from/to ids let the Activity feed re-resolve current names.
    audit::activity(&db, Activity {
        group_id: house.group_id,
        actor_id: Some(actor),
        entity_type: "SETTLEMENT",
        entity_id: Some(settlement.public_id.clone()),
        action: "CREATE",
        summary: format!("{} → {}", settlement.from.1, settlement.to.1),
        changes: Some(json!({ "amount": money::number(cents), "fromUserId": settlement.from.0, "toUserId": settlement.to.0 })),
    })
    .await;
    // The recorder is the actor (a recipient who recorded it gets no notice); the payer travels in the params.
    let params = json!({ "settlementPublicId": settlement.public_id, "fromUserId": settlement.from.0, "amount": money::fixed2(cents) });
    notifications::create(&state, house.group_id, "PAYMENT_RECEIVED", Some(actor), vec![(settlement.to.0, params)]).await;

    Ok((StatusCode::CREATED, Json(json!({ "settlement": settlement.json() }))).into_response())
}

pub async fn delete(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to delete settlement", e);
    if !input::is_uuid(&public_id) {
        return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Invalid ID"));
    }
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let found = db
        .cq(&format!(r#"{SELECT} WHERE s."publicId" = $1::text::uuid AND s."groupId" = $2"#), &[&public_id, &house.group_id])
        .await
        .map_err(|e| fail(&e))?;
    let Some(settlement) = found.first().map(from_row) else {
        return Err(ApiError::plain(StatusCode::NOT_FOUND, "Payment not found in this house"));
    };
    let actor = house.session.user_id as i32;
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    tx.execute(r#"DELETE FROM "Settlement" WHERE "id" = $1"#, &[&settlement.id]).await.map_err(|e| fail(&e))?;
    let revision = Revision {
        entity_type: "Settlement",
        entity_id: settlement.id.to_string(),
        group_id: Some(house.group_id),
        action: Action::Delete,
        actor_id: Some(actor),
        row: settlement.row(),
        fields_set: &[],
    };
    audit::record(&tx, revision).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    audit::activity(&db, Activity {
        group_id: house.group_id,
        actor_id: Some(actor),
        entity_type: "SETTLEMENT",
        entity_id: Some(public_id),
        action: "DELETE",
        summary: format!("{} → {}", settlement.from.1, settlement.to.1),
        changes: Some(json!({ "amount": money::number(settlement.cents), "fromUserId": settlement.from.0, "toUserId": settlement.to.0 })),
    })
    .await;
    Ok(Json(json!({ "ok": true })))
}
