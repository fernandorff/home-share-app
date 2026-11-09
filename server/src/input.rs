//! Request-body checks that must behave exactly like the JS ones in src/lib/api-helpers.ts.

use chrono::{DateTime, NaiveDate, NaiveDateTime};
use serde_json::Value;

/// Number.isInteger: a JSON number with no fractional part.
pub fn integer(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0)
}

/// JS Math.round (half toward +∞).
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// isCents: at most 2 decimal places, within float noise.
pub fn is_cents(n: f64) -> bool {
    n.is_finite() && (n - js_round(n * 100.0) / 100.0).abs() < 1e-9
}

/// currency.ts toCents for a number.
pub fn to_cents(n: f64) -> i64 {
    js_round(n * 100.0) as i64
}

/// JS truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// uuid's validate(): RFC 4122 versions 1-8 with the right variant, or the nil/max UUID.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    let hex = |range: std::ops::Range<usize>| b[range].iter().all(u8::is_ascii_hexdigit);
    let shaped = b.len() == 36
        && [8, 13, 18, 23].iter().all(|&i| b[i] == b'-')
        && hex(0..8) && hex(9..13) && hex(14..18) && hex(19..23) && hex(24..36);
    let lower = s.to_ascii_lowercase();
    shaped
        && ((b'1'..=b'8').contains(&b[14]) && matches!(lower.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
            || lower == "00000000-0000-0000-0000-000000000000"
            || lower == "ffffffff-ffff-ffff-ffff-ffffffffffff")
}

pub enum Date {
    Missing,
    Invalid,
    /// UTC wall time, as stored in the timestamp(3) columns.
    At(NaiveDateTime),
}

/// parseInputDate. A bare day means noon of that day (T12:00:00 convention) in the server's zone, which is UTC
/// in production; anything else must parse as an ISO date-time. ponytail: JS `new Date()` also accepts odd
/// formats ("Feb 3 2026"); the client never sends them, so they answer "Invalid date" here.
pub fn date(v: &Value) -> Date {
    let raw = match v {
        Value::Null => return Date::Missing,
        Value::String(s) if s.is_empty() => return Date::Missing,
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if raw.len() == 10 && raw.as_bytes()[4] == b'-' && raw.as_bytes()[7] == b'-' {
        return match NaiveDate::parse_from_str(&raw, "%Y-%m-%d") {
            Ok(day) if (2000..=2100).contains(&chrono::Datelike::year(&day)) => Date::At(day.and_hms_opt(12, 0, 0).unwrap()),
            _ => Date::Invalid,
        };
    }
    if let Ok(at) = DateTime::parse_from_rfc3339(&raw) {
        return Date::At(at.naive_utc());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(at) = NaiveDateTime::parse_from_str(&raw, format) {
            return Date::At(at);
        }
    }
    Date::Invalid
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_like_js() {
        assert_eq!(integer(&json!(2)), Some(2.0));
        assert_eq!(integer(&json!(2.0)), Some(2.0));
        assert_eq!(integer(&json!(2.5)), None);
        assert_eq!(integer(&json!("2")), None);
        assert!(is_cents(10.01) && is_cents(0.1 + 0.2) && !is_cents(1.005));
        assert_eq!(to_cents(10.01), 1001);
        assert!(!truthy(&json!(0)) && !truthy(&json!("")) && truthy(&json!([])) && truthy(&json!("x")));
    }

    #[test]
    fn uuids_like_the_uuid_package() {
        assert!(is_uuid("0190f4b3-7c2e-7a1b-9c3d-123456789abc"));
        assert!(is_uuid("00000000-0000-0000-0000-000000000000"));
        assert!(!is_uuid("0190f4b3-7c2e-0a1b-9c3d-123456789abc"), "version 0");
        assert!(!is_uuid("0190f4b3-7c2e-7a1b-1c3d-123456789abc"), "variant");
        assert!(!is_uuid("not-a-uuid"));
    }

    #[test]
    fn dates_like_parse_input_date() {
        let at = |s: &str| match date(&json!(s)) { Date::At(t) => Some(t.to_string()), _ => None };
        assert_eq!(at("2026-02-10"), Some("2026-02-10 12:00:00".into()));
        assert!(matches!(date(&json!("2026-02-30")), Date::Invalid));
        assert!(matches!(date(&json!("1999-01-01")), Date::Invalid));
        assert!(matches!(date(&json!("")), Date::Missing));
        assert!(matches!(date(&Value::Null), Date::Missing));
        assert_eq!(at("2026-02-10T15:30:00.000Z"), Some("2026-02-10 15:30:00".into()));
        assert_eq!(at("2026-02-10T15:30:00-03:00"), Some("2026-02-10 18:30:00".into()));
    }
}
