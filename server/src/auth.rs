//! Session cookie, same token as src/lib/auth.ts (ADR 0001, 0013): HS256 with the same secret and claims,
//! so a cookie signed by the Next app is accepted here and the other way round (criterion 11).

use crate::{db::Cached, errors::ApiError, AppState};
use axum::{
    extract::{FromRef, FromRequestParts},
    http::{header, request::Parts, HeaderMap, StatusCode},
};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

pub const SESSION_COOKIE: &str = "homeshare_session";
pub const GROUP_COOKIE: &str = "homeshare_group";
pub const SESSION_MAX_AGE_SECONDS: i64 = 60 * 60 * 24 * 30;
pub const SESSION_RENEW_AFTER_SECONDS: i64 = 60 * 60 * 24;

/// Field order matches jose's output (payload, then iat, then exp), so both sign byte-identical tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claims {
    pub user_id: i64,
    pub public_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub session_version: i64,
    /// When the member actually logged in; tokens signed before ADR 0013 carry none and fall back to iat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_at: Option<i64>,
    #[serde(default)]
    pub iat: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exp: Option<i64>,
}

pub struct Keys {
    encoding: EncodingKey,
    decoding: DecodingKey,
}

impl Keys {
    pub fn new(secret: &str) -> Keys {
        Keys { encoding: EncodingKey::from_secret(secret.as_bytes()), decoding: DecodingKey::from_secret(secret.as_bytes()) }
    }

    /// verifySession: exp/nbf checked when present, no clock tolerance, no claim required.
    pub fn verify(&self, token: &str) -> Option<Claims> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.required_spec_claims.clear();
        let mut claims = decode::<Claims>(token, &self.decoding, &validation).ok()?.claims;
        claims.auth_at.get_or_insert(claims.iat);
        Some(claims)
    }

    /// signSession: a login passes `auth_at = now`; a renewal keeps the session's own.
    pub fn sign(&self, claims: &Claims, auth_at: i64, now: i64) -> String {
        let claims = Claims { auth_at: Some(auth_at), iat: now, exp: Some(now + SESSION_MAX_AGE_SECONDS), ..claims.clone() };
        let header = Header { typ: None, ..Header::new(Algorithm::HS256) };
        encode(&header, &claims, &self.encoding).expect("HS256 signing")
    }

    /// renewedSessionToken: a fresh token at most once a day, keeping the login time.
    pub fn renewed(&self, claims: &Claims, now: i64) -> Option<String> {
        (now - claims.iat >= SESSION_RENEW_AFTER_SECONDS).then(|| self.sign(claims, claims.auth_at.unwrap_or(claims.iat), now))
    }
}

/// Set-Cookie for the session (and the house preference): httpOnly, Secure, SameSite=Lax, 30 days.
pub fn cookie(name: &str, value: &str) -> String {
    format!("{name}={value}; Path=/; Max-Age={SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax")
}

pub fn read_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| {
            let (k, v) = pair.trim().split_once('=')?;
            (k == name).then_some(v)
        })
}

/// requireSession: a valid token whose sessionVersion still matches the database.
pub struct Session(pub Claims);

impl<S> FromRequestParts<S> for Session
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Session, ApiError> {
        let state = AppState::from_ref(state);
        let Some(claims) = read_cookie(&parts.headers, SESSION_COOKIE).and_then(|t| state.keys.verify(t)) else {
            return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Not authenticated", "NOT_AUTHENTICATED"));
        };
        let db = state.pool.get().await.map_err(|e| ApiError::internal("Internal server error", e))?;
        let rows = db
            .cq(r#"SELECT "sessionVersion" FROM "User" WHERE "id" = $1"#, &[&(claims.user_id as i32)])
            .await
            .map_err(|e| ApiError::internal("Internal server error", e))?;
        if rows.first().map(|r| r.get::<_, i32>(0) as i64) != Some(claims.session_version) {
            // Cleared here too: the page gate checks only the JWT, so a revoked cookie would loop on /auth/login.
            return Err(ApiError {
                set_cookie: Some("homeshare_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"),
                ..ApiError::new(StatusCode::UNAUTHORIZED, "Session expired, please log in again", "SESSION_REVOKED")
            });
        }
        crate::observability::set_user(&claims.public_id);
        Ok(Session(claims))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Signed by jose exactly like signSession (scratch script, 2026-11-09): same secret, claims and times.
    const JOSE_TOKEN: &str = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjcsInB1YmxpY0lkIjoiMDE3NGNmNmYtNDhmOC03OTg4LTg5YmItYTBhMGNjMWNjOWM5IiwibmFtZSI6IkvDoXRpYSIsInNlc3Npb25WZXJzaW9uIjoyLCJhdXRoQXQiOjE3MDAwMDAwMDAsImlhdCI6MTcwMDAwMDEwMCwiZXhwIjoxNzAyNTkyMTAwfQ.4j7-UM6kv_WU51gvyo0spt2Uhrc73IO8ZeDwZUbsXH8";

    fn claims() -> Claims {
        Claims {
            user_id: 7,
            public_id: "0174cf6f-48f8-7988-89bb-a0a0cc1cc9c9".into(),
            name: "Kátia".into(),
            session_version: 2,
            auth_at: None,
            iat: 0,
            exp: None,
        }
    }

    #[test]
    fn signs_the_same_bytes_as_jose() {
        let keys = Keys::new("test-secret-for-cross-check");
        assert_eq!(keys.sign(&claims(), 1_700_000_000, 1_700_000_100), JOSE_TOKEN);
    }

    #[test]
    fn rejects_expired_wrong_secret_and_garbage() {
        let keys = Keys::new("test-secret-for-cross-check");
        assert!(keys.verify(JOSE_TOKEN).is_none(), "expired in 2023");
        let fresh = keys.sign(&claims(), 1, now());
        assert_eq!(keys.verify(&fresh).unwrap().user_id, 7);
        assert!(Keys::new("other").verify(&fresh).is_none());
        assert!(keys.verify("garbage").is_none());
    }

    #[test]
    fn renews_once_a_day_keeping_the_login_time() {
        let keys = Keys::new("s");
        let t = now();
        let fresh = keys.verify(&keys.sign(&claims(), 111, t)).unwrap();
        assert!(keys.renewed(&fresh, t + 60).is_none());
        let renewed = keys.verify(&keys.renewed(&fresh, t + SESSION_RENEW_AFTER_SECONDS).unwrap()).unwrap();
        assert_eq!((renewed.iat, renewed.auth_at), (t + SESSION_RENEW_AFTER_SECONDS, Some(111)));
    }

    fn now() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
    }

    #[test]
    fn old_tokens_without_auth_at_use_iat() {
        let keys = Keys::new("s");
        let mut c = claims();
        c.iat = now();
        c.exp = Some(c.iat + 60);
        let token = encode(&Header { typ: None, ..Header::new(Algorithm::HS256) }, &c, &EncodingKey::from_secret(b"s")).unwrap();
        assert_eq!(keys.verify(&token).unwrap().auth_at, Some(c.iat));
    }

    #[test]
    fn reads_one_cookie_among_many() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "a=1; homeshare_group=3; homeshare_session=tok".parse().unwrap());
        assert_eq!(read_cookie(&headers, GROUP_COOKIE), Some("3"));
        assert_eq!(read_cookie(&headers, SESSION_COOKIE), Some("tok"));
        assert_eq!(read_cookie(&headers, "missing"), None);
    }
}
