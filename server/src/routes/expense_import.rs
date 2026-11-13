//! POST /api/expenses/import: same answers and rows as src/app/api/expenses/import/route.ts and
//! expenseService.importFromCSV. Accepts the browser's multipart upload, a JSON body or raw text.

use crate::{
    audit::{self, Action, Revision},
    csv::{self, js_number},
    errors::{json_body, ApiError},
    expense_input::{js_trim, DEFAULT_PLATFORMS},
    house::ActiveHouse,
    money, AppState,
};
use axum::{
    body::Bytes,
    extract::{FromRequest, Multipart, Request, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

struct Upload {
    text: Option<String>,
    split_equally: Value,
    payer_id: Option<i64>,
    platform: Option<String>,
    default_date: Option<String>,
}

/// JS parseInt(String(v)) || null.
fn int_or_none(v: &str) -> Option<i64> {
    let t = v.trim_start();
    let (neg, rest) = match t.strip_prefix('-') { Some(r) => (true, r), None => (false, t.strip_prefix('+').unwrap_or(t)) };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let n: i64 = digits.parse().ok()?;
    let n = if neg { -n } else { n };
    (n != 0).then_some(n)
}

fn fail(e: &dyn std::fmt::Display) -> ApiError {
    ApiError::internal("Failed to import expenses", e)
}

async fn read(request: Request, state: &AppState) -> Result<Upload, ApiError> {
    let kind = request.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let mut up = Upload { text: None, split_equally: Value::Bool(true), payer_id: None, platform: None, default_date: None };
    if kind.contains("multipart/form-data") {
        let mut form = Multipart::from_request(request, state).await.map_err(|e| fail(&e))?;
        let mut file = None;
        while let Some(field) = form.next_field().await.map_err(|e| fail(&e))? {
            let name = field.name().unwrap_or("").to_string();
            let is_file = field.file_name().is_some();
            let text = field.text().await.map_err(|e| fail(&e))?;
            match name.as_str() {
                "file" if file.is_none() && is_file => file = Some(text),
                "splitEqually" => up.split_equally = Value::Bool(text == "true"),
                "payerId" if !text.is_empty() => up.payer_id = int_or_none(&text),
                "platform" if !text.is_empty() => up.platform = Some(js_trim(&text).to_string()).filter(|p| !p.is_empty()),
                "defaultDate" => up.default_date = Some(text),
                _ => {}
            }
        }
        up.text = Some(file.ok_or_else(|| fail(&"CSV file not provided"))?);
    } else if kind.contains("application/json") {
        let bytes = Bytes::from_request(request, state).await.map_err(|e| fail(&e))?;
        let body: Value = json_body(&bytes)?;
        up.text = body["csv"].as_str().map(str::to_string);
        if let Some(v) = body.get("splitEqually") { up.split_equally = v.clone() }
        if crate::input::truthy(&body["payerId"]) {
            let raw = match &body["payerId"] { Value::String(s) => s.clone(), other => other.to_string() };
            up.payer_id = int_or_none(&raw);
        }
        up.platform = body["platform"].as_str().map(|p| js_trim(p).to_string()).filter(|p| !p.is_empty());
        up.default_date = body["defaultDate"].as_str().map(str::to_string);
    } else {
        let bytes = Bytes::from_request(request, state).await.map_err(|e| fail(&e))?;
        up.text = Some(String::from_utf8_lossy(&bytes).into_owned());
    }
    Ok(up)
}

pub async fn import(State(state): State<AppState>, house: ActiveHouse, request: Request) -> Result<Response, ApiError> {
    let up = read(request, &state).await?;
    let text = up.text.unwrap_or_default();
    if js_trim(&text).is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "Empty CSV", "CSV_EMPTY"));
    }
    let mut db = state.pool.get().await.map_err(|e| fail(&e))?;
    if let Some(p) = up.platform.as_deref().filter(|p| !DEFAULT_PLATFORMS.contains(p)) {
        let found = db
            .query(r#"SELECT 1 FROM "Platform" WHERE "groupId" = $1 AND "name" = $2 LIMIT 1"#, &[&house.group_id, &p])
            .await
            .map_err(|e| fail(&e))?;
        if found.is_empty() {
            return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Invalid platform"));
        }
    }
    let members: Vec<i32> = db
        .query(r#"SELECT "userId" FROM "GroupMember" WHERE "groupId" = $1 AND "leftAt" IS NULL ORDER BY "createdAt""#, &[&house.group_id])
        .await
        .map_err(|e| fail(&e))?
        .iter()
        .map(|r| r.get(0))
        .collect();
    let payer = up.payer_id.unwrap_or(house.session.user_id);
    let Some(payer) = i32::try_from(payer).ok().filter(|p| members.contains(p)) else {
        return Err(ApiError::plain(StatusCode::BAD_REQUEST, "Payer is not a member of this house"));
    };
    let default_date = super::expense_more::local_day(up.default_date.as_deref());
    let (rows, invalid) = csv::parse(&text, default_date.as_deref())?;
    if rows.is_empty() {
        let detail = if invalid.is_empty() {
            String::new()
        } else {
            format!(" Rows with errors: {}", invalid.iter().map(|r| format!("{} ({})", r.line, r.code)).collect::<Vec<_>>().join(", "))
        };
        return Err(ApiError { code: Some("CSV_NO_VALID_ROWS"), ..ApiError::plain(StatusCode::BAD_REQUEST, format!("No valid expenses found in the CSV.{detail}")) });
    }

    let split_equally = crate::input::truthy(&up.split_equally);
    let platforms: Vec<String> = up.platform.iter().cloned().collect();
    let actor = Some(house.session.user_id as i32);
    let tx = db.transaction().await.map_err(|e| fail(&e))?;
    let mut expense_data = Vec::with_capacity(rows.len());
    let mut participant_data = Vec::new();
    for row in &rows {
        let public_id = uuid::Uuid::now_v7().to_string();
        let date = format!("{}T12:00:00", row.date);
        let amount = js_number(row.amount);
        let id: i32 = tx
            .query_one(
                r#"INSERT INTO "Expense" ("publicId", "groupId", "payerId", "platforms", "description", "notes", "amount", "date", "updatedAt")
                   VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7::text::numeric, $8::text::timestamp, now() AT TIME ZONE 'UTC') RETURNING "id""#,
                &[&public_id, &house.group_id, &payer, &platforms, &row.description, &row.notes, &amount.to_string(), &date],
            )
            .await
            .map_err(|e| fail(&e))?
            .get(0);
        expense_data.push(json!({
            "publicId": public_id, "groupId": house.group_id, "payerId": payer, "platforms": platforms,
            "description": row.description, "notes": row.notes, "amount": amount, "date": format!("{date}.000Z"),
        }));
        // equalSplit over the active members, or the payer carries the whole amount.
        let cents = crate::input::to_cents(row.amount);
        let shares: Vec<(i32, Value)> = if split_equally {
            members.iter().copied().zip(money::split_cents(cents, members.len() as i64)).map(|(u, c)| (u, js_number(c as f64 / 100.0))).collect()
        } else {
            members.iter().map(|&u| (u, if u == payer { amount.clone() } else { json!(0) })).collect()
        };
        for (user, share) in shares {
            tx.execute(
                r#"INSERT INTO "ExpenseParticipant" ("expenseId", "userId", "amount") VALUES ($1, $2, $3::text::numeric)"#,
                &[&id, &user, &share.to_string()],
            )
            .await
            .map_err(|e| fail(&e))?;
            participant_data.push(json!({ "userId": user, "amount": share, "expenseId": id }));
        }
    }
    // Two createMany markers. The expense rows carry their house; the participant rows only reach it through the
    // audit context, which the Next app loses, so that marker's house is null there and here.
    let markers = [
        ("Expense", Some(house.group_id), expense_data),
        ("ExpenseParticipant", None, participant_data),
    ];
    for (entity, group_id, data) in markers {
        let count = data.len();
        let marker = Revision { entity_type: entity, entity_id: format!("bulk:{count}"), group_id, action: Action::Create, actor_id: actor, row: Value::Array(data), fields_set: &[] };
        audit::bulk(&tx, marker, "CREATE").await.map_err(|e| fail(&e))?;
    }
    tx.commit().await.map_err(|e| fail(&e))?;

    let total: f64 = rows.iter().fold(0.0, |sum, r| sum + r.amount);
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "message": format!("{} expenses imported successfully", rows.len()),
            "created": rows.len(),
            "invalidRows": invalid.iter().map(csv::InvalidRow::json).collect::<Vec<_>>(),
            "totalValue": js_number(total),
            "expenses": rows.iter().map(csv::Row::json).collect::<Vec<_>>(),
        })),
    )
        .into_response())
}
