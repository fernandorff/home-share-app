//! The daily jobs (ADR 0010): posting due recurring expenses (11:00 UTC) and the notices job (12:00 UTC: due-date
//! reminders, Monday debt reminders, 90-day pruning). They run in-process on a timer, and the same work answers
//! GET /api/cron/* (Bearer CRON_SECRET) like src/app/api/cron/**. Ledger claims and dedupe keys make a repeated or
//! overlapping run harmless; a missed one is caught up by the next.

use crate::{errors::ApiError, notifications, AppState};
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    Json,
};
use chrono::{Datelike, Duration as Days, NaiveTime, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

const DEADLINE: Duration = Duration::from_secs(30);
const RETENTION_DAYS: i64 = 90;

/// requireCron: the bearer must equal CRON_SECRET (compared as digests); no secret set rejects everything.
fn require_cron(headers: &HeaderMap) -> Result<(), ApiError> {
    let unauthorized = || ApiError::new(StatusCode::UNAUTHORIZED, "Unauthorized", "CRON_UNAUTHORIZED");
    let secret = std::env::var("CRON_SECRET").ok().filter(|s| !s.is_empty()).ok_or_else(unauthorized)?;
    let presented = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
    if Sha256::digest(presented.as_bytes()) == Sha256::digest(format!("Bearer {secret}").as_bytes()) { Ok(()) } else { Err(unauthorized()) }
}

pub async fn recurring_expenses(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    require_cron(&headers)?;
    Ok(Json(run_recurring(&state).await))
}

pub async fn notices(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    require_cron(&headers)?;
    run_notices(&state).await.map(Json).map_err(|e| ApiError::internal("Failed to run the notices job", e))
}

async fn run_recurring(state: &AppState) -> Value {
    let started = Instant::now();
    let r = super::recurring::post_due(state, None, Some(started + DEADLINE)).await;
    let counts = json!({ "posted": r.posted, "skipped": r.skipped, "paused": r.paused, "duplicates": r.duplicates, "failed": r.failed, "remaining": r.remaining });
    eprintln!("recurring expenses job finished in {} ms: {counts}", started.elapsed().as_millis());
    let mut out = json!({ "ok": true });
    out.as_object_mut().expect("object").extend(counts.as_object().cloned().unwrap_or_default());
    out
}

/// sendDebtReminders: on Mondays (UTC) only, DEBT_REMINDER to each member whose balance in a house (expenses and
/// payments, like the Balances screen) is below zero, once per house and ISO week.
async fn debt_reminders(state: &AppState, deadline: Instant) -> Result<(usize, usize, usize), Box<dyn std::error::Error + Send + Sync>> {
    let now = Utc::now();
    if now.weekday() != chrono::Weekday::Mon {
        return Ok((0, 0, 0));
    }
    let week = now.iso_week();
    let key_week = format!("{}-W{:02}", week.year(), week.week());
    let db = state.pool.get().await?;
    let houses: Vec<i32> = db
        .query(r#"SELECT g."id" FROM "Group" g WHERE EXISTS (SELECT 1 FROM "GroupMember" m WHERE m."groupId" = g."id" AND m."leftAt" IS NULL) ORDER BY g."id""#, &[])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    let (mut created, mut failed, mut remaining) = (0, 0, 0);
    for (index, group_id) in houses.iter().enumerate() {
        if Instant::now() >= deadline {
            remaining = houses.len() - index;
            break;
        }
        // Credits minus debits from the precomputed totals, then every payment folded in.
        let debtors = db
            .query(
                r#"SELECT "userId", sum(c)::bigint FROM (
                       SELECT "userId", cents AS c FROM "BalanceCredit" WHERE "groupId" = $1
                       UNION ALL SELECT "userId", -cents FROM "BalanceDebit" WHERE "groupId" = $1
                       UNION ALL SELECT "fromUserId", ("amount" * 100)::bigint FROM "Settlement" WHERE "groupId" = $1
                       UNION ALL SELECT "toUserId", -("amount" * 100)::bigint FROM "Settlement" WHERE "groupId" = $1
                   ) t GROUP BY "userId" HAVING sum(c) < 0 ORDER BY sum(c) DESC, "userId""#,
                &[group_id],
            )
            .await;
        let debtors = match debtors {
            Ok(rows) => rows,
            Err(e) => {
                failed += 1;
                eprintln!("debt reminder failed (house {group_id}): {e}");
                continue;
            }
        };
        if debtors.is_empty() {
            continue;
        }
        let notices = debtors.iter().map(|r| (r.get::<_, i32>(0), json!({ "amount": crate::money::fixed2(-r.get::<_, i64>(1)) }))).collect();
        match notifications::create_scheduled(state, *group_id, "DEBT_REMINDER", notices, &format!("DEBT_REMINDER:{group_id}:{key_week}")).await {
            Ok(n) => created += n,
            Err(e) => {
                failed += 1;
                eprintln!("debt reminder failed (house {group_id}): {e}");
            }
        }
    }
    Ok((created, failed, remaining))
}

async fn run_notices(state: &AppState) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
    let started = Instant::now();
    let deadline = started + DEADLINE;
    let (due, due_failed, due_remaining) = super::recurring::due_reminders(state, deadline).await;
    let (debt, debt_failed, debt_remaining) = debt_reminders(state, deadline).await?;
    let db = state.pool.get().await?;
    let pruned = db
        .execute(
            r#"DELETE FROM "Notification" WHERE "createdAt" < (now() AT TIME ZONE 'UTC') - make_interval(days => $1)"#,
            &[&(RETENTION_DAYS as i32)],
        )
        .await?;
    let counts = json!({ "dueReminders": due, "debtReminders": debt, "pruned": pruned, "failed": due_failed + debt_failed, "remaining": due_remaining + debt_remaining });
    eprintln!("notifications job finished in {} ms: {counts}", started.elapsed().as_millis());
    let mut out = json!({ "ok": true });
    out.as_object_mut().expect("object").extend(counts.as_object().cloned().unwrap_or_default());
    Ok(out)
}

/// Time until the next `hour`:00 UTC.
fn until(hour: u32) -> Duration {
    let now = Utc::now();
    let today = now.date_naive().and_time(NaiveTime::from_hms_opt(hour, 0, 0).expect("valid hour")).and_utc();
    let next = if today > now { today } else { today + Days::days(1) };
    (next - now).to_std().unwrap_or(Duration::from_secs(60))
}

/// Starts the two daily timers. SCHEDULED_JOBS=off leaves them out (e.g. a local server against a copy of production).
pub fn start(state: &AppState) {
    if std::env::var("SCHEDULED_JOBS").is_ok_and(|v| v == "off") {
        return;
    }
    let s = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(until(11)).await;
            run_recurring(&s).await;
        }
    });
    let s = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(until(12)).await;
            if let Err(e) = run_notices(&s).await {
                eprintln!("notifications job failed: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cron_bearer() {
        std::env::set_var("CRON_SECRET", "s3cret");
        let mut h = HeaderMap::new();
        assert!(require_cron(&h).is_err());
        h.insert(header::AUTHORIZATION, "Bearer s3cret".parse().unwrap());
        assert!(require_cron(&h).is_ok());
        h.insert(header::AUTHORIZATION, "Bearer s3cre".parse().unwrap());
        assert!(require_cron(&h).is_err());
        assert!(until(11) <= Duration::from_secs(86_400));
    }
}
