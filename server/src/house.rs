//! requireActiveGroup (ADR 0002): the `homeshare_group` cookie is only a preference; active membership
//! (leftAt null) in the database decides, falling back to the oldest house. Never from the body.

use crate::{
    auth::{read_cookie, Claims, Session, GROUP_COOKIE},
    db::Cached,
    errors::ApiError,
    AppState,
};
use axum::{
    extract::{FromRef, FromRequestParts},
    http::{request::Parts, StatusCode},
};

pub struct ActiveHouse {
    pub session: Claims,
    pub group_id: i32,
    pub is_admin: bool,
}

impl<S> FromRequestParts<S> for ActiveHouse
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<ActiveHouse, ApiError> {
        let Session(session) = Session::from_request_parts(parts, state).await?;
        // JS `Number(cookie) || null`: a non-numeric or zero cookie means no preference.
        let preferred = read_cookie(&parts.headers, GROUP_COOKIE).and_then(|v| v.trim().parse::<f64>().ok());
        let db = AppState::from_ref(state).pool.get().await.map_err(|e| ApiError::internal("Internal server error", e))?;
        let rows = db
            .cq(
                r#"SELECT "groupId", "role"::text FROM "GroupMember" WHERE "userId" = $1 AND "leftAt" IS NULL ORDER BY "createdAt" ASC"#,
                &[&(session.user_id as i32)],
            )
            .await
            .map_err(|e| ApiError::internal("Internal server error", e))?;
        let memberships: Vec<(i32, String)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
        let Some(first) = memberships.first() else {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "You are not a member of any house yet", "NO_GROUP"));
        };
        let (group_id, role) = memberships.iter().find(|(g, _)| Some(*g as f64) == preferred).unwrap_or(first);
        Ok(ActiveHouse { session, group_id: *group_id, is_admin: role == "ADMIN" })
    }
}
