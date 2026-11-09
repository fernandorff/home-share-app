//! notificationService.create (spec 009): one notice per recipient, never to the actor, only to active members
//! who did not turn the type off; a duplicate dedupe key is skipped. Like notifySafely, a failure is logged and
//! never fails the action that caused it.

use crate::AppState;
use serde_json::Value;

pub async fn create(state: &AppState, group_id: i32, kind: &str, actor_id: Option<i32>, notices: Vec<(i32, Value)>) {
    if let Err(e) = insert(state, group_id, kind, actor_id, notices).await {
        eprintln!("notification failed ({kind}): {e}");
    }
}

async fn insert(state: &AppState, group_id: i32, kind: &str, actor_id: Option<i32>, notices: Vec<(i32, Value)>) -> Result<(), Box<dyn std::error::Error>> {
    let mut drafts: Vec<(i32, Value)> = Vec::new();
    for (user_id, params) in notices {
        if Some(user_id) != actor_id && !drafts.iter().any(|(u, _)| *u == user_id) {
            drafts.push((user_id, params));
        }
    }
    if drafts.is_empty() {
        return Ok(());
    }
    let db = state.pool.get().await?;
    let ids: Vec<i32> = drafts.iter().map(|(u, _)| *u).collect();
    let recipients: Vec<i32> = db
        .query(
            r#"SELECT m."userId" FROM "GroupMember" m JOIN "User" u ON u."id" = m."userId"
               WHERE m."groupId" = $1 AND m."leftAt" IS NULL AND m."userId" = ANY($2) AND u."deletedAt" IS NULL
                 AND NOT EXISTS (SELECT 1 FROM "NotificationPreference" p
                                 WHERE p."userId" = m."userId" AND p."type"::text = $3 AND p."enabled" = false)"#,
            &[&group_id, &ids, &kind],
        )
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    // Only the rows actually inserted (a duplicate dedupe key is skipped) get a push.
    let mut inserted = Vec::new();
    for (user_id, params) in drafts.into_iter().filter(|(u, _)| recipients.contains(u)) {
        let row = db
            .query_opt(
                r#"INSERT INTO "Notification" ("publicId", "userId", "groupId", "type", "actorId", "params")
                   VALUES ($1::text::uuid, $2, $3, $4::text::"NotificationType", $5, $6) ON CONFLICT DO NOTHING RETURNING "id""#,
                &[&uuid::Uuid::now_v7().to_string(), &user_id, &group_id, &kind, &actor_id, &params],
            )
            .await?;
        if row.is_some() {
            inserted.push(crate::push::NoticeRow { user_id, group_id, kind: kind.to_string(), actor_id, params });
        }
    }
    crate::push::schedule(state, inserted);
    Ok(())
}
