//! CSV import parsing, rule by rule like src/lib/csv-parser.ts (parseCSVDetailed, parseMoneyValue, parseDate),
//! including JS parseFloat and UTF-16 lengths, so the same file yields the same rows and the same row errors.

use crate::errors::ApiError;
use crate::expense_input::js_trim;
use axum::http::StatusCode;
use serde_json::{json, Value};

pub const MAX_LINES: usize = 1000;
pub const MAX_BYTES: usize = 1024 * 1024;

pub struct Row {
    pub description: String,
    pub notes: Option<String>,
    pub amount: f64,
    pub date: String,
    pub platform: Option<String>,
}

impl Row {
    /// The row as the route returns it (undefined keys left out, like JSON.stringify).
    pub fn json(&self) -> Value {
        let mut v = json!({ "description": self.description, "amount": js_number(self.amount), "date": self.date });
        if let Some(n) = &self.notes { v["notes"] = json!(n) }
        if let Some(p) = &self.platform { v["platform"] = json!(p) }
        v
    }
}

/// A JS number as JSON: integers without ".0", everything else in shortest round-trip form.
pub fn js_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 1e15 { json!(n as i64) } else { serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number) }
}

/// JS parseFloat: the longest numeric prefix after leading whitespace, or NaN.
pub fn parse_float(s: &str) -> f64 {
    let t = s.trim_start();
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') { i += 1 }
    if t[i..].starts_with("Infinity") {
        return if b.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let digits = |i: &mut usize| { let start = *i; while *i < b.len() && b[*i].is_ascii_digit() { *i += 1 } *i > start };
    let mut any = digits(&mut i);
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        if digits(&mut j) || any { any = true; i = j }
    }
    if !any { return f64::NAN }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') { j += 1 }
        if digits(&mut j) { i = j }
    }
    t[..i].parse().unwrap_or(f64::NAN)
}

fn ends_with_decimal(s: &str, mark: char) -> bool {
    // /<mark>\d{1,2}$/
    let Some(pos) = s.rfind(mark) else { return false };
    let tail = &s[pos + 1..];
    (1..=2).contains(&tail.len()) && tail.bytes().all(|c| c.is_ascii_digit())
}

/// parseMoneyValue: "R$ 1.234,56", "26,00", "1,234.56", "26.00".
pub fn parse_money(raw: &str) -> Option<f64> {
    let clean: String = raw.replacen("R$", "", 1).chars().filter(|c| !c.is_whitespace()).collect();
    let amount = if ends_with_decimal(&clean, ',') {
        parse_float(&clean.replace('.', "").replacen(',', ".", 1))
    } else if ends_with_decimal(&clean, '.') {
        parse_float(&clean.replace(',', ""))
    } else {
        parse_float(&clean.replace([',', '.'], ""))
    };
    (!amount.is_nan()).then_some(amount)
}

/// parseDate: DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD (also with "/"), checked against the calendar.
pub fn parse_date(s: &str) -> Option<String> {
    let parts: Vec<&str> = s.split(['/', '-']).collect();
    if parts.len() != 3 || !parts.iter().all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let (y, m, d) = match (parts[0].len(), parts[1].len(), parts[2].len()) {
        (1..=2, 1..=2, 4) => (parts[2], parts[1], parts[0]),
        (4, 1..=2, 1..=2) => (parts[0], parts[1], parts[2]),
        _ => return None,
    };
    let (yi, mi, di) = (y.parse::<i32>().ok()?, m.parse::<u32>().ok()?, d.parse::<u32>().ok()?);
    chrono::NaiveDate::from_ymd_opt(yi, mi, di)?;
    Some(format!("{y}-{m:0>2}-{d:0>2}"))
}

fn split_line(line: &str, separator: char) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in line.chars() {
        if c == '"' { quoted = !quoted } else if c == separator && !quoted { values.push(std::mem::take(&mut current)) } else { current.push(c) }
    }
    values.push(current);
    values
}

pub struct InvalidRow {
    pub line: usize,
    pub code: &'static str,
    pub value: Option<String>,
    pub max: Option<usize>,
}

impl InvalidRow {
    pub fn json(&self) -> Value {
        let mut v = json!({ "line": self.line, "code": self.code });
        if self.value.is_some() || self.max.is_some() {
            let mut values = serde_json::Map::new();
            if let Some(x) = &self.value { values.insert("value".into(), json!(x)); }
            if let Some(m) = self.max { values.insert("max".into(), json!(m)); }
            v["values"] = Value::Object(values);
        }
        v
    }
}

fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// parseCSVDetailed: every bad line reported with its 1-based number; file-level problems are 400s.
pub fn parse(text: &str, default_date: Option<&str>) -> Result<(Vec<Row>, Vec<InvalidRow>), ApiError> {
    if js_trim(text).is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "The CSV file is empty", "CSV_EMPTY"));
    }
    if text.len() > MAX_BYTES {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "File too large (max. 1MB)", "CSV_TOO_LARGE"));
    }
    let lines: Vec<&str> = js_trim(text).split('\n').collect();
    if lines.len() < 2 {
        return Ok((Vec::new(), Vec::new()));
    }
    if lines.len() - 1 > MAX_LINES {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "CSV has too many lines (max. 1000)", "CSV_TOO_MANY_LINES"));
    }
    let separator = if lines[0].contains(';') { ';' } else { ',' };
    let headers: Vec<String> = lines[0].split(separator).map(|h| js_trim(h).to_lowercase().replace('"', "")).collect();
    let find = |names: &[&str]| headers.iter().position(|h| names.contains(&h.as_str()));
    let description_at = find(&["descricao", "descrição", "description"]);
    let notes_at = find(&["observacao", "observação", "obs", "notes"]);
    let amount_at = find(&["valor", "value", "amount"]);
    let date_at = find(&["data", "date"]);
    let platform_at = find(&["plataforma", "platform"]);
    let (Some(description_at), Some(amount_at)) = (description_at, amount_at) else {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "CSV must contain \"description\" and \"amount\" columns", "CSV_MISSING_COLUMNS"));
    };
    let today = default_date.map(str::to_string).unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());

    let mut rows = Vec::new();
    let mut invalid = Vec::new();
    for (i, raw) in lines.iter().enumerate().skip(1) {
        let line = js_trim(raw);
        if line.is_empty() { continue }
        let values = split_line(line, separator);
        let cell = |at: Option<usize>| at.and_then(|a| values.get(a)).map(|v| js_trim(&v.replace('"', "")).to_string());
        let n = i + 1;
        let bad = |code, value: Option<String>, max| InvalidRow { line: n, code, value, max };
        let description = cell(Some(description_at)).unwrap_or_default();
        let notes = cell(notes_at);
        let amount_text = cell(Some(amount_at)).unwrap_or_default();
        let date_text = cell(date_at).unwrap_or_default();
        let platform = cell(platform_at);
        if description.is_empty() { invalid.push(bad("EMPTY_DESCRIPTION", None, None)); continue }
        if len16(&description) > 200 { invalid.push(bad("DESCRIPTION_TOO_LONG", None, Some(200))); continue }
        if notes.as_deref().is_some_and(|x| len16(x) > 1000) { invalid.push(bad("NOTES_TOO_LONG", None, Some(1000))); continue }
        if amount_text.is_empty() { invalid.push(bad("EMPTY_AMOUNT", None, None)); continue }
        let amount = match parse_money(&amount_text) {
            Some(a) if a > 0.0 => a,
            _ => { invalid.push(bad("INVALID_AMOUNT", Some(amount_text), None)); continue }
        };
        if crate::input::to_cents(amount) > 9_999_999_999 || amount.is_infinite() { invalid.push(bad("AMOUNT_TOO_HIGH", Some(amount_text), None)); continue }
        let date = if date_text.is_empty() {
            today.clone()
        } else {
            match parse_date(&date_text) {
                Some(d) => d,
                None => { invalid.push(bad("INVALID_DATE", Some(date_text), None)); continue }
            }
        };
        rows.push(Row { description, notes: notes.filter(|x| !x.is_empty()), amount, date, platform: platform.filter(|x| !x.is_empty()) });
    }
    Ok((rows, invalid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_float_like_js() {
        assert_eq!(parse_float("12abc"), 12.0);
        assert_eq!(parse_float(".5"), 0.5);
        assert_eq!(parse_float("1e3x"), 1000.0);
        assert_eq!(parse_float("-2."), -2.0);
        assert!(parse_float("abc").is_nan());
        assert!(parse_float(".").is_nan());
    }

    #[test]
    fn money_formats() {
        assert_eq!(parse_money("R$ 1.234,56"), Some(1234.56));
        assert_eq!(parse_money("26,00"), Some(26.0));
        assert_eq!(parse_money("1,234.56"), Some(1234.56));
        assert_eq!(parse_money("26.123"), Some(26123.0));
        assert_eq!(parse_money("abc"), None);
    }

    #[test]
    fn dates() {
        assert_eq!(parse_date("5/3/2026"), Some("2026-03-05".into()));
        assert_eq!(parse_date("2026-3-5"), Some("2026-03-05".into()));
        assert_eq!(parse_date("30/02/2026"), None);
        assert_eq!(parse_date("2026/03"), None);
    }

    #[test]
    fn numbers_print_like_js() {
        assert_eq!(js_number(1000.0).to_string(), "1000");
        assert_eq!(js_number(33.33).to_string(), "33.33");
        assert_eq!(js_number(0.1 + 0.2).to_string(), "0.30000000000000004");
    }
}
