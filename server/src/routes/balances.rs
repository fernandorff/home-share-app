//! GET /api/balances, same body as src/app/api/balances/route.ts: totals precomputed by the database
//! triggers, payments folded in, debts simplified; the finished JSON is kept per house under its version.

use crate::{db::Cached, errors::ApiError, house::ActiveHouse, money, AppState};
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

const FAILED: &str = "Erro ao calcular saldos";

#[derive(Debug, Clone, PartialEq)]
pub struct Balance {
    pub user_id: i32,
    pub user_name: String,
    pub cents: i64,
}

pub struct Payment {
    pub from: (i32, String),
    pub to: (i32, String),
    pub cents: i64,
}

#[derive(Debug, PartialEq)]
pub struct Debt {
    pub from: (i32, String),
    pub to: (i32, String),
    pub cents: i64,
}

/// applySettlements: balances first, then people only seen in payments; stable sort, biggest first.
pub fn apply_settlements(balances: &[Balance], payments: &[Payment]) -> Vec<Balance> {
    let mut out: Vec<Balance> = balances.to_vec();
    let add = |(id, name): &(i32, String), delta: i64, out: &mut Vec<Balance>| match out.iter_mut().find(|b| b.user_id == *id) {
        Some(b) => b.cents += delta,
        None => out.push(Balance { user_id: *id, user_name: name.clone(), cents: delta }),
    };
    for p in payments {
        add(&p.from, p.cents, &mut out);
        add(&p.to, -p.cents, &mut out);
    }
    out.sort_by(|a, b| b.cents.cmp(&a.cents));
    out
}

/// simplifyDebts: biggest debtor pays the first creditor that still has something to receive.
pub fn simplify_debts(balances: &[Balance]) -> Vec<Debt> {
    let mut creditors: Vec<(&Balance, i64)> = balances.iter().filter(|b| b.cents > 0).map(|b| (b, b.cents)).collect();
    let mut debtors: Vec<(&Balance, i64)> = balances.iter().filter(|b| b.cents < 0).map(|b| (b, -b.cents)).collect();
    creditors.sort_by(|a, b| b.1.cmp(&a.1));
    debtors.sort_by(|a, b| b.1.cmp(&a.1));
    let mut out = Vec::new();
    for debtor in debtors.iter_mut() {
        while debtor.1 > 0 {
            let Some(creditor) = creditors.iter_mut().find(|c| c.1 > 0) else { break };
            let cents = debtor.1.min(creditor.1);
            out.push(Debt {
                from: (debtor.0.user_id, debtor.0.user_name.clone()),
                to: (creditor.0.user_id, creditor.0.user_name.clone()),
                cents,
            });
            debtor.1 -= cents;
            creditor.1 -= cents;
        }
    }
    out
}

// ponytail: one process, one entry per house; a shared cache only once the server runs as several instances.
type Bodies = Mutex<HashMap<i32, (i64, Arc<str>)>>;
fn bodies() -> &'static Bodies {
    static BODIES: OnceLock<Bodies> = OnceLock::new();
    BODIES.get_or_init(Default::default)
}

fn ok(body: Arc<str>, etag: String) -> Response {
    (StatusCode::OK, [(header::CONTENT_TYPE, "application/json".to_string()), (header::ETAG, etag)], body.to_string()).into_response()
}

fn text(v: &str) -> String {
    serde_json::to_string(v).expect("string to JSON")
}

