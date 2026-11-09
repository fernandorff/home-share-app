//! GET /api/health, same bodies as src/app/api/health/route.ts. `?db=1` also round-trips the database.

use crate::AppState;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct Params {
    db: Option<String>,
}

pub async fn get(State(state): State<AppState>, Query(params): Query<Params>) -> (StatusCode, Json<Value>) {
    if params.db.as_deref() != Some("1") {
        return (StatusCode::OK, Json(json!({ "ok": true, "service": "home-share" })));
    }
    let alive = match state.pool.get().await {
        Ok(db) => db.simple_query("SELECT 1").await.is_ok(),
        Err(_) => false,
    };
    if alive {
        (StatusCode::OK, Json(json!({ "ok": true, "service": "home-share", "db": true })))
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "ok": false, "service": "home-share", "db": false })))
    }
}
