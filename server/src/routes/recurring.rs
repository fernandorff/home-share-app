//! /api/recurring-expenses/**: same answers and rows as the Next routes, recurringExpenseService and postRuleNow
//! (src/app/api/recurring-expenses/**, src/services/recurring-expense.service.ts, src/lib/recurring-post-now.ts).
//! `post_due` also posts what is due for the scheduled job (task 3.11).

use crate::{
    audit::{self, Action, Activity, Revision},
    errors::ApiError,
    expense_input::js_trim,
    house::ActiveHouse,
    input, money, notifications,
    recurrence::{due_on, eligible_periods, is_period, local_today, period_of, time_zone, upcoming_periods},
    AppState,
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

const RULES_PER_HOUSE: i64 = 50;
const PARTICIPANTS: usize = 50;
const CATCH_UP: usize = 12;
const HISTORY: i64 = 50;
const UPCOMING: usize = 3;
const MAX_INT: f64 = 2_147_483_647.0;
const EDITABLE: [&str; 6] = ["description", "amount", "dayOfMonth", "payerId", "splitMode", "participantIds"];
const ISO: &str = r#"'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'"#;

struct Viewer {
    user_id: i32,
    is_admin: bool,
}

#[derive(Clone)]
struct Rule {
    id: i32,
    public_id: String,
    group_id: i32,
    created_by: Option<i32>,
    payer_id: i32,
    description: String,
    cents: i64,
    day_of_month: i32,
    split_mode: String,
    participant_ids: Vec<i32>,
    timezone: String,
    active_from: String,
    paused_at: Option<String>,
    pause_reason: Option<String>,
    skipped: Vec<String>,
    created_at: String,
    updated_at: String,
}

fn select() -> String {
    format!(
        r#"SELECT "id", "publicId"::text, "groupId", "createdById", "payerId", "description", "amount"::text, "dayOfMonth", "splitMode"::text,
                  "participantIds", "timezone", to_char("activeFrom", 'YYYY-MM-DD'), to_char("pausedAt", {ISO}), "pauseReason"::text,
                  "skippedPeriods", to_char("createdAt", {ISO}), to_char("updatedAt", {ISO})
           FROM "RecurringExpense""#
    )
}

fn from_row(r: &tokio_postgres::Row) -> Rule {
    Rule {
        id: r.get(0), public_id: r.get(1), group_id: r.get(2), created_by: r.get(3), payer_id: r.get(4), description: r.get(5),
        cents: money::parse_cents(r.get(6)), day_of_month: r.get(7), split_mode: r.get(8), participant_ids: r.get(9), timezone: r.get(10),
        active_from: r.get(11), paused_at: r.get(12), pause_reason: r.get(13), skipped: r.get(14), created_at: r.get(15), updated_at: r.get(16),
    }
}

impl Rule {
    /// The row as Prisma returns it (what the audit extension stores).
    fn row(&self) -> Value {
        json!({
            "id": self.id, "publicId": self.public_id, "groupId": self.group_id, "createdById": self.created_by, "payerId": self.payer_id,
            "description": self.description, "amount": money::number(self.cents), "dayOfMonth": self.day_of_month, "splitMode": self.split_mode,
            "participantIds": self.participant_ids, "timezone": self.timezone, "activeFrom": format!("{}T00:00:00.000Z", self.active_from),
            "pausedAt": self.paused_at, "pauseReason": self.pause_reason, "skippedPeriods": self.skipped,
            "createdAt": self.created_at, "updatedAt": self.updated_at,
        })
    }

    fn can_manage(&self, viewer: &Viewer) -> bool {
        viewer.is_admin || self.payer_id == viewer.user_id
    }

    fn dto(&self, viewer: &Viewer, last_closed: Option<&str>) -> Value {
        let paused = self.paused_at.is_some();
        let upcoming: Vec<Value> = upcoming_periods(self.day_of_month, paused, &self.skipped, &local_today(&self.timezone), last_closed, UPCOMING)
            .into_iter()
            .map(|u| json!({ "period": u.period, "dueOn": u.due_on, "skipped": u.skipped }))
            .collect();
        json!({
            "publicId": self.public_id, "description": self.description, "amount": money::fixed2(self.cents), "dayOfMonth": self.day_of_month,
            "payerId": self.payer_id, "splitMode": self.split_mode, "participantIds": self.participant_ids, "timezone": self.timezone,
            "activeFrom": self.active_from, "paused": paused, "pauseReason": self.pause_reason,
            "skippedPeriods": self.skipped.iter().filter(|p| last_closed.is_none_or(|c| p.as_str() > c)).collect::<Vec<_>>(),
            "lastClosedPeriod": last_closed, "upcoming": upcoming, "canManage": self.can_manage(viewer), "updatedAt": self.updated_at,
        })
    }
}

async fn by_id(db: &impl GenericClient, id: i32) -> Result<Option<Rule>, tokio_postgres::Error> {
    Ok(db.query(&format!(r#"{} WHERE "id" = $1"#, select()), &[&id]).await?.first().map(from_row))
}

async fn last_closed(db: &impl GenericClient, rule_id: i32) -> Result<Option<String>, tokio_postgres::Error> {
    Ok(db.query_one(r#"SELECT max("period") FROM "RecurringExpenseOccurrence" WHERE "recurringExpenseId" = $1"#, &[&rule_id]).await?.get(0))
}

/// Active members, oldest first (an equal split's remainder goes to the first).
async fn active_members(db: &impl GenericClient, group_id: i32) -> Result<Vec<i32>, tokio_postgres::Error> {
    Ok(db
        .query(r#"SELECT "userId" FROM "GroupMember" WHERE "groupId" = $1 AND "leftAt" IS NULL ORDER BY "createdAt", "id""#, &[&group_id])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect())
}

fn share_members(rule: &Rule, active: &[i32]) -> Vec<i32> {
    if rule.split_mode == "SELECTED" { rule.participant_ids.clone() } else { active.to_vec() }
}

// ---- input (parseRecurringExpenseInput / parseRecurringExpensePatch) ----

fn invalid(message: &'static str, code: &'static str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, message, code)
}

fn split_invalid() -> ApiError {
    invalid("Choose 1 to 50 different people", "RECURRING_SPLIT_INVALID")
}

fn is_id(v: &Value) -> Option<i32> {
    v.as_f64().filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= MAX_INT).map(|n| n as i32)
}

fn description(v: &Value) -> Result<String, ApiError> {
    let s = v.as_str().filter(|s| !js_trim(s).is_empty()).ok_or_else(|| invalid("Description is required", "DESCRIPTION_REQUIRED"))?;
    if s.encode_utf16().count() > 200 {
        return Err(invalid("Description too long (max 200 characters)", "DESCRIPTION_TOO_LONG"));
    }
    if s.chars().any(|c| matches!(c, '\x00'..='\x08' | '\x0b' | '\x0c' | '\x0e'..='\x1f')) {
        return Err(invalid("Description contains invalid characters", "DESCRIPTION_INVALID"));
    }
    Ok(js_trim(s).to_string())
}

fn amount(v: &Value) -> Result<i64, ApiError> {
    let n = v.as_f64().filter(|n| n.is_finite() && *n > 0.0).ok_or_else(|| invalid("Amount must be greater than zero", "AMOUNT_INVALID"))?;
    if !input::is_cents(n) {
        return Err(invalid("Amount must have at most 2 decimal places", "AMOUNT_PRECISION"));
    }
    let cents = input::to_cents(n);
    if cents > 9_999_999_999 {
        return Err(invalid("Amount too high (max 99,999,999.99)", "AMOUNT_TOO_HIGH"));
    }
    Ok(cents)
}

fn payer(v: &Value) -> Result<i32, ApiError> {
    is_id(v).ok_or_else(|| invalid("Payer is required", "PAYER_REQUIRED"))
}

fn day(v: &Value) -> Result<i32, ApiError> {
    v.as_f64()
        .filter(|n| n.fract() == 0.0 && (1.0..=31.0).contains(n))
        .map(|n| n as i32)
        .ok_or_else(|| invalid("Day of month must be a whole number from 1 to 31", "RECURRING_DAY_INVALID"))
}

fn split_mode(v: &Value) -> Result<String, ApiError> {
    v.as_str().filter(|m| *m == "ALL" || *m == "SELECTED").map(str::to_string).ok_or_else(|| invalid("Split must be ALL or SELECTED", "RECURRING_SPLIT_INVALID"))
}

fn participant_ids(v: &Value) -> Result<Vec<i32>, ApiError> {
    let items = v.as_array().filter(|a| a.len() <= PARTICIPANTS).ok_or_else(split_invalid)?;
    let ids: Vec<i32> = items.iter().map(is_id).collect::<Option<_>>().ok_or_else(split_invalid)?;
    if ids.iter().enumerate().any(|(i, id)| ids[..i].contains(id)) {
        return Err(split_invalid());
    }
    Ok(ids)
}

fn require_participants(mode: &str, ids: &[i32]) -> Result<(), ApiError> {
    if mode == "SELECTED" && ids.is_empty() { Err(split_invalid()) } else { Ok(()) }
}

async fn assert_active(db: &impl GenericClient, group_id: i32, ids: &[i32]) -> Result<Result<(), ApiError>, tokio_postgres::Error> {
    let mut distinct: Vec<i32> = Vec::new();
    for id in ids {
        if !distinct.contains(id) {
            distinct.push(*id);
        }
    }
    if distinct.is_empty() {
        return Ok(Ok(()));
    }
    let count: i64 = db
        .query_one(r#"SELECT count(*) FROM "GroupMember" WHERE "groupId" = $1 AND "userId" = ANY($2) AND "leftAt" IS NULL"#, &[&group_id, &distinct])
        .await?
        .get(0);
    Ok(if count as usize == distinct.len() {
        Ok(())
    } else {
        Err(invalid("The payer and every participant must be active members of this house", "RECURRING_MEMBER_INACTIVE"))
    })
}

fn stale_group(group_id: i32, body: &Value) -> Result<(), ApiError> {
    match body["expectedGroupId"].as_f64() {
        Some(expected) if expected != group_id as f64 => Err(ApiError::new(StatusCode::CONFLICT, "Your active house changed in another tab. Reload to continue.", "STALE_GROUP")),
        _ => Ok(()),
    }
}

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Recurring expense not found in this house", "RECURRING_NOT_FOUND")
}

fn stale() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "This rule was changed by someone else. Reload to see the latest version.", "STALE_RECURRING_EXPENSE")
}

async fn find_in_house(db: &impl GenericClient, group_id: i32, public_id: &str) -> Result<Result<Rule, ApiError>, tokio_postgres::Error> {
    if !input::is_uuid(public_id) {
        return Ok(Err(not_found()));
    }
    let rows = db.query(&format!(r#"{} WHERE "publicId" = $1::text::uuid AND "groupId" = $2"#, select()), &[&public_id, &group_id]).await?;
    Ok(rows.first().map(from_row).ok_or_else(not_found))
}

async fn find_manageable(db: &impl GenericClient, group_id: i32, viewer: &Viewer, public_id: &str) -> Result<Result<Rule, ApiError>, tokio_postgres::Error> {
    Ok(find_in_house(db, group_id, public_id).await?.and_then(|rule| {
        if rule.can_manage(viewer) { Ok(rule) } else { Err(ApiError::new(StatusCode::FORBIDDEN, "Only the payer or a house admin can change this rule", "NOT_RECURRING_OWNER")) }
    }))
}

async fn revise(db: &impl GenericClient, rule: &Rule, action: Action, actor: Option<i32>) -> Result<(), tokio_postgres::Error> {
    audit::record(db, Revision { entity_type: "RecurringExpense", entity_id: rule.id.to_string(), group_id: Some(rule.group_id), action, actor_id: actor, row: rule.row(), fields_set: &[] }).await
}

fn viewer(house: &ActiveHouse) -> Viewer {
    Viewer { user_id: house.session.user_id as i32, is_admin: house.is_admin }
}

async fn activity(state: &AppState, house: &ActiveHouse, rule: &Value, action: &'static str, changes: Option<Value>) {
    let Ok(db) = state.pool.get().await else { return };
    audit::activity(&db, Activity {
        group_id: house.group_id, actor_id: Some(house.session.user_id as i32), entity_type: "RECURRING_EXPENSE",
        entity_id: rule["publicId"].as_str().map(str::to_string), action, summary: rule["description"].as_str().unwrap_or_default().to_string(), changes,
    })
    .await;
}

// ---- routes ----

pub async fn list(State(state): State<AppState>, house: ActiveHouse) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to list recurring expenses", e);
    let viewer = viewer(&house);
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let rules: Vec<Rule> = db.query(&format!(r#"{} WHERE "groupId" = $1 ORDER BY "id""#, select()), &[&house.group_id]).await.map_err(|e| fail(&e))?.iter().map(from_row).collect();
    let active = active_members(&db, house.group_id).await.map_err(|e| fail(&e))?;
    let ids: Vec<i32> = rules.iter().map(|r| r.id).collect();
    let closed = db
        .query(r#"SELECT "recurringExpenseId", max("period") FROM "RecurringExpenseOccurrence" WHERE "recurringExpenseId" = ANY($1) GROUP BY 1"#, &[&ids])
        .await
        .map_err(|e| fail(&e))?;
    let closed_of = |id: i32| closed.iter().find(|r| r.get::<_, i32>(0) == id).map(|r| r.get::<_, String>(1));
    let history = db
        .query(
            r#"SELECT o."period", to_char(o."dueOn", 'YYYY-MM-DD'), o."status"::text, r."publicId"::text, r."description",
                      e."publicId"::text, e."amount"::text, e."payerId", (SELECT count(*) FROM "ExpenseParticipant" p WHERE p."expenseId" = e."id")
               FROM "RecurringExpenseOccurrence" o JOIN "RecurringExpense" r ON r."id" = o."recurringExpenseId"
               LEFT JOIN "Expense" e ON e."id" = o."expenseId"
               WHERE r."groupId" = $1 ORDER BY o."dueOn" DESC, o."id" DESC LIMIT $2"#,
            &[&house.group_id, &HISTORY],
        )
        .await
        .map_err(|e| fail(&e))?;

    let (mut total, mut share, mut paused) = (0i64, 0i64, 0usize);
    for rule in &rules {
        if rule.paused_at.is_some() {
            paused += 1;
            continue;
        }
        total += rule.cents;
        let sharers = share_members(rule, &active);
        if let Some(i) = sharers.iter().position(|u| *u == viewer.user_id) {
            share += money::split_cents(rule.cents, sharers.len() as i64)[i];
        }
    }
    let history: Vec<Value> = history
        .iter()
        .map(|r| {
            let expense = r.get::<_, Option<String>>(5).map(|public_id| {
                json!({ "publicId": public_id, "amount": money::fixed2(money::parse_cents(r.get(6))), "payerId": r.get::<_, i32>(7), "participantCount": r.get::<_, i64>(8) })
            });
            json!({ "period": r.get::<_, String>(0), "dueOn": r.get::<_, String>(1), "status": r.get::<_, String>(2),
                    "rule": { "publicId": r.get::<_, String>(3), "description": r.get::<_, String>(4) }, "expense": expense })
        })
        .collect();
    Ok(Json(json!({
        "rules": rules.iter().map(|r| r.dto(&viewer, closed_of(r.id).as_deref())).collect::<Vec<_>>(),
        "summary": { "monthlyTotal": money::fixed2(total), "myMonthlyShare": money::fixed2(share), "activeCount": rules.len() - paused, "pausedCount": paused },
        "history": history,
    })))
}

pub async fn create(State(state): State<AppState>, house: ActiveHouse, body: Bytes) -> Result<Response, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to create recurring expense", e);
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    stale_group(house.group_id, &body)?;
    let raw = if body.is_object() { body.clone() } else { json!({}) };
    let description = description(&raw["description"])?;
    let cents = amount(&raw["amount"])?;
    let payer_id = payer(&raw["payerId"])?;
    let day_of_month = day(&raw["dayOfMonth"])?;
    let mode = split_mode(&raw["splitMode"])?;
    let participants = if mode == "SELECTED" { participant_ids(&raw["participantIds"])? } else { Vec::new() };
    require_participants(&mode, &participants)?;
    let timezone = raw["timezone"].as_str().and_then(time_zone).ok_or_else(|| invalid("Unknown timezone", "RECURRING_TIMEZONE_INVALID"))?;

    let viewer = viewer(&house);
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let mut involved = vec![payer_id];
    involved.extend(&participants);
    assert_active(&db, house.group_id, &involved).await.map_err(|e| fail(&e))??;
    let count: i64 = db.query_one(r#"SELECT count(*) FROM "RecurringExpense" WHERE "groupId" = $1"#, &[&house.group_id]).await.map_err(|e| fail(&e))?.get(0);
    if count >= RULES_PER_HOUSE {
        return Err(ApiError::new(StatusCode::CONFLICT, "This house already has 50 recurring expenses", "RECURRING_LIMIT_REACHED"));
    }
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let id: i32 = tx
        .query_one(
            r#"INSERT INTO "RecurringExpense" ("publicId", "groupId", "createdById", "payerId", "description", "amount", "dayOfMonth", "splitMode",
                                              "participantIds", "timezone", "activeFrom", "updatedAt")
               VALUES ($1::text::uuid, $2, $3, $4, $5, $6::text::numeric, $7, $8::text::"RecurringSplitMode", $9, $10, $11::text::date, now() AT TIME ZONE 'UTC')
               RETURNING "id""#,
            &[&uuid::Uuid::now_v7().to_string(), &house.group_id, &viewer.user_id, &payer_id, &description, &money::number(cents), &day_of_month,
              &mode, &participants, &timezone, &local_today(&timezone)],
        )
        .await
        .map_err(|e| fail(&e))?
        .get(0);
    let rule = by_id(&tx, id).await.map_err(|e| fail(&e))?.ok_or_else(|| fail(&"rule just written"))?;
    revise(&tx, &rule, Action::Create, Some(viewer.user_id)).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    let dto = rule.dto(&viewer, None);
    activity(&state, &house, &dto, "CREATE", Some(json!({ "amount": dto["amount"] }))).await;
    let (rule, posted) = post_now(&state, &viewer, &rule, dto).await;
    Ok((StatusCode::CREATED, Json(json!({ "rule": rule, "postedNow": posted }))).into_response())
}

const PAUSE_ENVELOPE: [&str; 3] = ["paused", "expectedGroupId", "expectedUpdatedAt"];

pub async fn patch(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>, body: Bytes) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to update recurring expense", e);
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    stale_group(house.group_id, &body)?;
    let viewer = viewer(&house);
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;

    if let Some(paused) = body.get("paused") {
        let only_envelope = body.as_object().is_some_and(|o| o.keys().all(|k| PAUSE_ENVELOPE.contains(&k.as_str())));
        let Some(paused) = paused.as_bool().filter(|_| only_envelope) else {
            return Err(invalid("Send either paused alone or the fields to change", "RECURRING_PATCH_INVALID"));
        };
        let rule = find_manageable(&db, house.group_id, &viewer, &public_id).await.map_err(|e| fail(&e))??;
        let closed = last_closed(&db, rule.id).await.map_err(|e| fail(&e))?;
        if rule.paused_at.is_some() == paused {
            return Ok(Json(json!({ "rule": rule.dto(&viewer, closed.as_deref()), "postedNow": 0 })));
        }
        if !paused {
            let mut involved = vec![rule.payer_id];
            involved.extend(&rule.participant_ids);
            assert_active(&db, house.group_id, &involved).await.map_err(|e| fail(&e))??;
        }
        let today = local_today(&rule.timezone);
        let kept: Vec<String> = rule.skipped.iter().filter(|p| p.as_str() >= period_of(&today)).cloned().collect();
        let prune = !paused && kept.len() != rule.skipped.len();
        let tx = db.transaction().await.map_err(|e| fail(&e))?;
        let updated = if paused {
            tx.execute(
                r#"UPDATE "RecurringExpense" SET "pausedAt" = date_trunc('milliseconds', now() AT TIME ZONE 'UTC'), "pauseReason" = 'MANUAL', "updatedAt" = now() AT TIME ZONE 'UTC' WHERE "id" = $1"#,
                &[&rule.id],
            )
            .await
        } else {
            tx.execute(
                r#"UPDATE "RecurringExpense" SET "pausedAt" = NULL, "pauseReason" = NULL, "activeFrom" = $2::text::date,
                       "skippedPeriods" = CASE WHEN $3 THEN $4 ELSE "skippedPeriods" END, "updatedAt" = now() AT TIME ZONE 'UTC'
                   WHERE "id" = $1 AND (NOT $3 OR "updatedAt" = $5::text::timestamp)"#,
                &[&rule.id, &today, &prune, &kept, &rule.updated_at.trim_end_matches('Z')],
            )
            .await
        }
        .map_err(|e| fail(&e))?;
        if updated == 0 {
            return Err(stale());
        }
        let rule = by_id(&tx, rule.id).await.map_err(|e| fail(&e))?.ok_or_else(stale)?;
        revise(&tx, &rule, Action::Update, Some(viewer.user_id)).await.map_err(|e| fail(&e))?;
        tx.commit().await.map_err(|e| fail(&e))?;
        let dto = rule.dto(&viewer, closed.as_deref());
        activity(&state, &house, &dto, if paused { "PAUSE" } else { "RESUME" }, None).await;
        if paused {
            return Ok(Json(json!({ "rule": dto, "postedNow": 0 })));
        }
        let (dto, posted) = post_now(&state, &viewer, &rule, dto).await;
        return Ok(Json(json!({ "rule": dto, "postedNow": posted })));
    }

    // parseRecurringExpensePatch
    let present = |k: &str| body.as_object().is_some_and(|o| o.contains_key(k));
    if !body.is_object() || !EDITABLE.iter().any(|k| present(k)) {
        return Err(invalid("Nothing to change", "RECURRING_PATCH_INVALID"));
    }
    let p_description = if present("description") { Some(description(&body["description"])?) } else { None };
    let p_amount = if present("amount") { Some(amount(&body["amount"])?) } else { None };
    let p_payer = if present("payerId") { Some(payer(&body["payerId"])?) } else { None };
    let p_day = if present("dayOfMonth") { Some(day(&body["dayOfMonth"])?) } else { None };
    let p_mode = if present("splitMode") { Some(split_mode(&body["splitMode"])?) } else { None };
    let p_participants = if present("participantIds") { Some(participant_ids(&body["participantIds"])?) } else { None };

    let rule = find_manageable(&db, house.group_id, &viewer, &public_id).await.map_err(|e| fail(&e))??;
    let Some(expected) = body["expectedUpdatedAt"].as_str().filter(|e| !e.is_empty()) else {
        return Err(invalid("expectedUpdatedAt is required to edit a rule", "RECURRING_PATCH_INVALID"));
    };
    let mode = p_mode.unwrap_or_else(|| rule.split_mode.clone());
    let participants = if mode == "ALL" { Vec::new() } else { p_participants.unwrap_or_else(|| rule.participant_ids.clone()) };
    require_participants(&mode, &participants)?;
    let next = json!({
        "description": p_description.unwrap_or_else(|| rule.description.clone()),
        "amount": money::fixed2(p_amount.unwrap_or(rule.cents)),
        "dayOfMonth": p_day.unwrap_or(rule.day_of_month),
        "payerId": p_payer.unwrap_or(rule.payer_id),
        "splitMode": mode,
        "participantIds": participants,
    });
    let next_payer = next["payerId"].as_i64().unwrap_or_default() as i32;
    let mut involved: Vec<i32> = if next_payer != rule.payer_id { vec![next_payer] } else { Vec::new() };
    involved.extend(participants.iter().filter(|id| !rule.participant_ids.contains(id)));
    assert_active(&db, house.group_id, &involved).await.map_err(|e| fail(&e))??;
    if rule.updated_at != expected {
        return Err(stale());
    }
    let current = json!({
        "description": rule.description, "amount": money::fixed2(rule.cents), "dayOfMonth": rule.day_of_month,
        "payerId": rule.payer_id, "splitMode": rule.split_mode, "participantIds": rule.participant_ids,
    });
    let mut changes = serde_json::Map::new();
    for field in EDITABLE {
        if current[field] != next[field] {
            changes.insert(field.to_string(), json!({ "from": current[field], "to": next[field] }));
        }
    }
    let closed = last_closed(&db, rule.id).await.map_err(|e| fail(&e))?;
    if changes.is_empty() {
        return Ok(Json(json!({ "rule": rule.dto(&viewer, closed.as_deref()), "postedNow": 0 })));
    }
    let next_cents = money::parse_cents(next["amount"].as_str().unwrap_or("0"));
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let updated = tx
        .execute(
            r#"UPDATE "RecurringExpense" SET "description" = $2, "amount" = $3::text::numeric, "dayOfMonth" = $4, "payerId" = $5,
                   "splitMode" = $6::text::"RecurringSplitMode", "participantIds" = $7, "updatedAt" = now() AT TIME ZONE 'UTC'
               WHERE "id" = $1 AND "updatedAt" = $8::text::timestamp"#,
            &[&rule.id, &next["description"].as_str().unwrap_or_default(), &money::number(next_cents), &(next["dayOfMonth"].as_i64().unwrap_or(1) as i32),
              &next_payer, &next["splitMode"].as_str().unwrap_or("ALL"), &participants, &rule.updated_at.trim_end_matches('Z')],
        )
        .await
        .map_err(|e| fail(&e))?;
    if updated == 0 {
        return Err(stale());
    }
    let rule = by_id(&tx, rule.id).await.map_err(|e| fail(&e))?.ok_or_else(stale)?;
    revise(&tx, &rule, Action::Update, Some(viewer.user_id)).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    let dto = rule.dto(&viewer, closed.as_deref());
    activity(&state, &house, &dto, "UPDATE", Some(Value::Object(changes))).await;
    let (dto, posted) = post_now(&state, &viewer, &rule, dto).await;
    Ok(Json(json!({ "rule": dto, "postedNow": posted })))
}

pub async fn delete(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to delete recurring expense", e);
    let viewer = viewer(&house);
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    let rule = find_manageable(&db, house.group_id, &viewer, &public_id).await.map_err(|e| fail(&e))??;
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    tx.execute(r#"DELETE FROM "RecurringExpense" WHERE "id" = $1"#, &[&rule.id]).await.map_err(|e| fail(&e))?;
    revise(&tx, &rule, Action::Delete, Some(viewer.user_id)).await.map_err(|e| fail(&e))?;
    tx.commit().await.map_err(|e| fail(&e))?;
    let summary = json!({ "publicId": rule.public_id, "description": rule.description });
    activity(&state, &house, &summary, "DELETE", Some(json!({ "amount": money::fixed2(rule.cents) }))).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn skip(state: State<AppState>, house: ActiveHouse, path: Path<(String, String)>) -> Result<Json<Value>, ApiError> {
    set_skipped(state, house, path, true).await
}

pub async fn unskip(state: State<AppState>, house: ActiveHouse, path: Path<(String, String)>) -> Result<Json<Value>, ApiError> {
    set_skipped(state, house, path, false).await
}

async fn set_skipped(State(state): State<AppState>, house: ActiveHouse, Path((public_id, period)): Path<(String, String)>, skip: bool) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal(if skip { "Failed to skip month" } else { "Failed to undo skip" }, e);
    if !is_period(&period) {
        return Err(invalid("Invalid month", "RECURRING_PERIOD_INVALID"));
    }
    let viewer = viewer(&house);
    // A concurrent change between the read and the write is retried once, then reported as stale.
    for attempt in 0..2 {
        let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
        let rule = find_manageable(&db, house.group_id, &viewer, &public_id).await.map_err(|e| fail(&e))??;
        let closed_now = db
            .query(r#"SELECT 1 FROM "RecurringExpenseOccurrence" WHERE "recurringExpenseId" = $1 AND "period" = $2"#, &[&rule.id, &period])
            .await
            .map_err(|e| fail(&e))?;
        if !closed_now.is_empty() {
            return Err(ApiError::new(StatusCode::CONFLICT, "This month was already posted or skipped", "RECURRING_PERIOD_CLOSED"));
        }
        let closed = last_closed(&db, rule.id).await.map_err(|e| fail(&e))?;
        let upcoming = upcoming_periods(rule.day_of_month, false, &rule.skipped, &local_today(&rule.timezone), closed.as_deref(), UPCOMING);
        if !upcoming.iter().any(|u| u.period == period) {
            return Err(invalid("Only the next 3 months can be skipped", "RECURRING_PERIOD_INVALID"));
        }
        if rule.skipped.contains(&period) == skip {
            return Ok(Json(json!({ "rule": rule.dto(&viewer, closed.as_deref()) })));
        }
        let mut skipped: Vec<String> = if skip { rule.skipped.iter().cloned().chain([period.clone()]).collect() } else { rule.skipped.iter().filter(|p| **p != period).cloned().collect() };
        skipped.sort();
        let tx = db.transaction().await.map_err(|e| fail(&e))?;
        let updated = tx
            .execute(
                r#"UPDATE "RecurringExpense" SET "skippedPeriods" = $2, "updatedAt" = now() AT TIME ZONE 'UTC' WHERE "id" = $1 AND "updatedAt" = $3::text::timestamp"#,
                &[&rule.id, &skipped, &rule.updated_at.trim_end_matches('Z')],
            )
            .await
            .map_err(|e| fail(&e))?;
        if updated == 0 {
            if attempt == 0 {
                continue;
            }
            return Err(stale());
        }
        let rule = by_id(&tx, rule.id).await.map_err(|e| fail(&e))?.ok_or_else(stale)?;
        revise(&tx, &rule, Action::Update, Some(viewer.user_id)).await.map_err(|e| fail(&e))?;
        tx.commit().await.map_err(|e| fail(&e))?;
        let dto = rule.dto(&viewer, closed.as_deref());
        activity(&state, &house, &dto, if skip { "SKIP" } else { "UNSKIP" }, Some(json!({ "period": period }))).await;
        return Ok(Json(json!({ "rule": dto })));
    }
    Err(stale())
}

// ---- posting (postDue / postRuleNow) ----

#[derive(Default)]
pub struct PostResult {
    pub posted: usize,
    pub skipped: usize,
    pub paused: usize,
    pub duplicates: usize,
    pub failed: usize,
    /// Rules or periods not started because the deadline passed (the next run picks them up).
    pub remaining: usize,
}

/// postRuleNow: post what this rule has due right away; on any failure the saved rule is answered as is.
async fn post_now(state: &AppState, viewer: &Viewer, rule: &Rule, saved: Value) -> (Value, usize) {
    let run = post_due(state, Some(rule.id), None).await;
    if run.posted + run.skipped + run.paused + run.duplicates == 0 {
        return (saved, run.posted);
    }
    let fresh = async {
        let db = state.pool.get().await.ok()?;
        let rule = by_id(&db, rule.id).await.ok()??;
        let closed = last_closed(&db, rule.id).await.ok()?;
        Some(rule.dto(viewer, closed.as_deref()))
    };
    (fresh.await.unwrap_or(saved), run.posted)
}

/// postDue: every unpaused rule (or one), oldest due first; each period claimed once in the ledger. The posted expense is
/// always the system's write (actorId null), also when a member's request triggers it.
pub async fn post_due(state: &AppState, only: Option<i32>, deadline: Option<std::time::Instant>) -> PostResult {
    let mut result = PostResult::default();
    let rules: Vec<Rule> = match state.pool.get().await {
        Ok(db) => match db.query(&format!(r#"{} WHERE "pausedAt" IS NULL AND ($1::int IS NULL OR "id" = $1) ORDER BY "id""#, select()), &[&only]).await {
            Ok(rows) => rows.iter().map(from_row).collect(),
            Err(e) => {
                eprintln!("recurring expense posting failed: {e}");
                result.failed += 1;
                return result;
            }
        },
        Err(e) => {
            eprintln!("recurring expense posting failed: {e}");
            result.failed += 1;
            return result;
        }
    };
    let mut due: Vec<(Rule, Vec<String>, String)> = Vec::new();
    for rule in rules {
        let closed = match state.pool.get().await {
            Ok(db) => last_closed(&db, rule.id).await.ok().flatten(),
            Err(_) => None,
        };
        let periods = eligible_periods(rule.day_of_month, &rule.active_from, &local_today(&rule.timezone), closed.as_deref(), CATCH_UP);
        if let Some(first) = periods.first() {
            let first_due = due_on(first, rule.day_of_month);
            due.push((rule, periods, first_due));
        }
    }
    due.sort_by(|a, b| a.2.cmp(&b.2).then(a.0.id.cmp(&b.0.id)));
    let total = due.len();
    for (index, (rule, periods, _)) in due.into_iter().enumerate() {
        if deadline.is_some_and(|d| std::time::Instant::now() >= d) {
            result.remaining = total - index;
            break;
        }
        if let Err(e) = post_rule(state, &rule, &periods, deadline, &mut result).await {
            result.failed += 1;
            eprintln!("recurring expense posting failed (rule {}): {e}", rule.id);
        }
    }
    result
}

enum Claim {
    Done,
    Duplicate,
    Aborted,
}

async fn post_rule(state: &AppState, rule: &Rule, periods: &[String], deadline: Option<std::time::Instant>, result: &mut PostResult) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut active: Option<Vec<i32>> = None;
    for (index, period) in periods.iter().enumerate() {
        if index > 0 && deadline.is_some_and(|d| std::time::Instant::now() >= d) {
            result.remaining += 1;
            return Ok(());
        }
        let due = due_on(period, rule.day_of_month);
        if rule.skipped.contains(period) {
            match claim_skip(state, rule, period, &due).await? {
                Claim::Aborted => return Ok(()),
                Claim::Duplicate => result.duplicates += 1,
                Claim::Done => result.skipped += 1,
            }
            continue;
        }
        if active.is_none() {
            active = Some(active_members(&state.pool.get().await?, rule.group_id).await?);
        }
        let active_ids = active.as_deref().unwrap_or_default();
        let still = active_ids.contains(&rule.payer_id) && (rule.split_mode == "ALL" || rule.participant_ids.iter().all(|id| active_ids.contains(id)));
        if !still {
            if pause_member_left(state, rule).await? {
                result.paused += 1;
            }
            return Ok(());
        }
        match post_period(state, rule, period, &due, &share_members(rule, active_ids)).await? {
            Claim::Aborted => return Ok(()),
            Claim::Duplicate => result.duplicates += 1,
            Claim::Done => result.posted += 1,
        }
    }
    Ok(())
}

/// claimPeriod: the ledger row is the claim (unique per rule and period); the rule must not have changed since it was read.
async fn claim(tx: &deadpool_postgres::Transaction<'_>, rule: &Rule, period: &str, due: &str, status: &str) -> Result<Option<i32>, tokio_postgres::Error> {
    let claimed = tx
        .query_opt(
            r#"INSERT INTO "RecurringExpenseOccurrence" ("recurringExpenseId", "period", "dueOn", "status") VALUES ($1, $2, $3::text::date, $4::text::"RecurringOccurrenceStatus")
               ON CONFLICT ("recurringExpenseId", "period") DO NOTHING RETURNING "id""#,
            &[&rule.id, &period, &due, &status],
        )
        .await?;
    Ok(claimed.map(|r| r.get(0)))
}

async fn unchanged(tx: &deadpool_postgres::Transaction<'_>, rule: &Rule, skipped_period: Option<&str>) -> Result<bool, tokio_postgres::Error> {
    let now = tx.query_opt(&format!(r#"{} WHERE "id" = $1"#, select()), &[&rule.id]).await?.map(|r| from_row(&r));
    Ok(now.is_some_and(|n| n.updated_at == rule.updated_at && skipped_period.is_none_or(|p| n.skipped.iter().any(|s| s == p))))
}

async fn claim_skip(state: &AppState, rule: &Rule, period: &str, due: &str) -> Result<Claim, Box<dyn std::error::Error + Send + Sync>> {
    let mut db = state.pool.get().await?;
    let tx = db.transaction().await?;
    if claim(&tx, rule, period, due, "SKIPPED").await?.is_none() {
        return Ok(Claim::Duplicate);
    }
    if !unchanged(&tx, rule, Some(period)).await? {
        return Ok(Claim::Aborted); // rolled back on drop
    }
    tx.commit().await?;
    Ok(Claim::Done)
}

async fn post_period(state: &AppState, rule: &Rule, period: &str, due: &str, members: &[i32]) -> Result<Claim, Box<dyn std::error::Error + Send + Sync>> {
    let mut db = state.pool.get().await?;
    let tx = db.transaction().await?;
    let Some(occurrence) = claim(&tx, rule, period, due, "POSTED").await? else { return Ok(Claim::Duplicate) };
    if !unchanged(&tx, rule, None).await? {
        return Ok(Claim::Aborted);
    }
    let shares: Vec<(i32, i64)> = members.iter().copied().zip(money::split_cents(rule.cents, members.len() as i64)).collect();
    let id: i32 = tx
        .query_one(
            r#"INSERT INTO "Expense" ("publicId", "groupId", "payerId", "platforms", "paymentMethods", "description", "notes", "categories", "amount", "date", "recurringExpenseId", "updatedAt")
               VALUES ($1::text::uuid, $2, $3, '{}', '{}', $4, NULL, '{}', $5::text::numeric, $6::text::timestamp, $7, now() AT TIME ZONE 'UTC') RETURNING "id""#,
            &[&uuid::Uuid::now_v7().to_string(), &rule.group_id, &rule.payer_id, &js_trim(&rule.description), &money::number(rule.cents), &format!("{due}T12:00:00"), &rule.id],
        )
        .await?
        .get(0);
    super::expense_writes::insert_participants(&tx, id, &shares).await?;
    let expense = super::expense_writes::find_in(&tx, rule.group_id, id).await?;
    let revision = Revision { entity_type: "Expense", entity_id: id.to_string(), group_id: Some(rule.group_id), action: Action::Create, actor_id: None, row: expense.clone(), fields_set: &[] };
    audit::record(&tx, revision).await?;
    tx.execute(r#"UPDATE "RecurringExpenseOccurrence" SET "expenseId" = $2 WHERE "id" = $1"#, &[&occurrence, &id]).await?;
    tx.commit().await?;

    let public_id = expense["publicId"].as_str().unwrap_or_default().to_string();
    audit::activity(&db, Activity {
        group_id: rule.group_id, actor_id: None, entity_type: "EXPENSE", entity_id: Some(public_id.clone()), action: "CREATE",
        summary: expense["description"].as_str().unwrap_or_default().to_string(),
        changes: Some(json!({ "amount": money::number(rule.cents), "recurring": true, "period": period })),
    })
    .await;
    let params = json!({ "expensePublicId": public_id, "description": expense["description"], "amount": money::fixed2(rule.cents), "recurring": true });
    let mut to = vec![(rule.payer_id, params.clone())];
    to.extend(shares.iter().filter(|(_, c)| *c > 0).map(|(u, _)| (*u, params.clone())));
    notifications::create(state, rule.group_id, "EXPENSE_NEW", None, to).await;
    Ok(Claim::Done)
}

/// A payer or chosen participant left the house: the rule pauses itself (system), unless it changed meanwhile.
async fn pause_member_left(state: &AppState, rule: &Rule) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let mut db = state.pool.get().await?;
    let tx = db.transaction().await?;
    let updated = tx
        .execute(
            r#"UPDATE "RecurringExpense" SET "pausedAt" = date_trunc('milliseconds', now() AT TIME ZONE 'UTC'), "pauseReason" = 'MEMBER_LEFT', "updatedAt" = now() AT TIME ZONE 'UTC'
               WHERE "id" = $1 AND "updatedAt" = $2::text::timestamp"#,
            &[&rule.id, &rule.updated_at.trim_end_matches('Z')],
        )
        .await?;
    if updated == 0 {
        return Ok(false);
    }
    if let Some(paused) = by_id(&tx, rule.id).await? {
        revise(&tx, &paused, Action::Update, None).await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// sendRecurringDueReminders: RECURRING_DUE to the payer of every unpaused rule whose first unskipped upcoming period is
/// due tomorrow in the rule's timezone, once per rule and period (dedupe key). One failing rule never costs the others.
pub async fn due_reminders(state: &AppState, deadline: std::time::Instant) -> (usize, usize, usize) {
    let (mut created, mut failed, mut remaining) = (0, 0, 0);
    let rules: Vec<Rule> = match state.pool.get().await {
        Ok(db) => match db.query(&format!(r#"{} WHERE "pausedAt" IS NULL ORDER BY "id""#, select()), &[]).await {
            Ok(rows) => rows.iter().map(from_row).collect(),
            Err(e) => {
                eprintln!("recurring due reminders failed: {e}");
                return (0, 1, 0);
            }
        },
        Err(e) => {
            eprintln!("recurring due reminders failed: {e}");
            return (0, 1, 0);
        }
    };
    let mut due: Vec<(Rule, String, String)> = Vec::new();
    for rule in rules {
        let closed = match state.pool.get().await {
            Ok(db) => last_closed(&db, rule.id).await.ok().flatten(),
            Err(_) => None,
        };
        let today = local_today(&rule.timezone);
        let tomorrow = chrono::NaiveDate::parse_from_str(&today, "%Y-%m-%d").ok().and_then(|d| d.succ_opt()).map(|d| d.format("%Y-%m-%d").to_string());
        if let Some(next) = upcoming_periods(rule.day_of_month, false, &rule.skipped, &today, closed.as_deref(), 1).into_iter().next() {
            if !next.skipped && Some(&next.due_on) == tomorrow.as_ref() {
                due.push((rule, next.period, next.due_on));
            }
        }
    }
    let total = due.len();
    for (index, (rule, period, due_on)) in due.into_iter().enumerate() {
        if std::time::Instant::now() >= deadline {
            remaining = total - index;
            break;
        }
        let params = json!({ "recurringExpensePublicId": rule.public_id, "description": rule.description, "amount": money::fixed2(rule.cents), "dueOn": due_on });
        match notifications::create_scheduled(state, rule.group_id, "RECURRING_DUE", vec![(rule.payer_id, params)], &format!("RECURRING_DUE:{}:{period}", rule.id)).await {
            Ok(n) => created += n,
            Err(e) => {
                failed += 1;
                eprintln!("recurring due reminder failed (rule {}): {e}", rule.id);
            }
        }
    }
    (created, failed, remaining)
}
