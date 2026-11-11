//! In-memory rate limits, per process (design: one instance matches today's limits; two servers on one database
//! give a client at most twice the limit, accepted).

use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

/// rateLimit (src/lib/rate-limit.ts): at most `max` hits per window, per key, in this process.
pub fn allow(key: String, max: usize, window: Duration) -> bool {
    static HITS: LazyLock<Mutex<HashMap<String, Vec<Instant>>>> = LazyLock::new(Default::default);
    let now = Instant::now();
    let mut hits = HITS.lock().unwrap_or_else(|e| e.into_inner());
    let recent = hits.entry(key).or_default();
    recent.retain(|t| now - *t < window);
    recent.push(now);
    let allowed = recent.len() <= max;
    if hits.len() > 5000 {
        hits.retain(|_, v| v.iter().any(|t| now - *t < window));
    }
    allowed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limit_window() {
        let key = || "test:rate".to_string();
        assert!((0..3).all(|_| allow(key(), 3, Duration::from_secs(60))));
        assert!(!allow(key(), 3, Duration::from_secs(60)));
    }
}
