//! Tenant-isolation suite (spec 014): every request goes through the real router `app()` in-process, against a
//! throwaway Postgres migrated by `prisma migrate deploy`. Behind the `db-tests` feature, so plain `cargo test`
//! needs no database. One database per run: the balances cache and the rate limiter are process-wide, and every
//! test seeds its own uniquely named people and houses and cleans nothing up.

mod auth;
mod isolation;

use crate::{
    app,
    auth::{Keys, GROUP_COOKIE, SESSION_COOKIE},
    config::Config,
    AppState,
};
use axum::{
    body::{to_bytes, Body},
    http::{header, HeaderMap, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::{str::FromStr, sync::Arc};
use tokio_postgres::config::Host;
use tower::ServiceExt;

pub const SECRET: &str = "test-secret";
/// A well-formed id that matches no row: the extractors refuse before any lookup.
pub const ANY_ID: &str = "0190f4b3-7c2e-7a1b-9c3d-123456789abc";

/// Criterion 2: a local database whose name ends in `_test`, and Sentry off. Names the variable, never its value.
fn check_env(url: Option<&str>, sentry_dsn: Option<&str>) -> Result<(), &'static str> {
    if sentry_dsn.is_some_and(|v| !v.trim().is_empty()) {
        return Err("SENTRY_DSN is set: unset it, so a failing test never reports to Sentry");
    }
    let url = url.filter(|u| !u.is_empty()).ok_or("TEST_DATABASE_URL is required (a local, migrated database whose name ends in _test)")?;
    let cfg = tokio_postgres::Config::from_str(url).map_err(|_| "TEST_DATABASE_URL is not a valid Postgres URL")?;
    let local = |h: &Host| matches!(h, Host::Tcp(name) if ["localhost", "127.0.0.1", "::1"].contains(&name.as_str()));
    if cfg.get_hosts().is_empty() || !cfg.get_hosts().iter().all(local) || !cfg.get_hostaddrs().iter().all(|a| a.is_loopback()) {
        return Err("TEST_DATABASE_URL must point at localhost, 127.0.0.1 or ::1");
    }
    if !cfg.get_dbname().is_some_and(|d| d.ends_with("_test")) {
        return Err("TEST_DATABASE_URL must name a database ending in _test");
    }
    Ok(())
}

/// The router and its state, built like `main()` (no jobs, no push). Checked before any connection is opened.
pub fn server() -> (Router, AppState) {
    let url = std::env::var("TEST_DATABASE_URL").ok();
    if let Err(message) = check_env(url.as_deref(), std::env::var("SENTRY_DSN").ok().as_deref()) {
        panic!("{message}");
    }
    let url = url.unwrap_or_default();
    // Pool ≥ 2: GET /api/balances holds one connection and asks for more in parallel.
    let cfg = Config::from_env(|k| match k {
        "DATABASE_URL" => Some(url.clone()),
        "JWT_SECRET" => Some(SECRET.into()),
        "DATABASE_POOL_MAX" => Some("4".into()),
        _ => None,
    })
    .expect("test config");
    let state = AppState { pool: crate::pool(&cfg), keys: Arc::new(Keys::new(SECRET)), vapid: None };
    (app(state.clone(), "no-web-dir".into(), false), state)
}

pub struct Res {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub text: String,
    pub body: Value,
    what: String,
}

impl Res {
    #[track_caller]
    pub fn is(self, status: u16) -> Res {
        assert_eq!(self.status.as_u16(), status, "{} answered {}", self.what, self.text);
        self
    }

    /// The refusal: this status, and `expected` as the body's `code` or `error`.
    #[track_caller]
    pub fn refused(self, status: u16, expected: &str) -> Res {
        let res = self.is(status);
        assert!(res.body["code"] == expected || res.body["error"] == expected, "{} answered {}, expected {expected}", res.what, res.text);
        res
    }

    pub fn cookie(&self, name: &str) -> Option<String> {
        self.headers.get_all(header::SET_COOKIE).iter().filter_map(|v| v.to_str().ok()).find_map(|c| {
            let (k, v) = c.split(';').next()?.split_once('=')?;
            (k == name).then(|| v.to_string())
        })
    }
}

/// One request through the router; a non-null `body` goes as JSON.
pub async fn request(app: &Router, method: &str, path: &str, cookie: Option<&str>, body: Value) -> Res {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(c) = cookie {
        builder = builder.header(header::COOKIE, c);
    }
    let request = if body.is_null() {
        builder.body(Body::empty())
    } else {
        builder.header(header::CONTENT_TYPE, "application/json").body(Body::from(body.to_string()))
    };
    let response = app.clone().oneshot(request.expect("request")).await.expect("infallible router");
    let (parts, body) = response.into_parts();
    let text = String::from_utf8_lossy(&to_bytes(body, usize::MAX).await.expect("body")).into_owned();
    Res { status: parts.status, headers: parts.headers, body: serde_json::from_str(&text).unwrap_or(Value::Null), text, what: format!("{method} {path}") }
}

/// A signed-in person. `house` is the `homeshare_group` cookie sent with each request: set explicitly, never
/// picked up from answers, so who acts in which house is always visible in the test.
#[derive(Clone)]
pub struct User {
    pub id: i32,
    pub public_id: String,
    pub name: String,
    pub username: String,
    pub session: String,
    pub house: Option<i32>,
    app: Router,
}

impl User {
    pub fn in_house(&self, house: i32) -> User {
        User { house: Some(house), ..self.clone() }
    }

    pub fn cookie(&self) -> String {
        match self.house {
            Some(h) => format!("{SESSION_COOKIE}={}; {GROUP_COOKIE}={h}", self.session),
            None => format!("{SESSION_COOKIE}={}", self.session),
        }
    }

    pub async fn send(&self, method: &str, path: &str, body: Value) -> Res {
        request(&self.app, method, path, Some(&self.cookie()), body).await
    }

    pub async fn get(&self, path: &str) -> Res {
        self.send("GET", path, Value::Null).await
    }
}

/// 12 random hex characters (the tail of a v7 UUID): unique names in a shared database.
pub fn suffix() -> String {
    uuid::Uuid::now_v7().simple().to_string()[20..].to_string()
}

pub async fn register(app: &Router, who: &str, sfx: &str) -> User {
    let (name, username) = (format!("{who} {sfx}"), format!("{}_{sfx}", who.to_lowercase()));
    let body = json!({ "name": name, "username": username, "password": "pass1234word" });
    let res = request(app, "POST", "/api/auth/register", None, body).await.is(201);
    let session = res.cookie(SESSION_COOKIE).expect("session cookie");
    let user = &res.body["user"];
    User {
        id: user["id"].as_i64().expect("user id") as i32,
        public_id: user["publicId"].as_str().expect("publicId").into(),
        name,
        username,
        session,
        house: None,
        app: app.clone(),
    }
}

/// POST /api/groups: (id, publicId, joinCode).
pub async fn create_house(owner: &User, name: &str) -> (i32, String, String) {
    let res = owner.send("POST", "/api/groups", json!({ "name": name })).await.is(201);
    let g = &res.body["group"];
    (g["id"].as_i64().expect("house id") as i32, g["publicId"].as_str().expect("publicId").into(), g["joinCode"].as_str().expect("joinCode").into())
}

pub async fn join(user: &User, code: &str) {
    user.send("POST", "/api/groups/join", json!({ "code": code })).await.is(200);
}

const HOUSE_TABLES: [&str; 16] = [
    "GroupMember", "Category", "Platform", "PaymentMethod", "Expense", "ShoppingItem", "Settlement", "BalanceCredit", "BalanceDebit",
    "BalanceCategoryTotal", "BalanceMonthTotal", "GroupVersion", "RecurringExpense", "AuditLog", "EntityRevision", "Notification",
];
/// Rows without a `groupId`, reached through their parent: (table, key, parent).
const CHILD_TABLES: [(&str, &str, &str); 3] =
    [("ExpenseParticipant", "expenseId", "Expense"), ("ShoppingItemExpense", "shoppingItemId", "ShoppingItem"), ("RecurringExpenseOccurrence", "recurringExpenseId", "RecurringExpense")];

/// Every row of one house (requirements, "Terms"), each table ordered by the row's text (some have no id).
pub async fn fingerprint(state: &AppState, group_id: i32) -> Value {
    let rows = |from: String| format!("(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM {from})");
    let mut parts = vec![format!("'Group', {}", rows(r#""Group" t WHERE t."id" = $1"#.into()))];
    parts.extend(HOUSE_TABLES.iter().map(|t| format!("'{t}', {}", rows(format!(r#""{t}" t WHERE t."groupId" = $1"#)))));
    parts.extend(CHILD_TABLES.iter().map(|(t, key, parent)| {
        format!("'{t}', {}", rows(format!(r#""{t}" t WHERE t."{key}" IN (SELECT "id" FROM "{parent}" WHERE "groupId" = $1)"#)))
    }));
    let db = state.pool.get().await.expect("connection");
    db.query_one(&format!("SELECT jsonb_build_object({})", parts.join(", ")), &[&group_id]).await.expect("fingerprint").get(0)
}

/// Fails naming the tables whose rows changed since `before`.
pub async fn unchanged(state: &AppState, group_id: i32, before: &Value) {
    let now = fingerprint(state, group_id).await;
    let changed: Vec<&String> = before.as_object().expect("fingerprint").iter().filter(|(table, rows)| now[table.as_str()] != **rows).map(|(t, _)| t).collect();
    assert!(changed.is_empty(), "house {group_id} changed in {changed:?}");
}

pub struct Tag {
    pub id: String,
    pub name: String,
}

/// One house of the fixture: one row of each kind, all created by its admin with Bea in the split.
pub struct House {
    pub id: i32,
    pub public_id: String,
    pub join_code: String,
    /// In every name and description of this house, so a leak can be found by searching the text.
    pub token: String,
    pub expense: String,
    pub settlement: String,
    pub item: String,
    pub rule: String,
    /// The first upcoming month of the rule (one that may be skipped) and its `updatedAt`.
    pub rule_period: String,
    pub rule_updated_at: String,
    /// Bea's EXPENSE_NEW notice for the expense.
    pub notice: String,
    /// The house's custom `Shared` category (both houses have one; both expenses carry it).
    pub category: String,
    pub cents: i64,
}

pub struct Fixture {
    pub app: Router,
    pub state: AppState,
    /// Admin of A, member of A only.
    pub alice: User,
    /// Admin of B, member of B only.
    pub bob: User,
    /// Member of both; always sent with an explicit house cookie.
    pub bea: User,
    pub a: House,
    pub b: House,
    /// Tags only B has (none is a system default).
    pub b_category: Tag,
    pub b_platform: Tag,
    pub b_payment: Tag,
}

impl Fixture {
    /// Everything of B that must never show up in an answer to A (criterion 15).
    pub fn b_markers(&self) -> Vec<String> {
        let b = &self.b;
        let mut out = vec![b.token.clone(), b.public_id.clone(), b.join_code.clone(), b.expense.clone(), b.settlement.clone(), b.item.clone(), b.rule.clone(), b.notice.clone(), b.category.clone()];
        out.extend([&self.b_category.id, &self.b_platform.id, &self.b_payment.id, &self.bob.public_id, &self.bob.name, &self.bob.username].map(String::clone));
        out
    }
}

/// A day of the month that is not today (UTC), so creating a rule never posts an expense at once.
fn not_due_day() -> i32 {
    use chrono::Datelike;
    (chrono::Utc::now().day() as i32 % 28) + 1
}

async fn furnish(admin: &User, bea: &User, (id, public_id, join_code): (i32, String, String), token: String, cents: i64) -> House {
    let (admin, bea) = (admin.in_house(id), bea.in_house(id));
    let category = admin.send("POST", "/api/categories", json!({ "name": "Shared" })).await.is(201).body["category"]["publicId"].as_str().unwrap().to_string();
    let expense = json!({ "description": format!("groceries {token}"), "amount": cents as f64 / 100.0, "payerId": admin.id, "categories": ["Shared"] });
    let expense = admin.send("POST", "/api/expenses", expense).await.is(201).body["expense"]["publicId"].as_str().unwrap().to_string();
    let settlement = json!({ "fromUserId": bea.id, "toUserId": admin.id, "amount": 10 });
    let settlement = admin.send("POST", "/api/settlements", settlement).await.is(201).body["settlement"]["publicId"].as_str().unwrap().to_string();
    let item = admin.send("POST", "/api/shopping-items", json!({ "name": format!("milk {token}") })).await.is(201).body["item"]["publicId"].as_str().unwrap().to_string();
    admin.send("PATCH", &format!("/api/shopping-items/{item}/toggle"), Value::Null).await.is(200);
    admin.send("PUT", &format!("/api/shopping-items/{item}/expenses"), json!({ "expenseIds": [expense] })).await.is(200);
    let rule = json!({ "description": format!("rent {token}"), "amount": 50, "payerId": admin.id, "dayOfMonth": not_due_day(), "splitMode": "ALL", "timezone": "UTC" });
    let res = admin.send("POST", "/api/recurring-expenses", rule).await.is(201);
    assert_eq!(res.body["postedNow"], 0, "the fixture's rule must not post");
    let rule = &res.body["rule"];
    let notices = bea.get("/api/notifications").await.is(200);
    House {
        id,
        public_id,
        join_code,
        token,
        expense,
        settlement,
        item,
        rule: rule["publicId"].as_str().unwrap().into(),
        rule_period: rule["upcoming"][0]["period"].as_str().unwrap().into(),
        rule_updated_at: rule["updatedAt"].as_str().unwrap().into(),
        notice: notices.body["notifications"][0]["publicId"].as_str().expect("Bea's notice").into(),
        category,
        cents,
    }
}

async fn tag(admin: &User, path: &str, key: &str, name: String) -> Tag {
    let res = admin.send("POST", path, json!({ "name": name })).await.is(201);
    Tag { id: res.body[key]["publicId"].as_str().unwrap().into(), name }
}

/// Requirements, "Terms": house A (Alice admin, Bea) and house B (Bob admin, Bea), built through the API so triggers,
/// audit rows and notices are written as in production. Fingerprints are taken by the tests, after this returns.
pub async fn two_houses() -> Fixture {
    let (app, state) = server();
    let sfx = suffix();
    let alice = register(&app, "Alice", &sfx).await;
    let bob = register(&app, "Bob", &sfx).await;
    let bea = register(&app, "Bea", &sfx).await;
    let (a_token, b_token) = (format!("alpha{sfx}"), format!("bravo{sfx}"));
    let a = create_house(&alice, &format!("house {a_token}")).await;
    let b = create_house(&bob, &format!("house {b_token}")).await;
    join(&bea, &a.2).await;
    join(&bea, &b.2).await;
    let a = furnish(&alice, &bea, a, a_token, 10_000).await;
    let b = furnish(&bob, &bea, b, b_token.clone(), 7_000).await;
    let bob_b = bob.in_house(b.id);
    let b_category = tag(&bob_b, "/api/categories", "category", format!("cat-{b_token}")).await;
    let b_platform = tag(&bob_b, "/api/platforms", "platform", format!("shop-{b_token}")).await;
    let b_payment = tag(&bob_b, "/api/payment-methods", "paymentMethod", format!("pay-{b_token}")).await;
    Fixture { app, state, alice, bob, bea, a, b, b_category, b_platform, b_payment }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Guard {
    Public,
    Bearer,
    Session,
    House,
}

/// One entry per handler in `app()` (main.rs), with the extractor that guards it. `{id}` and `{period}` are
/// filled by `fill`.
pub const HANDLERS: [(&str, &str, Guard); 70] = {
    use Guard::*;
    [
        ("GET", "/api/health", Public),
        ("GET", "/api/balances", House),
        ("GET", "/api/expenses", House),
        ("POST", "/api/expenses", House),
        ("GET", "/api/expenses/{id}", House),
        ("PUT", "/api/expenses/{id}", House),
        ("DELETE", "/api/expenses/{id}", House),
        ("POST", "/api/expenses/bulk-delete", House),
        ("GET", "/api/expenses/export", House),
        ("POST", "/api/expenses/import", House),
        ("GET", "/api/expenses/{id}/history", House),
        ("GET", "/api/categories", House),
        ("POST", "/api/categories", House),
        ("DELETE", "/api/categories/{id}", House),
        ("GET", "/api/platforms", House),
        ("POST", "/api/platforms", House),
        ("DELETE", "/api/platforms/{id}", House),
        ("GET", "/api/payment-methods", House),
        ("POST", "/api/payment-methods", House),
        ("DELETE", "/api/payment-methods/{id}", House),
        ("GET", "/api/settlements", House),
        ("POST", "/api/settlements", House),
        ("DELETE", "/api/settlements/{id}", House),
        ("GET", "/api/groups", Session),
        ("POST", "/api/groups", Session),
        ("POST", "/api/groups/join", Session),
        ("POST", "/api/groups/active", Session),
        ("GET", "/api/groups/active/members", House),
        ("DELETE", "/api/groups/active/members/{id}", House),
        ("PATCH", "/api/groups/active/members/{id}", House),
        ("POST", "/api/groups/active/currency", House),
        ("POST", "/api/groups/active/regenerate-code", House),
        ("POST", "/api/groups/active/leave", House),
        ("GET", "/api/notifications", House),
        ("GET", "/api/notifications/unread-count", House),
        ("POST", "/api/notifications/test", Session),
        ("POST", "/api/notifications/read-all", House),
        ("PATCH", "/api/notifications/{id}", House),
        ("DELETE", "/api/notifications/{id}", House),
        ("GET", "/api/notification-preferences", Session),
        ("PUT", "/api/notification-preferences", Session),
        ("POST", "/api/push-subscriptions", Session),
        ("DELETE", "/api/push-subscriptions", Session),
        ("GET", "/api/recurring-expenses", House),
        ("POST", "/api/recurring-expenses", House),
        ("PATCH", "/api/recurring-expenses/{id}", House),
        ("DELETE", "/api/recurring-expenses/{id}", House),
        ("PUT", "/api/recurring-expenses/{id}/skips/{period}", House),
        ("DELETE", "/api/recurring-expenses/{id}/skips/{period}", House),
        ("GET", "/api/activity", House),
        ("GET", "/api/revisions", House),
        ("POST", "/api/auth/login", Public),
        ("POST", "/api/auth/register", Public),
        ("POST", "/api/auth/logout", Public),
        ("POST", "/api/auth/logout-all", Session),
        ("POST", "/api/auth/password", Session),
        ("GET", "/api/auth/me", Session),
        ("PATCH", "/api/auth/me", Session),
        ("DELETE", "/api/auth/me", Session),
        ("GET", "/api/auth/google", Public),
        ("GET", "/api/auth/google/callback", Public),
        ("GET", "/api/cron/recurring-expenses", Bearer),
        ("GET", "/api/cron/notifications", Bearer),
        ("GET", "/api/shopping-items", House),
        ("POST", "/api/shopping-items", House),
        ("DELETE", "/api/shopping-items/clear-purchased", House),
        ("PUT", "/api/shopping-items/{id}", House),
        ("DELETE", "/api/shopping-items/{id}", House),
        ("PATCH", "/api/shopping-items/{id}/toggle", House),
        ("PUT", "/api/shopping-items/{id}/expenses", House),
    ]
};

pub fn fill(path: &str) -> String {
    path.replace("{id}", ANY_ID).replace("{period}", "2026-12")
}

/// A JSON body for every write, a bare GET otherwise.
pub fn body_for(method: &str) -> Value {
    if method == "GET" { Value::Null } else { json!({}) }
}

/// Criterion 10: a handler added to `app()` without an entry above fails here.
#[test]
fn the_handler_list_has_one_entry_per_handler_in_app() {
    let main = include_str!("../main.rs");
    let start = main.find("pub fn app(").expect("app()");
    let end = start + main[start..].find("static_files::routes(").expect("end of the API routes");
    assert_eq!(main[start..end].matches("routes::").count(), HANDLERS.len());
}

/// Criterion 10, the other half: each public entry is a real route (the extractors check the guarded ones in auth.rs).
#[tokio::test]
async fn public_entries_are_real_routes() {
    let (app, _) = server();
    for (method, path, _) in HANDLERS.iter().filter(|h| h.2 == Guard::Public) {
        let res = request(&app, method, &fill(path), None, body_for(method)).await;
        assert!(![401, 404, 405].contains(&res.status.as_u16()), "{method} {path} answered {} {}", res.status, res.text);
    }
}

/// The fingerprint covers every table with a `groupId` column.
#[tokio::test]
async fn the_fingerprint_lists_every_house_table() {
    let (_, state) = server();
    let db = state.pool.get().await.expect("connection");
    let rows = db
        .query(r#"SELECT table_name::text FROM information_schema.columns WHERE column_name = 'groupId' AND table_schema = current_schema() ORDER BY 1"#, &[])
        .await
        .expect("columns");
    let mut found: Vec<String> = rows.iter().map(|r| r.get(0)).collect();
    let mut listed: Vec<String> = HOUSE_TABLES.iter().map(|t| t.to_string()).collect();
    found.sort();
    listed.sort();
    assert_eq!(found, listed);
}

/// Criterion 2.
#[test]
fn refuses_a_database_that_is_not_a_local_test_one() {
    let ok = Some("postgresql://u:p@localhost:5432/homeshare_test");
    assert_eq!(check_env(ok, None), Ok(()));
    assert_eq!(check_env(Some("postgresql://u:p@[::1]:5432/x_test"), None), Ok(()));
    assert_eq!(check_env(Some("postgresql://u:p@127.0.0.1/x_test"), Some("")), Ok(()));
    let refused = [
        check_env(None, None),
        check_env(Some("postgresql://u:p@db.example.com/homeshare_test"), None),
        check_env(Some("postgresql://u:p@localhost:5432/homeshare_dev"), None),
        check_env(Some("postgresql://u:p@localhost:5432/shadow"), None),
        check_env(ok, Some("https://key@sentry.example/1")),
    ];
    for r in refused {
        let message = r.expect_err("refused");
        assert!(!message.contains("u:p@"), "{message}");
    }
    assert!(check_env(ok, Some("https://key@sentry.example/1")).unwrap_err().starts_with("SENTRY_DSN"));
    assert!(check_env(None, None).unwrap_err().starts_with("TEST_DATABASE_URL"));
}
