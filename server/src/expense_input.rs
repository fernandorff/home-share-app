//! validateExpenseInput (src/lib/api-helpers.ts), check by check and in the same order, so every 400 carries
//! the same message and code. Lengths are counted in UTF-16 units like JS `.length`.

use crate::{errors::ApiError, input};
use axum::http::StatusCode;
use chrono::NaiveDateTime;
use serde_json::Value;

pub struct ExpenseInput {
    pub description: String,
    pub notes: Option<String>,
    /// `notes` was in the body (an update leaves the column alone when it is not).
    pub notes_present: bool,
    pub categories: Vec<String>,
    pub platforms: Vec<String>,
    pub payment_methods: Vec<String>,
    pub cents: i64,
    /// The amount as the client sent it, for the activity diff (JS `String(amount)`).
    pub amount: f64,
    pub date: Option<NaiveDateTime>,
    pub payer_id: Value,
    pub split_equally: bool,
    /// (userId, cents) as sent; only meaningful for a custom split.
    pub participants: Vec<(Value, i64)>,
}

fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

fn fail(message: impl Into<std::borrow::Cow<'static, str>>, code: &'static str) -> ApiError {
    ApiError { code: Some(code), ..ApiError::plain(StatusCode::BAD_REQUEST, message) }
}

/// cleanTags: strings only, trimmed, non-empty, at most `max` long, deduped, at most 20.
fn clean_tags(v: &Value, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in v.as_array().into_iter().flatten().filter_map(Value::as_str).map(js_trim) {
        if t.is_empty() || len16(t) > max || out.iter().any(|o| o == t) {
            continue;
        }
        out.push(t.to_string());
        if out.len() >= 20 {
            break;
        }
    }
    out
}

