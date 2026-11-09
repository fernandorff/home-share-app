//! Month arithmetic of recurring rules, rule by rule like src/lib/recurrence.ts: periods are "YYYY-MM", due dates
//! "YYYY-MM-DD" (the day clamped to the month's last day), "today" is the rule's own timezone's calendar day.

use chrono::{Datelike, NaiveDate, Utc};
use chrono_tz::Tz;

/// Zones the Intl API prints as UTC.
const UTC_ALIASES: [&str; 14] = [
    "utc", "etc/utc", "etc/uct", "uct", "etc/universal", "universal", "etc/zulu", "zulu", "gmt", "etc/gmt", "etc/gmt0", "gmt0", "etc/greenwich", "greenwich",
];

/// isValidTimeZone + the name Intl resolves it to (case-insensitive; UTC aliases print as "UTC").
pub fn time_zone(value: &str) -> Option<String> {
    if value.is_empty() || value.encode_utf16().count() > 64 {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    if UTC_ALIASES.contains(&lower.as_str()) || ["etc/gmt+0", "etc/gmt-0", "gmt+0", "gmt-0"].contains(&lower.as_str()) {
        return Some("UTC".into());
    }
    Tz::from_str_insensitive(value).ok().map(|tz| tz.name().to_string())
}

pub fn is_period(period: &str) -> bool {
    let b = period.as_bytes();
    b.len() == 7 && b[..4].iter().all(u8::is_ascii_digit) && b[4] == b'-' && matches!((b[5], b[6]), (b'0', b'1'..=b'9') | (b'1', b'0'..=b'2'))
}

/// The rule's calendar day now, in its timezone.
pub fn local_today(tz: &str) -> String {
    let today = match tz.parse::<Tz>() {
        Ok(zone) => Utc::now().with_timezone(&zone).date_naive(),
        Err(_) => Utc::now().date_naive(),
    };
    today.format("%Y-%m-%d").to_string()
}

pub fn period_of(day: &str) -> &str {
    &day[..7]
}

fn split(period: &str) -> (i32, i32) {
    (period[..4].parse().unwrap_or(0), period[5..7].parse().unwrap_or(1))
}

pub fn add_months(period: &str, n: i32) -> String {
    let (year, month) = split(period);
    let index = year * 12 + (month - 1) + n;
    format!("{}-{:02}", index.div_euclid(12), index.rem_euclid(12) + 1)
}

pub fn due_on(period: &str, day_of_month: i32) -> String {
    let (year, month) = split(period);
    let next = if month == 12 { NaiveDate::from_ymd_opt(year + 1, 1, 1) } else { NaiveDate::from_ymd_opt(year, month as u32 + 1, 1) };
    let last = next.and_then(|d| d.pred_opt()).map_or(28, |d| d.day() as i32);
    format!("{period}-{:02}", day_of_month.min(last))
}

/// Periods that are due by `today` and not closed yet (at most `max`), never before the rule became active.
pub fn eligible_periods(day_of_month: i32, active_from: &str, today: &str, last_closed: Option<&str>, max: usize) -> Vec<String> {
    let first = period_of(active_from).to_string();
    let after_closed = last_closed.map_or(first.clone(), |p| add_months(p, 1));
    let mut period = if after_closed > first { after_closed } else { first };
    let mut out = Vec::new();
    while out.len() < max && due_on(&period, day_of_month).as_str() <= today {
        if due_on(&period, day_of_month).as_str() >= active_from {
            out.push(period.clone());
        }
        period = add_months(&period, 1);
    }
    out
}

pub struct Upcoming {
    pub period: String,
    pub due_on: String,
    pub skipped: bool,
}

/// The next `n` periods due today or later (after the last closed one); none while paused.
pub fn upcoming_periods(day_of_month: i32, paused: bool, skipped: &[String], today: &str, last_closed: Option<&str>, n: usize) -> Vec<Upcoming> {
    if paused {
        return Vec::new();
    }
    let current = period_of(today).to_string();
    let after_closed = last_closed.map_or(current.clone(), |p| add_months(p, 1));
    let mut period = if after_closed > current { after_closed } else { current };
    let mut out = Vec::new();
    while out.len() < n {
        let due = due_on(&period, day_of_month);
        if due.as_str() >= today {
            out.push(Upcoming { skipped: skipped.contains(&period), period: period.clone(), due_on: due });
        }
        period = add_months(&period, 1);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months() {
        assert_eq!(add_months("2026-12", 1), "2027-01");
        assert_eq!(add_months("2026-01", -1), "2025-12");
        assert_eq!(due_on("2026-02", 31), "2026-02-28");
        assert_eq!(due_on("2028-02", 30), "2028-02-29");
        assert!(is_period("2026-10") && !is_period("2026-13") && !is_period("2026-00") && !is_period("26-10"));
    }

    #[test]
    fn eligibility_and_upcoming() {
        assert_eq!(eligible_periods(5, "2026-01-10", "2026-03-05", None, 12), vec!["2026-02", "2026-03"]);
        assert_eq!(eligible_periods(5, "2026-01-01", "2026-03-05", Some("2026-02"), 12), vec!["2026-03"]);
        let up = upcoming_periods(10, false, &["2026-12".into()], "2026-11-10", None, 3);
        assert_eq!(up.iter().map(|u| (u.period.as_str(), u.skipped)).collect::<Vec<_>>(), vec![("2026-11", false), ("2026-12", true), ("2027-01", false)]);
        assert_eq!(upcoming_periods(9, false, &[], "2026-11-10", None, 1)[0].period, "2026-12");
    }

    #[test]
    fn zones() {
        assert_eq!(time_zone("america/sao_paulo").as_deref(), Some("America/Sao_Paulo"));
        assert_eq!(time_zone("Etc/UTC").as_deref(), Some("UTC"));
        assert_eq!(time_zone("Mars/Olympus"), None);
    }
}
