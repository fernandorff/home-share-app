//! Money in integer cents (ADR 0003), printed exactly like the Next app (criterion 4): balances as JSON
//! numbers the way JS prints `cents / 100`, `amount` columns as the string Prisma's Decimal gives ("12.5").

/// Exact "123.45" / "-7.5" / "12" → cents. Decimal(10,2) never has more than 2 decimals.
pub fn parse_cents(s: &str) -> i64 {
    let (negative, s) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    let mut digits = frac.bytes().take(2).map(|b| (b - b'0') as i64);
    let cents = int.parse::<i64>().unwrap_or(0) * 100 + digits.next().unwrap_or(0) * 10 + digits.next().unwrap_or(0);
    if negative { -cents } else { cents }
}

/// currency.ts splitCents: the remainder goes one cent at a time from the first part.
pub fn split_cents(total: i64, parts: i64) -> Vec<i64> {
    let base = total.div_euclid(parts);
    let rem = total - base * parts;
    (0..parts).map(|i| base + i64::from(i < rem)).collect()
}

/// A JSON number for cents / 100, written as JS prints it: "12", "12.5", "-0.07".
pub fn number(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    match (abs / 100, abs % 100) {
        (i, 0) => format!("{sign}{i}"),
        (i, f) if f % 10 == 0 => format!("{sign}{i}.{}", f / 10),
        (i, f) => format!("{sign}{i}.{f:02}"),
    }
}

/// notification.service amountString: two fixed decimals ("12.30").
pub fn fixed2(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_decimal_text() {
        assert_eq!(parse_cents("12.5"), 1250);
        assert_eq!(parse_cents("12.34"), 1234);
        assert_eq!(parse_cents("-0.07"), -7);
        assert_eq!(parse_cents("12"), 1200);
        assert_eq!(parse_cents("12.00"), 1200);
    }

    #[test]
    fn prints_like_js() {
        assert_eq!(number(1200), "12");
        assert_eq!(number(1250), "12.5");
        assert_eq!(number(-7), "-0.07");
        assert_eq!(number(0), "0");
    }

    #[test]
    fn splits_like_split_cents() {
        assert_eq!(split_cents(10000, 3), vec![3334, 3333, 3333]);
        assert_eq!(split_cents(10, 3), vec![4, 3, 3]);
        assert_eq!(split_cents(-10, 3), vec![-3, -3, -4]); // Math.floor, like the TS
    }
}