/// JS String.prototype.trim (Unicode whitespace and line terminators).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// C0 control characters except tab, newline and carriage return.
fn has_control(s: &str) -> bool {
    s.chars().any(|c| (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r'))
}

pub fn validate(body: &Value) -> Result<ExpenseInput, ApiError> {
    let categories = clean_tags(&body["categories"], 30);
    let platforms = clean_tags(&body["platforms"], 80);
    let payment_methods = clean_tags(&body["paymentMethods"], 30);

    let description = match &body["description"] {
        Value::String(s) if !js_trim(s).is_empty() => s.clone(),
        _ => return Err(fail("Description is required", "DESCRIPTION_REQUIRED")),
    };
    if len16(&description) > 200 {
        return Err(fail("Description too long (max 200 characters)", "DESCRIPTION_TOO_LONG"));
    }
    if has_control(&description) {
        return Err(fail("Description contains invalid characters", "DESCRIPTION_INVALID"));
    }
    let notes = match &body["notes"] {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        _ => return Err(fail("Invalid notes", "NOTES_INVALID")),
    };
    if let Some(n) = notes.as_deref().filter(|n| !n.is_empty()) {
        if len16(n) > 1000 {
            return Err(fail("Notes too long (max 1000 characters)", "NOTES_TOO_LONG"));
        }
        if has_control(n) {
            return Err(fail("Notes contain invalid characters", "NOTES_INVALID"));
        }
    }
    let Some(amount) = body["amount"].as_f64().filter(|a| a.is_finite() && *a > 0.0) else {
        return Err(fail("Amount must be greater than zero", "AMOUNT_INVALID"));
    };
    if !input::is_cents(amount) {
        return Err(fail("Amount must have at most 2 decimal places", "AMOUNT_PRECISION"));
    }
    let cents = input::to_cents(amount);
    if cents > 9_999_999_999 {
        return Err(fail("Amount too high (max 99,999,999.99)", "AMOUNT_TOO_HIGH"));
    }
    let payer_id = body["payerId"].clone();
    if !input::truthy(&payer_id) {
        return Err(fail("Payer is required", "PAYER_REQUIRED"));
    }
    // Destructuring defaults: a missing (undefined) value takes the default, an explicit null does not.
    let split_equally = match body.get("splitEqually") {
        None => true,
        Some(v) => input::truthy(v),
    };
    let raw_participants = match body.get("participants") {
        None => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return Err(fail("Invalid participants list", "PARTICIPANTS_INVALID")),
    };
    let mut participants = Vec::with_capacity(raw_participants.len());
    if !split_equally {
        if raw_participants.is_empty() {
            return Err(fail("A custom split needs at least one participant", "SPLIT_EMPTY"));
        }
        let ids: Vec<String> = raw_participants.iter().map(|p| p["userId"].to_string()).collect();
        if ids.iter().enumerate().any(|(i, id)| ids[..i].contains(id)) {
            return Err(fail("There is a duplicate participant in the split", "PARTICIPANT_DUPLICATE"));
        }
        let amounts: Vec<Option<f64>> = raw_participants.iter().map(|p| p["amount"].as_f64().filter(|a| a.is_finite())).collect();
        if amounts.iter().any(|a| a.is_none_or(|a| a < 0.0)) {
            return Err(fail("A participant's amount cannot be negative", "PARTICIPANT_NEGATIVE"));
        }
        if amounts.iter().any(|a| !input::is_cents(a.unwrap())) {
            return Err(fail("A participant's amount must have at most 2 decimal places", "PARTICIPANT_PRECISION"));
        }
        let total: i64 = amounts.iter().map(|a| input::to_cents(a.unwrap())).sum();
        if total != cents {
            return Err(fail(
                format!(
                    "Sum of participant amounts ({}) differs from the total amount ({})",
                    crate::money::fixed2(total),
                    to_fixed2(amount)
                ),
                "PARTICIPANTS_SUM_MISMATCH",
            ));
        }
        participants = raw_participants.iter().zip(amounts).map(|(p, a)| (p["userId"].clone(), input::to_cents(a.unwrap()))).collect();
    } else {
        participants = raw_participants.iter().map(|p| (p["userId"].clone(), 0)).collect();
    }
    let date = match input::date(&body["date"]) {
        input::Date::Missing => None,
        input::Date::Invalid => return Err(fail("Invalid date", "DATE_INVALID")),
        input::Date::At(at) => Some(at),
    };
    let notes_present = body.get("notes").is_some();
    Ok(ExpenseInput { description, notes, notes_present, categories, platforms, payment_methods, cents, amount, date, payer_id, split_equally, participants })
}

/// JS Number.prototype.toFixed(2) for a value that already has at most 2 decimals.
fn to_fixed2(n: f64) -> String {
    crate::money::fixed2(input::to_cents(n))
}

pub const DEFAULT_CATEGORIES: [&str; 10] = ["groceries", "dining", "home", "utilities", "transport", "health", "leisure", "shopping", "pets", "other"];
pub const DEFAULT_PLATFORMS: [&str; 4] = ["amazon", "mercadolivre", "shopee", "loja_fisica"];
pub const DEFAULT_PAYMENT_METHODS: [&str; 4] = ["credit", "debit", "pix", "cash"];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn code(body: Value) -> &'static str {
        validate(&body).err().and_then(|e| e.code).unwrap_or("ok")
    }

    #[test]
    fn checks_in_the_same_order() {
        assert_eq!(code(json!({})), "DESCRIPTION_REQUIRED");
        assert_eq!(code(json!({ "description": "  " })), "DESCRIPTION_REQUIRED");
        assert_eq!(code(json!({ "description": "a\u{0}" })), "DESCRIPTION_INVALID");
        assert_eq!(code(json!({ "description": "a", "notes": 3 })), "NOTES_INVALID");
        assert_eq!(code(json!({ "description": "a", "amount": 1.001 })), "AMOUNT_PRECISION");
        assert_eq!(code(json!({ "description": "a", "amount": 1 })), "PAYER_REQUIRED");
        assert_eq!(code(json!({ "description": "a", "amount": 1, "payerId": 1, "participants": {} })), "PARTICIPANTS_INVALID");
        assert_eq!(code(json!({ "description": "a", "amount": 1, "payerId": 1, "splitEqually": false })), "SPLIT_EMPTY");
        let split = |ps: Value| code(json!({ "description": "a", "amount": 1, "payerId": 1, "splitEqually": false, "participants": ps }));
        assert_eq!(split(json!([{ "userId": 1, "amount": 0.5 }, { "userId": 1, "amount": 0.5 }])), "PARTICIPANT_DUPLICATE");
        assert_eq!(split(json!([{ "userId": 1, "amount": -1 }])), "PARTICIPANT_NEGATIVE");
        assert_eq!(split(json!([{ "userId": 1, "amount": 0.999 }])), "PARTICIPANT_PRECISION");
        assert_eq!(split(json!([{ "userId": 1, "amount": 0.5 }])), "PARTICIPANTS_SUM_MISMATCH");
        assert_eq!(split(json!([{ "userId": 1, "amount": 0.5 }, { "userId": 2, "amount": 0.5 }])), "ok");
    }

    #[test]
    fn tags_are_cleaned() {
        let v = validate(&json!({ "description": "a", "amount": 1, "payerId": 1, "categories": [" pets ", "pets", 3, "", "x".repeat(31)] })).ok().unwrap();
        assert_eq!(v.categories, vec!["pets"]);
    }
}
