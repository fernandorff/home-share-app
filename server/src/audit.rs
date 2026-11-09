//! Audit trail, same rows the Prisma extension writes (ADR 0005, 0009, 0012; src/lib/prisma-audit.ts):
//! one EntityRevision per written row with its post-state (CREATE/UPDATE) or final state (DELETE), secrets
//! stripped and replaced by `<field>Changed: true` when an update sets them. Here the revision is written in
//! the same transaction as the change, so it can never be lost (the extension writes it after the response).
//! Also the house activity feed (AuditLog), what `recordActivity` writes.

use serde_json::{Map, Value};
use deadpool_postgres::GenericClient;

/// A join code grants entry to a house; auth/p256dh are push keys; password is a hash. Never in a snapshot.
const SENSITIVE: [&str; 4] = ["password", "joinCode", "auth", "p256dh"];

/// sanitize(): drop the sensitive keys at any depth.
pub fn sanitize(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(sanitize).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter().filter(|(k, _)| !SENSITIVE.contains(&k.as_str())).map(|(k, v)| (k, sanitize(v))).collect(),
        ),
        other => other,
    }
}

/// changeMarkers(): `<field>Changed: true` for each sensitive field the update's own data sets.
pub fn markers(fields_set: &[&str]) -> Map<String, Value> {
    fields_set.iter().filter(|f| SENSITIVE.contains(f)).map(|f| (format!("{f}Changed"), Value::Bool(true))).collect()
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Action {
    Create,
    Update,
    Delete,
}

pub struct Revision<'a> {
    pub entity_type: &'a str,
    pub entity_id: String,
    pub group_id: Option<i32>,
    pub action: Action,
    /// None for the system (scheduled jobs) — never attributed to a person.
    pub actor_id: Option<i32>,
    /// The row as the API returns it (with the relations the service includes).
    pub row: Value,
    /// Sensitive fields an UPDATE sets (for the markers).
    pub fields_set: &'a [&'a str],
}

pub async fn record(db: &impl GenericClient, r: Revision<'_>) -> Result<(), tokio_postgres::Error> {
    let row = sanitize(r.row);
    let (action, before, after) = match r.action {
        Action::Create => ("CREATE", None, Some(row)),
        Action::Update => {
            let mut after = row.as_object().cloned().unwrap_or_default();
            after.extend(markers(r.fields_set));
            ("UPDATE", None, Some(Value::Object(after)))
        }
        Action::Delete => ("DELETE", Some(row), None),
    };
    db.execute(
        r#"INSERT INTO "EntityRevision" ("entityType", "entityId", "groupId", "action", "actorId", "before", "after")
           VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        &[&r.entity_type, &r.entity_id, &r.group_id, &action, &r.actor_id, &before, &after],
    )
    .await?;
    Ok(())
}

pub struct Activity<'a> {
    pub group_id: i32,
    pub actor_id: Option<i32>,
    pub entity_type: &'a str,
    pub entity_id: Option<String>,
    pub action: &'a str,
    pub summary: String,
    pub changes: Option<Value>,
}

/// recordActivity: a failure here never fails the user's write, so it is logged and swallowed.
pub async fn activity(db: &impl GenericClient, a: Activity<'_>) {
    let result = db
        .execute(
            r#"INSERT INTO "AuditLog" ("groupId", "actorId", "entityType", "entityId", "action", "summary", "changes")
               VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
            &[&a.group_id, &a.actor_id, &a.entity_type, &a.entity_id, &a.action, &a.summary, &a.changes],
        )
        .await;
    if let Err(e) = result {
        eprintln!("audit log failed ({}): {e}", a.entity_type);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_secrets_at_any_depth() {
        let row = json!({ "id": 1, "joinCode": "ABC", "members": [{ "user": { "password": "h", "name": "Ana" } }] });
        assert_eq!(sanitize(row), json!({ "id": 1, "members": [{ "user": { "name": "Ana" } }] }));
    }

    #[test]
    fn marks_only_sensitive_fields_that_changed() {
        let m = markers(&["joinCode", "name"]);
        assert_eq!(Value::Object(m), json!({ "joinCodeChanged": true }));
        assert!(markers(&["name"]).is_empty());
    }
}
