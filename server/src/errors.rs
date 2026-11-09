//! API errors as the client expects them (criterion 3): `{ error, code? }` with the same status and `code` as
//! the Next routes, so `useApiError` keeps translating them (namespaces ApiErrors / CsvErrors).

use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: &'static str,
    pub code: Option<&'static str>,
    /// Extra headers the error must carry (e.g. clearing a revoked session cookie).
    pub set_cookie: Option<&'static str>,
}

impl ApiError {
    pub const fn new(status: StatusCode, message: &'static str, code: &'static str) -> ApiError {
        ApiError { status, message, code: Some(code), set_cookie: None }
    }

    /// An unexpected failure: logged, answered with the route's generic message and no detail.
    pub fn internal(message: &'static str, error: impl std::fmt::Display) -> ApiError {
        eprintln!("{message}: {error}");
        ApiError { status: StatusCode::INTERNAL_SERVER_ERROR, message, code: None, set_cookie: None }
    }
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
