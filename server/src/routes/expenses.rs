//! /api/expenses (list) and /api/expenses/{id} (detail): same answers as src/app/api/expenses/** over
//! expenseService.list / findByPublicId.

use crate::{db::Cached, errors::ApiError, house::ActiveHouse, input, money, AppState};
use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    Json,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use tokio_postgres::types::ToSql;

const ISO: &str = r#"'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'"#;

/// The Expense columns the API returns (legacy category/platformId/platformIds omitted), plus the payer.
fn select() -> String {
    format!(
        r#"SELECT e."id", e."publicId"::text, e."groupId", e."payerId", e."description", e."notes", e."categories", e."platforms",
                  e."paymentMethods", e."amount"::text, to_char(e."date", {ISO}), to_char(e."createdAt", {ISO}),
                  to_char(e."updatedAt", {ISO}), e."recurringExpenseId",
                  p."publicId"::text, p."name", p."username"
           FROM "Expense" e JOIN "User" p ON p."id" = e."payerId""#
    )
}

fn expense_json(r: &tokio_postgres::Row, participants: Vec<Value>) -> Value {
    json!({
        "id": r.get::<_, i32>(0), "publicId": r.get::<_, String>(1), "groupId": r.get::<_, i32>(2),
        "payerId": r.get::<_, i32>(3), "description": r.get::<_, String>(4), "notes": r.get::<_, Option<String>>(5),
        "categories": r.get::<_, Vec<String>>(6), "platforms": r.get::<_, Vec<String>>(7),
        "paymentMethods": r.get::<_, Vec<String>>(8), "amount": money::number(money::parse_cents(r.get(9))),
        "date": r.get::<_, String>(10), "createdAt": r.get::<_, String>(11), "updatedAt": r.get::<_, String>(12),
        "recurringExpenseId": r.get::<_, Option<i32>>(13),
        "payer": { "id": r.get::<_, i32>(3), "publicId": r.get::<_, String>(14), "name": r.get::<_, String>(15), "username": r.get::<_, String>(16) },
        "participants": participants,
    })
}

/// Participants per expense, in id order. `with_user` = the detail shape (participant.user included).
async fn participants(db: &deadpool_postgres::Client, ids: &[i32], with_user: bool) -> Result<HashMap<i32, Vec<Value>>, tokio_postgres::Error> {
    let rows = db
        .cq(
            r#"SELECT x."id", x."expenseId", x."userId", x."amount"::text, u."publicId"::text, u."name", u."username"
               FROM "ExpenseParticipant" x JOIN "User" u ON u."id" = x."userId"
               WHERE x."expenseId" = ANY($1) ORDER BY x."expenseId", x."id""#,
            &[&ids],
        )
        .await?;
    let mut out: HashMap<i32, Vec<Value>> = HashMap::new();
    for r in rows {
        let mut p = json!({ "id": r.get::<_, i32>(0), "expenseId": r.get::<_, i32>(1), "userId": r.get::<_, i32>(2),
                            "amount": money::number(money::parse_cents(r.get(3))) });
        if with_user {
            p["user"] = json!({ "id": r.get::<_, i32>(2), "publicId": r.get::<_, String>(4), "name": r.get::<_, String>(5), "username": r.get::<_, String>(6) });
        }
        out.entry(r.get(1)).or_default().push(p);
    }
    Ok(out)
}