pub async fn get(State(state): State<AppState>, house: ActiveHouse, headers: HeaderMap) -> Result<Response, ApiError> {
    let group_id = house.group_id;
    let fail = |e: &dyn std::fmt::Display| ApiError::internal(FAILED, e);
    let db = state.pool.get().await.map_err(|e| fail(&e))?;

    // Version first: a write landing mid-way bumps it again, so a stale body is never stored as current.
    let version: i64 = db
        .cq(r#"SELECT v FROM "GroupVersion" WHERE "groupId" = $1"#, &[&group_id])
        .await
        .map_err(|e| fail(&e))?
        .first()
        .map(|r| r.get(0))
        .unwrap_or(0);
    let etag = format!(r#""g{group_id}v{version}""#);
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }
    if let Some(body) = bodies().lock().unwrap().get(&group_id).filter(|(v, _)| *v == version).map(|(_, b)| b.clone()) {
        return Ok(ok(body, etag));
    }

    let totals = |sql: &'static str| {
        let pool = &state.pool;
        async move {
            let db = pool.get().await.map_err(|e| fail(&e))?;
            let rows = db.cq(sql, &[&group_id]).await.map_err(|e| fail(&e))?;
            Ok::<_, ApiError>(rows.iter().map(|r| (r.get::<_, String>(0), r.get::<_, i64>(1))).collect::<Vec<_>>())
        }
    };
    let (credit, debit, categories, months, (payments_json, payments)) = tokio::try_join!(
        totals(r#"SELECT "userId"::text, cents FROM "BalanceCredit" WHERE "groupId" = $1 ORDER BY "userId""#),
        totals(r#"SELECT "userId"::text, cents FROM "BalanceDebit" WHERE "groupId" = $1 ORDER BY "userId""#),
        totals(r#"SELECT category, cents FROM "BalanceCategoryTotal" WHERE "groupId" = $1 ORDER BY cents DESC, category"#),
        totals(r#"SELECT month, cents FROM "BalanceMonthTotal" WHERE "groupId" = $1 ORDER BY month DESC"#),
        payments(&state, group_id),
    )?;

    // balanceService.aggregate: payers first, then participants, each in userId order; names from User.
    let mut ids: Vec<i32> = Vec::new();
    for (id, _) in credit.iter().chain(&debit) {
        let id: i32 = id.parse().expect("integer id");
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let names: HashMap<i32, String> = db
        .cq(r#"SELECT "id", "name" FROM "User" WHERE "id" = ANY($1)"#, &[&ids])
        .await
        .map_err(|e| fail(&e))?
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    let sum = |rows: &[(String, i64)], id: i32| rows.iter().find(|(k, _)| k.parse() == Ok(id)).map_or(0, |(_, c)| *c);
    let mut raw: Vec<Balance> = ids
        .iter()
        .map(|&id| Balance {
            user_id: id,
            user_name: names.get(&id).cloned().unwrap_or_else(|| "?".into()),
            cents: sum(&credit, id) - sum(&debit, id),
        })
        .collect();
    raw.sort_by(|a, b| b.cents.cmp(&a.cents));

    let balances = apply_settlements(&raw, &payments);
    let debts = simplify_debts(&balances);
    let list = |items: Vec<String>| items.join(",");
    let body = format!(
        r#"{{"balances":[{}],"settlements":[{}],"totalExpenses":{},"payments":{},"byCategory":[{}],"byMonth":[{}]}}"#,
        list(balances.iter().map(|b| format!(r#"{{"userId":{},"userName":{},"balance":{}}}"#, b.user_id, text(&b.user_name), money::number(b.cents))).collect()),
        list(debts.iter().map(|d| format!(
            r#"{{"from":{{"id":{},"name":{}}},"to":{{"id":{},"name":{}}},"amount":{}}}"#,
            d.from.0, text(&d.from.1), d.to.0, text(&d.to.1), money::number(d.cents)
        )).collect()),
        money::number(months.iter().map(|(_, c)| c).sum()),
        payments_json,
        list(categories.iter().map(|(c, v)| format!(r#"{{"category":{},"total":{}}}"#, text(c), money::number(*v))).collect()),
        list(months.iter().map(|(m, v)| format!(r#"{{"month":{},"total":{}}}"#, text(m), money::number(*v))).collect()),
    );
    let body: Arc<str> = Arc::from(body);
    bodies().lock().unwrap().insert(group_id, (version, body.clone()));
    Ok(ok(body, etag))
}

/// settlementService.list: newest first, with fromUser/toUser, serialized like Prisma (dates as ISO with ms).
async fn payments(state: &AppState, group_id: i32) -> Result<(String, Vec<Payment>), ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal(FAILED, e);
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let rows = db
        .cq(
            r#"SELECT s."id", s."publicId"::text, s."groupId", s."fromUserId", s."toUserId", s."amount"::text, s."note",
                      to_char(s."date", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), s."createdById",
                      to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(s."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                      f."name", t."name"
               FROM "Settlement" s JOIN "User" f ON f."id" = s."fromUserId" JOIN "User" t ON t."id" = s."toUserId"
               WHERE s."groupId" = $1 ORDER BY s."date" DESC, s."id" DESC"#,
            &[&group_id],
        )
        .await
        .map_err(|e| fail(&e))?;
    let mut json = Vec::with_capacity(rows.len());
    let mut list = Vec::with_capacity(rows.len());
    for r in &rows {
        let (from, to): (i32, i32) = (r.get(3), r.get(4));
        let cents = money::parse_cents(r.get(5));
        let (from_name, to_name): (String, String) = (r.get(11), r.get(12));
        let note: Option<String> = r.get(6);
        let created_by: Option<i32> = r.get(8);
        json.push(format!(
            r#"{{"id":{},"publicId":{},"groupId":{},"fromUserId":{from},"toUserId":{to},"amount":{},"note":{},"date":"{}","createdById":{},"createdAt":"{}","updatedAt":"{}","fromUser":{{"id":{from},"name":{}}},"toUser":{{"id":{to},"name":{}}}}}"#,
            r.get::<_, i32>(0),
            text(r.get(1)),
            r.get::<_, i32>(2),
            money::amount(cents),
            note.as_deref().map(text).unwrap_or_else(|| "null".into()),
            r.get::<_, String>(7),
            created_by.map_or("null".into(), |v| v.to_string()),
            r.get::<_, String>(9),
            r.get::<_, String>(10),
            text(&from_name),
            text(&to_name),
        ));
        list.push(Payment { from: (from, from_name), to: (to, to_name), cents });
    }
    Ok((format!("[{}]", json.join(",")), list))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(id: i32, name: &str, cents: i64) -> Balance {
        Balance { user_id: id, user_name: name.into(), cents }
    }
    fn pay(cents: i64) -> Vec<Payment> {
        vec![Payment { from: (2, "Bruno".into()), to: (1, "Ana".into()), cents }]
    }

    // Fixtures from src/lib/balance.test.ts and balance-settlements.test.ts.
    #[test]
    fn simplifies_debts_in_exact_cents() {
        let d = simplify_debts(&[b(1, "F", 5000), b(2, "T", -5000)]);
        assert_eq!(d, vec![Debt { from: (2, "T".into()), to: (1, "F".into()), cents: 5000 }]);
        let d = simplify_debts(&[b(1, "F", 6667), b(2, "T", -3333), b(3, "O", -3334)]);
        assert_eq!((d.len(), d.iter().map(|x| x.cents).sum::<i64>()), (2, 6667));
        assert!(simplify_debts(&[b(1, "F", 0), b(2, "T", 0)]).is_empty());
    }

    #[test]
    fn folds_payments() {
        let base = [b(1, "Ana", 5000), b(2, "Bruno", -5000)];
        let cents = |v: Vec<Balance>| v.iter().map(|x| (x.user_id, x.cents)).collect::<Vec<_>>();
        assert_eq!(cents(apply_settlements(&base, &pay(3000))), vec![(1, 2000), (2, -2000)]);
        assert_eq!(cents(apply_settlements(&base, &pay(6000))), vec![(2, 1000), (1, -1000)]);
        // Someone only seen in a payment joins at the end before sorting.
        let only = apply_settlements(&[], &pay(100));
        assert_eq!(cents(only), vec![(2, 100), (1, -100)]);
    }
}
