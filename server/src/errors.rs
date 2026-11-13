//! API errors as the client expects them (criterion 3): `{ error, code? }` with the same status and `code` as
//! the Next routes, so `useApiError` keeps translating them (namespaces ApiErrors / CsvErrors).

use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::borrow::Cow;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: Cow<'static, str>,
    pub code: Option<&'static str>,
    /// Extra headers the error must carry (e.g. clearing a revoked session cookie).
    pub set_cookie: Option<&'static str>,
}

impl ApiError {
    pub const fn new(status: StatusCode, message: &'static str, code: &'static str) -> ApiError {
        ApiError { status, message: Cow::Borrowed(message), code: Some(code), set_cookie: None }
    }

    /// An error the Next route answers without a `code` (a plain NextResponse.json({ error })).
    pub fn plain(status: StatusCode, message: impl Into<Cow<'static, str>>) -> ApiError {
        ApiError { status, message: message.into(), code: None, set_cookie: None }
    }

    /// An unexpected failure: logged, answered with the route's generic message and no detail.
    pub fn internal(message: &'static str, error: impl std::fmt::Display) -> ApiError {
        crate::observability::report(message, &error, 500, None);
        ApiError::plain(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
}

/// Parses a request body as JSON; a malformed body is the caller's mistake (400), not a server failure.
pub fn json_body(bytes: &[u8]) -> Result<serde_json::Value, ApiError> {
    serde_json::from_slice(bytes).map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Request body is not valid JSON", "INVALID_JSON"))
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = match self.code {
            Some(code) => json!({ "error": self.message, "code": code }),
            None => json!({ "error": self.message }),
        };
        let mut response = (self.status, axum::Json(body)).into_response();
        if let Some(cookie) = self.set_cookie {
            response.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_static(cookie));
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_json_body_is_a_400_with_a_code() {
        let err = json_body(b"{bad").unwrap_err();
        assert_eq!((err.status, err.code), (StatusCode::BAD_REQUEST, Some("INVALID_JSON")));
        assert_eq!(json_body(b"{\"a\":1}").unwrap()["a"], 1);
    }
}