/// expenseService.findByPublicId, house-scoped, in the detail shape.
pub async fn find(db: &deadpool_postgres::Client, group_id: i32, public_id: &str) -> Result<Option<Value>, tokio_postgres::Error> {
    let rows = db.cq(&format!(r#"{} WHERE e."publicId" = $1::text::uuid AND e."groupId" = $2"#, select()), &[&public_id, &group_id]).await?;
    let Some(r) = rows.first() else { return Ok(None) };
    let id: i32 = r.get(0);
    let mut parts = participants(db, &[id], true).await?;
    Ok(Some(expense_json(r, parts.remove(&id).unwrap_or_default())))
}

pub async fn get_one(State(state): State<AppState>, house: ActiveHouse, Path(public_id): Path<String>) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to load expense", e);
    if !input::is_uuid(&public_id) {
        return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Invalid ID"));
    }
    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    match find(&db, house.group_id, &public_id).await.map_err(|e| fail(&e))? {
        Some(expense) => Ok(Json(json!({ "expense": expense }))),
        None => Err(ApiError::plain(StatusCode::NOT_FOUND, "Expense not found")),
    }
}

/// URLSearchParams: every value of a key, in order, percent-decoded.
fn query_params(raw: &str) -> Vec<(String, String)> {
    let decode = |s: &str| {
        let s = s.replace('+', " ");
        let bytes = s.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                if let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    };
    raw.split('&').filter(|p| !p.is_empty()).map(|p| {
        let (k, v) = p.split_once('=').unwrap_or((p, ""));
        (decode(k), decode(v))
    }).collect()
}

/// JS parseInt(v, 10): leading whitespace, optional sign, digits; NaN when none.
fn parse_int(v: &str) -> Option<i64> {
    let t = v.trim_start();
    let (sign, rest) = match t.strip_prefix('-') { Some(r) => (-1, r), None => (1, t.strip_prefix('+').unwrap_or(t)) };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() { return None }
    digits.parse::<i64>().ok().map(|n| sign * n)
}

const SORT_FIELDS: [&str; 5] = ["date", "amount", "description", "payer", "createdAt"];
const MAX_FILTER_VALUES: usize = 50;

pub async fn list(State(state): State<AppState>, house: ActiveHouse, RawQuery(raw): RawQuery) -> Result<Json<Value>, ApiError> {
    let fail = |e: &dyn std::fmt::Display| ApiError::internal("Failed to list expenses", e);
    let params = query_params(raw.as_deref().unwrap_or(""));
    let first = |k: &str| params.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
    let all = |k: &str| params.iter().filter(|(key, _)| key == k).map(|(_, v)| v.clone()).take(MAX_FILTER_VALUES).collect::<Vec<_>>();

    let page = parse_int(first("page").filter(|s| !s.is_empty()).unwrap_or("1")).filter(|n| *n > 0).unwrap_or(1);
    let page_size = parse_int(first("pageSize").filter(|s| !s.is_empty()).unwrap_or("10")).filter(|n| *n > 0).map(|n| n.min(100_000)).unwrap_or(10);
    let sort_field = first("sortField").filter(|s| !s.is_empty()).unwrap_or("date").to_string();
    let descending = first("sortDirection") != Some("asc");
    let payer_totals = first("includePayerTotals") == Some("true");
    let month_totals = first("includeMonthTotals") == Some("true");
    if !SORT_FIELDS.contains(&sort_field.as_str()) {
        return Err(ApiError::plain(StatusCode::BAD_REQUEST, format!("Invalid sort field: {sort_field}")));
    }

    // parseExpenseFilters: malformed values are dropped, never a 400.
    let mut sql_where = vec![r#"e."groupId" = $1"#.to_string()];
    let mut args: Vec<Box<dyn ToSql + Sync + Send>> = vec![Box::new(house.group_id)];
    let mut push = |clause: &str, arg: Box<dyn ToSql + Sync + Send>, args: &mut Vec<Box<dyn ToSql + Sync + Send>>| {
        args.push(arg);
        sql_where.push(clause.replace('?', &format!("${}", args.len())));
    };
    let query: String = first("query").unwrap_or("").trim().chars().take(200).collect();
    let payer_ids: Vec<i32> = params.iter().filter(|(k, _)| k == "payerIds").filter_map(|(_, v)| parse_int(v))
        .take(MAX_FILTER_VALUES).filter_map(|n| i32::try_from(n).ok()).collect();
    let (platforms, categories, payments) = (all("platforms"), all("categories"), all("paymentMethods"));
    let day = |k: &str| first(k).filter(|v| v.len() == 10 && chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d").is_ok()).map(str::to_string);
    if !payer_ids.is_empty() { push(r#"e."payerId" = ANY(?)"#, Box::new(payer_ids), &mut args) }
    if !platforms.is_empty() { push(r#"e."platforms" && ?"#, Box::new(platforms), &mut args) }
    if !categories.is_empty() { push(r#"e."categories" && ?"#, Box::new(categories), &mut args) }
    if !payments.is_empty() { push(r#"e."paymentMethods" && ?"#, Box::new(payments), &mut args) }
    // Whole local days (UTC on the server): from 00:00:00 to 23:59:59.
    if let Some(d) = day("fromDate") { push(r#"e."date" >= (?::text || 'T00:00:00')::timestamp"#, Box::new(d), &mut args) }
    if let Some(d) = day("toDate") { push(r#"e."date" <= (?::text || 'T23:59:59')::timestamp"#, Box::new(d), &mut args) }
    if !query.is_empty() {
        push(r#"(e."description" ILIKE ? OR e."notes" ILIKE $Q OR p."name" ILIKE $Q)"#, Box::new(format!("%{query}%")), &mut args);
        let n = args.len();
        let last = sql_where.pop().unwrap().replace("$Q", &format!("${n}"));
        sql_where.push(last);
    }
    let where_sql = sql_where.join(" AND ");
    let dir = if descending { "DESC" } else { "ASC" };
    let order = match sort_field.as_str() {
        "payer" => format!(r#"p."name" {dir}, e."id" {dir}"#),
        field => format!(r#"e."{field}" {dir}, e."id" {dir}"#),
    };
    let refs: Vec<&(dyn ToSql + Sync)> = args.iter().map(|a| a.as_ref() as &(dyn ToSql + Sync)).collect();
    let from = r#"FROM "Expense" e JOIN "User" p ON p."id" = e."payerId""#;

    let db = state.pool.get().await.map_err(|e| fail(&e))?;
    let page_sql = format!("{} WHERE {where_sql} ORDER BY {order} LIMIT {page_size} OFFSET {}", select(), (page - 1) * page_size);
    let rows = db.query(&page_sql, &refs).await.map_err(|e| fail(&e))?;
    let totals = db
        .query_one(&format!(r#"SELECT count(*), COALESCE(SUM(e."amount"), 0)::text {from} WHERE {where_sql}"#), &refs)
        .await
        .map_err(|e| fail(&e))?;
    let ids: Vec<i32> = rows.iter().map(|r| r.get(0)).collect();
    let mut parts = participants(&db, &ids, false).await.map_err(|e| fail(&e))?;
    let expenses: Vec<Value> = rows.iter().map(|r| expense_json(r, parts.remove(&r.get::<_, i32>(0)).unwrap_or_default())).collect();

    let total: i64 = totals.get(0);
    let mut pagination = Map::new();
    pagination.insert("page".into(), json!(page));
    pagination.insert("pageSize".into(), json!(page_size));
    pagination.insert("total".into(), json!(total));
    pagination.insert("totalPages".into(), json!((total + page_size - 1) / page_size));
    pagination.insert("totalAmount".into(), json!(money::number(money::parse_cents(totals.get(1)))));
    if payer_totals {
        let rows = db
            .query(&format!(r#"SELECT e."payerId", SUM(e."amount")::text {from} WHERE {where_sql} GROUP BY e."payerId""#), &refs)
            .await
            .map_err(|e| fail(&e))?;
        let list: Vec<Value> = rows.iter().map(|r| json!({ "payerId": r.get::<_, i32>(0), "totalAmount": money::number(money::parse_cents(r.get(1))) })).collect();
        pagination.insert("payerTotals".into(), Value::Array(list));
    }
    if month_totals {
        // bucketMonthTotals over (payer, date) sums, in integer cents, as "0.00" strings.
        let rows = db
            .query(&format!(r#"SELECT e."payerId", to_char(e."date", 'YYYY-MM'), SUM(e."amount")::text {from} WHERE {where_sql} GROUP BY e."payerId", e."date""#), &refs)
            .await
            .map_err(|e| fail(&e))?;
        let mut months: Vec<(String, i64)> = Vec::new();
        let mut payer_months: Vec<(i32, String, i64)> = Vec::new();
        for r in &rows {
            let (payer, month, cents): (i32, String, i64) = (r.get(0), r.get(1), money::parse_cents(r.get(2)));
            match months.iter_mut().find(|(m, _)| *m == month) { Some(e) => e.1 += cents, None => months.push((month.clone(), cents)) }
            match payer_months.iter_mut().find(|(p, m, _)| *p == payer && *m == month) { Some(e) => e.2 += cents, None => payer_months.push((payer, month, cents)) }
        }
        pagination.insert("monthTotals".into(), months.into_iter().map(|(month, c)| json!({ "month": month, "totalAmount": money::fixed2(c) })).collect());
        pagination.insert("payerMonthTotals".into(), payer_months.into_iter().map(|(p, month, c)| json!({ "payerId": p, "month": month, "totalAmount": money::fixed2(c) })).collect());
    }
    Ok(Json(json!({ "expenses": expenses, "pagination": pagination })))
}
