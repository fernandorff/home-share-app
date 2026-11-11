//! Environment read once at start (spec 013, criterion 21): a missing required variable stops the server,
//! naming the variable and never its value.

pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub pool_max: usize,
    pub port: u16,
    /// The Vite build (`npm run build:web`); WEB_DIR, default `dist` in the working directory.
    pub web_dir: std::path::PathBuf,
    /// APP_ENV=production: the only deploy search engines may index (src/lib/deploy/robots.ts).
    pub production: bool,
    /// Web Push keys (ADR 0011); None while push is not configured.
    pub vapid: Option<Vapid>,
}

pub struct Vapid {
    pub public_key: String,
    pub private_key: String,
    pub subject: String,
}

const VAPID: [&str; 3] = ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];

impl Config {
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
        let required = |name: &str| get(name).filter(|v| !v.is_empty()).ok_or(format!("{name} is required"));
        // Web Push (ADR 0011): all three VAPID variables or none, same rule as next.config.ts.
        let missing: Vec<&str> = VAPID.into_iter().filter(|n| get(n).is_none_or(|v| v.is_empty())).collect();
        if !missing.is_empty() && missing.len() < VAPID.len() {
            return Err(format!("Web Push is partly configured — missing: {}", missing.join(", ")));
        }
        Ok(Config {
            database_url: required("DATABASE_URL")?,
            jwt_secret: required("JWT_SECRET")?,
            pool_max: get("DATABASE_POOL_MAX").and_then(|v| v.parse().ok()).unwrap_or(10),
            port: get("PORT").and_then(|v| v.parse().ok()).unwrap_or(8080),
            web_dir: get("WEB_DIR").filter(|v| !v.is_empty()).unwrap_or_else(|| "dist".into()).into(),
            production: get("APP_ENV").as_deref() == Some("production"),
            // pushConfig: trimmed, and all three present.
            vapid: match VAPID.map(|n| get(n).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())) {
                [Some(public_key), Some(private_key), Some(subject)] => Some(Vapid { public_key, private_key, subject }),
                _ => None,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn needs_database_url_and_jwt_secret_and_names_only_the_variable() {
        let err = Config::from_env(env(&[("JWT_SECRET", "s3cret")])).err().unwrap();
        assert_eq!(err, "DATABASE_URL is required");
        let err = Config::from_env(env(&[("DATABASE_URL", "postgres://x"), ("JWT_SECRET", "")])).err().unwrap();
        assert_eq!(err, "JWT_SECRET is required");
    }

    #[test]
    fn vapid_is_all_or_none() {
        let base = [("DATABASE_URL", "postgres://x"), ("JWT_SECRET", "s")];
        assert!(Config::from_env(env(&base)).is_ok());
        let err = Config::from_env(env(&[base[0], base[1], ("VAPID_SUBJECT", "mailto:a@b.c")])).err().unwrap();
        assert!(err.contains("NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY"));
        assert!(!err.contains("mailto"));
    }

    #[test]
    fn defaults() {
        let c = Config::from_env(env(&[("DATABASE_URL", "postgres://x"), ("JWT_SECRET", "s")])).unwrap();
        assert_eq!((c.pool_max, c.port), (10, 8080));
        assert_eq!((c.web_dir.to_str(), c.production), (Some("dist"), false));
    }
}
