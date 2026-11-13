//! Tenant isolation over the two-house fixture (criteria 11–23). Each refusal is followed by the matching request
//! from a member of the row's own house (criterion 22), after the fingerprint check; destructive ones run last.

use super::*;

fn expense(description: &str, payer: i32) -> Value {
    json!({ "description": description, "amount": 5, "payerId": payer })
}

fn rule(description: &str, payer: i32) -> Value {
    json!({ "description": description, "amount": 20, "payerId": payer, "dayOfMonth": not_due_day(), "splitMode": "ALL", "timezone": "UTC" })
}

fn with(mut body: Value, key: &str, value: Value) -> Value {
    body[key] = value;
    body
}

fn import(csv_line: &str) -> Value {
    json!({ "csv": format!("description,amount\n{csv_line},12.34") })
}

/// One refusal and its positive control: (method, path, body, status, code or message) for Alice in A, then
/// (who, path, body, status) for the member of B.
type Case<'a> = (&'static str, String, Value, u16, &'static str, &'a User, String, Value, u16);

/// A case whose positive control is the very same request.
fn same<'a>(method: &'static str, path: String, body: Value, status: u16, says: &'static str, owner: &'a User, ok: u16) -> Case<'a> {
    (method, path.clone(), body.clone(), status, says, owner, path, body, ok)
}

async fn refuse_then_allow(fx: &Fixture, cases: Vec<Case<'_>>) {
    let alice = fx.alice.in_house(fx.a.id);
    let (before_a, before_b) = (fingerprint(&fx.state, fx.a.id).await, fingerprint(&fx.state, fx.b.id).await);
    for (method, path, body, status, says, ..) in &cases {
        alice.send(method, path, body.clone()).await.refused(*status, says);
    }
    unchanged(&fx.state, fx.b.id, &before_b).await;
    unchanged(&fx.state, fx.a.id, &before_a).await;
    for (method, _, _, _, _, owner, path, body, status) in cases {
        owner.send(method, &path, body).await.is(status);
    }
}

/// Criteria 11 and 22: the 20 handlers that take a house row's id, with B's ids.
#[tokio::test]
async fn foreign_ids_in_the_path_are_not_found() {
    let fx = two_houses().await;
    let (b, bob, bea) = (&fx.b, &fx.bob.in_house(fx.b.id), &fx.bea.in_house(fx.b.id));
    let skip = format!("/api/recurring-expenses/{}/skips/{}", b.rule, b.rule_period);
    let cases = vec![
        same("GET", format!("/api/expenses/{}", b.expense), Value::Null, 404, "Expense not found", bob, 200),
        same("GET", format!("/api/expenses/{}/history", b.expense), Value::Null, 404, "Expense not found", bob, 200),
        same("PUT", format!("/api/expenses/{}", b.expense), expense("edited", fx.bob.id), 404, "Expense not found", bob, 200),
        same("PUT", format!("/api/shopping-items/{}", b.item), json!({ "name": "renamed" }), 404, "Item not found", bob, 200),
        same("PATCH", format!("/api/shopping-items/{}/toggle", b.item), Value::Null, 404, "Item not found", bob, 200),
        same("PUT", format!("/api/shopping-items/{}/expenses", b.item), json!({ "expenseIds": [] }), 404, "Item not found", bob, 200),
        same("PUT", skip.clone(), Value::Null, 404, "RECURRING_NOT_FOUND", bob, 200),
        same("DELETE", skip, Value::Null, 404, "RECURRING_NOT_FOUND", bob, 200),
        same("PATCH", format!("/api/recurring-expenses/{}", b.rule), json!({ "paused": true }), 404, "RECURRING_NOT_FOUND", bob, 200),
        same("PATCH", format!("/api/notifications/{}", b.notice), json!({ "read": true }), 404, "NOTIFICATION_NOT_FOUND", bea, 200),
        ("PATCH", format!("/api/groups/active/members/{}", fx.bob.public_id), json!({ "role": "ADMIN" }), 404, "MEMBER_NOT_FOUND",
         bob, format!("/api/groups/active/members/{}", fx.bea.public_id), json!({ "role": "ADMIN" }), 200),
        // Destructive from here on.
        same("DELETE", format!("/api/expenses/{}", b.expense), Value::Null, 404, "Expense not found", bob, 200),
        same("DELETE", format!("/api/settlements/{}", b.settlement), Value::Null, 404, "Payment not found in this house", bob, 200),
        same("DELETE", format!("/api/categories/{}", b.category), Value::Null, 404, "Category not found", bob, 200),
        same("DELETE", format!("/api/platforms/{}", fx.b_platform.id), Value::Null, 404, "Platform not found", bob, 200),
        same("DELETE", format!("/api/payment-methods/{}", fx.b_payment.id), Value::Null, 404, "Payment method not found", bob, 200),
        same("DELETE", format!("/api/shopping-items/{}", b.item), Value::Null, 404, "Item not found", bob, 200),
        same("DELETE", format!("/api/recurring-expenses/{}", b.rule), Value::Null, 404, "RECURRING_NOT_FOUND", bob, 200),
        same("DELETE", format!("/api/notifications/{}", b.notice), Value::Null, 404, "NOTIFICATION_NOT_FOUND", bea, 200),
        // Bob's member controls target Bea: promoting himself writes nothing, removing himself is CANNOT_REMOVE_SELF.
        ("DELETE", format!("/api/groups/active/members/{}", fx.bob.public_id), Value::Null, 404, "MEMBER_NOT_FOUND",
         bob, format!("/api/groups/active/members/{}", fx.bea.public_id), Value::Null, 200),
    ];
    assert_eq!(cases.len(), 20);
    refuse_then_allow(&fx, cases).await;
}

/// Criteria 12 and 22: B's people, tags and expenses inside a body.
#[tokio::test]
async fn foreign_people_tags_and_expenses_in_the_body_are_refused() {
    let fx = two_houses().await;
    let (a, b, bob) = (&fx.a, &fx.b, &fx.bob.in_house(fx.b.id));
    let (alice_id, bob_id, bea_id) = (fx.alice.id, fx.bob.id, fx.bea.id);
    let not_member = "Payer or participant is not a member of this house";
    let split = |x: i32, y: i32| with(with(expense("split", x), "splitEqually", json!(false)), "participants", json!([{ "userId": x, "amount": 2.5 }, { "userId": y, "amount": 2.5 }]));
    let tagged = |payer: i32, key: &str, tag: &str| with(expense("tagged", payer), key, json!([tag]));
    let (cat, shop, pay) = (fx.b_category.name.as_str(), fx.b_platform.name.as_str(), fx.b_payment.name.as_str());
    let csv = |payer: Value, platform: Value| with(with(import("imported"), "payerId", payer), "platform", platform);
    let cases: Vec<Case> = vec![
        ("POST", "/api/expenses".into(), expense("x", bob_id), 400, not_member, bob, "/api/expenses".into(), expense("x", bob_id), 201),
        ("POST", "/api/expenses".into(), split(alice_id, bob_id), 400, not_member, bob, "/api/expenses".into(), split(bob_id, bea_id), 201),
        ("POST", "/api/expenses".into(), tagged(alice_id, "categories", cat), 400, "INVALID_CATEGORY", bob, "/api/expenses".into(), tagged(bob_id, "categories", cat), 201),
        ("POST", "/api/expenses".into(), tagged(alice_id, "platforms", shop), 400, "INVALID_PLATFORM", bob, "/api/expenses".into(), tagged(bob_id, "platforms", shop), 201),
        ("POST", "/api/expenses".into(), tagged(alice_id, "paymentMethods", pay), 400, "INVALID_PAYMENT", bob, "/api/expenses".into(), tagged(bob_id, "paymentMethods", pay), 201),
        ("PUT", format!("/api/expenses/{}", a.expense), expense("x", bob_id), 400, not_member, bob, format!("/api/expenses/{}", b.expense), expense("x", bea_id), 200),
        ("PUT", format!("/api/expenses/{}", a.expense), tagged(alice_id, "categories", cat), 400, "INVALID_CATEGORY",
         bob, format!("/api/expenses/{}", b.expense), tagged(bob_id, "categories", cat), 200),
        ("POST", "/api/settlements".into(), json!({ "fromUserId": bob_id, "toUserId": alice_id, "amount": 5 }), 400, "Payer or recipient is not a member of this house",
         bob, "/api/settlements".into(), json!({ "fromUserId": bob_id, "toUserId": bea_id, "amount": 5 }), 201),
        ("POST", "/api/recurring-expenses".into(), rule("x", bob_id), 400, "RECURRING_MEMBER_INACTIVE", bob, "/api/recurring-expenses".into(), rule("x", bob_id), 201),
        ("PATCH", format!("/api/recurring-expenses/{}", a.rule), json!({ "payerId": bob_id, "expectedUpdatedAt": a.rule_updated_at }), 400, "RECURRING_MEMBER_INACTIVE",
         bob, format!("/api/recurring-expenses/{}", b.rule), json!({ "payerId": bea_id, "expectedUpdatedAt": b.rule_updated_at }), 200),
        ("PUT", format!("/api/shopping-items/{}/expenses", a.item), json!({ "expenseIds": [b.expense] }), 404, "EXPENSE_NOT_FOUND",
         bob, format!("/api/shopping-items/{}/expenses", b.item), json!({ "expenseIds": [b.expense] }), 200),
        ("POST", "/api/expenses/import".into(), csv(json!(bob_id), Value::Null), 400, "Payer is not a member of this house",
         bob, "/api/expenses/import".into(), csv(json!(bob_id), Value::Null), 201),
        ("POST", "/api/expenses/import".into(), csv(Value::Null, json!(shop)), 400, "Invalid platform", bob, "/api/expenses/import".into(), csv(Value::Null, json!(shop)), 201),
        // Destructive: last.
        ("POST", "/api/expenses/bulk-delete".into(), json!({ "publicIds": [b.expense] }), 404, "No expenses found",
         bob, "/api/expenses/bulk-delete".into(), json!({ "publicIds": [b.expense] }), 200),
    ];
    refuse_then_allow(&fx, cases).await;
}

/// Criterion 13.
#[tokio::test]
async fn a_mixed_bulk_delete_removes_only_the_own_house_rows() {
    let fx = two_houses().await;
    let alice = fx.alice.in_house(fx.a.id);
    let before = fingerprint(&fx.state, fx.b.id).await;
    let res = alice.send("POST", "/api/expenses/bulk-delete", json!({ "publicIds": [fx.a.expense, fx.b.expense] })).await.is(200);
    assert_eq!(res.body["deleted"], 1);
    unchanged(&fx.state, fx.b.id, &before).await;
    alice.get(&format!("/api/expenses/{}", fx.a.expense)).await.is(404);
    let own = fx.bob.in_house(fx.b.id).send("POST", "/api/expenses/bulk-delete", json!({ "publicIds": [fx.b.expense] })).await.is(200);
    assert_eq!(own.body["deleted"], 1);
}

/// Criteria 14 and 22: `groupId` in a body is ignored; `expectedGroupId` of another house is a 409 that writes nothing.
#[tokio::test]
async fn a_house_id_in_the_body_never_picks_the_house() {
    let fx = two_houses().await;
    let (a, alice) = (&fx.a, fx.alice.in_house(fx.a.id));
    let (before_a, before_b) = (fingerprint(&fx.state, a.id).await, fingerprint(&fx.state, fx.b.id).await);
    let links = json!({ "expenseIds": [a.expense] });
    let stale = |house: i32| {
        [
            ("POST", "/api/expenses".to_string(), with(expense("stale", alice.id), "expectedGroupId", json!(house)), 201),
            ("PUT", format!("/api/expenses/{}", a.expense), with(expense("stale", alice.id), "expectedGroupId", json!(house)), 200),
            ("POST", "/api/recurring-expenses".to_string(), with(rule("stale", alice.id), "expectedGroupId", json!(house)), 201),
            ("PATCH", format!("/api/recurring-expenses/{}", a.rule), json!({ "paused": true, "expectedGroupId": house }), 200),
            ("PUT", format!("/api/shopping-items/{}/expenses", a.item), with(links.clone(), "expectedGroupId", json!(house)), 200),
        ]
    };
    for (method, path, body, _) in stale(fx.b.id) {
        alice.send(method, &path, body).await.refused(409, "STALE_GROUP");
    }
    unchanged(&fx.state, a.id, &before_a).await;

    let group_b = json!(fx.b.id);
    let created = [
        ("/api/expenses", "expense", with(expense("lands in A", alice.id), "groupId", group_b.clone())),
        ("/api/settlements", "settlement", json!({ "fromUserId": fx.bea.id, "toUserId": alice.id, "amount": 3, "groupId": group_b })),
        ("/api/shopping-items", "item", json!({ "name": "lands in A", "groupId": group_b })),
        ("/api/categories", "category", json!({ "name": "lands-in-a", "groupId": group_b })),
    ];
    for (path, key, body) in created {
        let res = alice.send("POST", path, body).await.is(201);
        assert_eq!(res.body[key]["groupId"], a.id, "POST {path}");
    }
    let res = alice.send("POST", "/api/recurring-expenses", with(rule("lands in A", alice.id), "groupId", group_b)).await.is(201);
    let db = fx.state.pool.get().await.unwrap();
    let rule_house: i32 = db
        .query_one(r#"SELECT "groupId" FROM "RecurringExpense" WHERE "publicId" = $1::text::uuid"#, &[&res.body["rule"]["publicId"].as_str()])
        .await
        .unwrap()
        .get(0);
    assert_eq!(rule_house, a.id);
    unchanged(&fx.state, fx.b.id, &before_b).await;

    for (method, path, body, status) in stale(a.id) {
        alice.send(method, &path, body).await.is(status);
    }
}

/// Criterion 15: Alice (only in A) and Bea (in both, active in A) see A's rows only, and A's totals.
#[tokio::test]
async fn lists_and_totals_hold_only_the_active_house() {
    let fx = two_houses().await;
    let a = &fx.a;
    // B's expense is 70.00: a leak moves every total below.
    let total = crate::money::number(a.cents);
    for (viewer, notices) in [(fx.alice.in_house(a.id), 0), (fx.bea.in_house(a.id), 1)] {
        let get = |path: &'static str| {
            let viewer = viewer.clone();
            let markers = fx.b_markers();
            async move {
                let res = viewer.get(path).await.is(200);
                for m in &markers {
                    assert!(!res.text.contains(m.as_str()), "GET {path} as {} shows B's {m}: {}", viewer.name, res.text);
                }
                res.body
            }
        };
        let balances = get("/api/balances").await;
        assert_eq!(balances["totalExpenses"].to_string(), total);
        assert_eq!(balances["payments"].as_array().unwrap().len(), 1);
        let ids: Vec<i64> = balances["balances"].as_array().unwrap().iter().map(|b| b["userId"].as_i64().unwrap()).collect();
        assert!(ids.iter().all(|id| [fx.alice.id as i64, fx.bea.id as i64].contains(id)), "{balances}");

        let list = get("/api/expenses?includePayerTotals=true&includeMonthTotals=true").await;
        let pagination = &list["pagination"];
        assert_eq!((pagination["total"].as_i64(), &pagination["totalAmount"]), (Some(1), &json!(total)));
        assert_eq!(pagination["payerTotals"], json!([{ "payerId": fx.alice.id, "totalAmount": total }]));
        assert_eq!(pagination["monthTotals"].as_array().unwrap().len(), 1);
        assert_eq!(pagination["monthTotals"][0]["totalAmount"], crate::money::fixed2(a.cents));
        assert_eq!(list["expenses"][0]["publicId"], a.expense.as_str());

        let export = viewer.get("/api/expenses/export").await.is(200);
        assert!(fx.b_markers().iter().all(|m| !export.text.contains(m.as_str())), "{}", export.text);
        assert_eq!(export.text.lines().count(), 2, "{}", export.text);

        assert_eq!(get("/api/settlements").await["settlements"].as_array().unwrap().len(), 1);
        assert_eq!(get("/api/shopping-items").await["items"].as_array().unwrap().len(), 1);
        let categories = get("/api/categories?counts=true").await;
        let shared = &categories["categories"][0];
        assert_eq!(categories["categories"].as_array().unwrap().len(), 1);
        assert_eq!((&shared["publicId"], &shared["_count"]["expenses"]), (&json!(a.category), &json!(1)), "both houses tag one expense `Shared`");
        assert_eq!(get("/api/platforms").await["platforms"], json!([]));
        assert_eq!(get("/api/payment-methods").await["paymentMethods"], json!([]));
        let recurring = get("/api/recurring-expenses").await;
        assert_eq!((recurring["rules"].as_array().unwrap().len(), &recurring["summary"]["monthlyTotal"]), (1, &json!("50.00")));
        let activity = get("/api/activity").await;
        assert!(activity["entries"].as_array().unwrap().iter().all(|e| e["groupId"] == a.id), "{activity}");
        get("/api/revisions").await;
        let list = get("/api/notifications").await;
        assert_eq!((list["notifications"].as_array().unwrap().len(), list["unreadCount"].as_i64(), list["groupId"].as_i64()), (notices, Some(notices as i64), Some(a.id as i64)));
        let count = get("/api/notifications/unread-count").await;
        assert_eq!((count["count"].as_i64(), count["groupId"].as_i64()), (Some(notices as i64), Some(a.id as i64)));
        let members = get("/api/groups/active/members").await;
        assert_eq!(members["groupId"], a.id);
        let mut names: Vec<&str> = members["members"].as_array().unwrap().iter().map(|m| m["name"].as_str().unwrap()).collect();
        names.sort_unstable();
        assert_eq!(names, [fx.alice.name.as_str(), fx.bea.name.as_str()]);
    }
}

/// Criterion 17.
#[tokio::test]
async fn b_balances_stay_put_while_a_writes() {
    let fx = two_houses().await;
    let (alice, bob) = (fx.alice.in_house(fx.a.id), fx.bob.in_house(fx.b.id));
    let etag = |res: &Res| res.headers.get(header::ETAG).expect("ETag").to_str().unwrap().to_string();
    let b_before = bob.get("/api/balances").await.is(200);
    let a_before = etag(&alice.get("/api/balances").await.is(200));

    let created = alice.send("POST", "/api/expenses", expense("moves A only", alice.id)).await.is(201);
    let id = created.body["expense"]["publicId"].as_str().unwrap().to_string();
    alice.send("PUT", &format!("/api/expenses/{id}"), expense("moves A only, edited", fx.bea.id)).await.is(200);
    alice.send("DELETE", &format!("/api/expenses/{id}"), Value::Null).await.is(200);
    let paid = alice.send("POST", "/api/settlements", json!({ "fromUserId": fx.bea.id, "toUserId": alice.id, "amount": 4 })).await.is(201);
    alice.send("DELETE", &format!("/api/settlements/{}", paid.body["settlement"]["publicId"].as_str().unwrap()), Value::Null).await.is(200);

    let b_after = bob.get("/api/balances").await.is(200);
    assert_eq!((etag(&b_after), &b_after.text), (etag(&b_before), &b_before.text));
    assert_ne!(etag(&alice.get("/api/balances").await.is(200)), a_before, "A's writes must move A's version");
}

/// Criteria 16 and 22: house-wide writes in A change A only.
#[tokio::test]
async fn house_wide_writes_change_only_the_active_house() {
    let fx = two_houses().await;
    let (a, alice, bea) = (&fx.a, fx.alice.in_house(fx.a.id), fx.bea.in_house(fx.a.id));
    let before = fingerprint(&fx.state, fx.b.id).await;
    assert_eq!(alice.send("DELETE", "/api/shopping-items/clear-purchased", Value::Null).await.is(200).body["deleted"], 1);
    bea.send("POST", "/api/notifications/read-all", json!({})).await.is(200);
    alice.send("POST", "/api/groups/active/currency", json!({ "currency": "USD" })).await.is(200);
    let code = alice.send("POST", "/api/groups/active/regenerate-code", json!({})).await.is(200).body["joinCode"].clone();
    alice.send("DELETE", &format!("/api/categories/{}", a.category), Value::Null).await.is(200);
    unchanged(&fx.state, fx.b.id, &before).await;

    // B as it was, read through B's own members.
    let bob = fx.bob.in_house(fx.b.id);
    assert_eq!(bob.get(&format!("/api/expenses/{}", fx.b.expense)).await.is(200).body["expense"]["categories"], json!(["Shared"]));
    assert_eq!(fx.bea.in_house(fx.b.id).get("/api/notifications/unread-count").await.is(200).body["count"], 1);
    let houses = bob.get("/api/groups").await.is(200).body;
    assert_eq!(houses["groups"][0]["currency"], "BRL");
    // A changed.
    assert_eq!(alice.get(&format!("/api/expenses/{}", a.expense)).await.is(200).body["expense"]["categories"], json!([]));
    assert_eq!(alice.get("/api/shopping-items").await.is(200).body["items"], json!([]));
    assert_eq!(bea.get("/api/notifications/unread-count").await.is(200).body["count"], 0);
    let me = alice.get("/api/auth/me").await.is(200).body;
    assert_eq!((&me["user"]["groups"][0]["currency"], &me["user"]["groups"][0]["joinCode"]), (&json!("USD"), &code));
    assert_ne!(code, json!(a.join_code));
}

/// Criteria 18 and 22: a `homeshare_group` cookie for B is only a preference; Alice is answered as A.
#[tokio::test]
async fn a_foreign_house_cookie_falls_back_to_the_own_house() {
    let fx = two_houses().await;
    let alice = fx.alice.in_house(fx.b.id);
    let before = fingerprint(&fx.state, fx.b.id).await;
    assert_eq!(alice.get("/api/groups/active/members").await.is(200).body["groupId"], fx.a.id);
    let list = alice.get("/api/expenses").await.is(200).body;
    assert_eq!((list["pagination"]["total"].as_i64(), &list["expenses"][0]["publicId"]), (Some(1), &json!(fx.a.expense)));
    let created = alice.send("POST", "/api/expenses", expense("cookie says B", alice.id)).await.is(201);
    assert_eq!(created.body["expense"]["groupId"], fx.a.id);
    unchanged(&fx.state, fx.b.id, &before).await;
    assert_eq!(fx.bob.in_house(fx.b.id).get("/api/groups/active/members").await.is(200).body["groupId"], fx.b.id);
}

/// Criteria 19 and 22: switching needs a membership; a code that matches no house joins nothing.
#[tokio::test]
async fn switching_and_joining_need_a_real_house() {
    let fx = two_houses().await;
    let alice = fx.alice.in_house(fx.a.id);
    let before = fingerprint(&fx.state, fx.b.id).await;
    let res = alice.send("POST", "/api/groups/active", json!({ "groupId": fx.b.id })).await.refused(403, "You are not a member of this house");
    assert_eq!(res.cookie(GROUP_COOKIE), None);
    let memberships = || async {
        let db = fx.state.pool.get().await.unwrap();
        db.query_one(r#"SELECT count(*) FROM "GroupMember" WHERE "userId" = $1"#, &[&alice.id]).await.unwrap().get::<_, i64>(0)
    };
    // ponytail: a fixed code; a random house hitting it is ~1 in 10^9 per house in the run.
    alice.send("POST", "/api/groups/join", json!({ "code": "ZZZZZZ" })).await.refused(404, "INVALID_CODE");
    assert_eq!(memberships().await, 1);
    unchanged(&fx.state, fx.b.id, &before).await;

    let res = alice.send("POST", "/api/groups/active", json!({ "groupId": fx.a.id })).await.is(200);
    assert_eq!(res.cookie(GROUP_COOKIE), Some(fx.a.id.to_string()));
    alice.send("POST", "/api/groups/join", json!({ "code": fx.b.join_code })).await.is(200);
    assert_eq!(memberships().await, 2);
}

/// Criteria 20 and 22: Bea, active in A, never reaches her B notices.
#[tokio::test]
async fn notices_follow_the_active_house() {
    let fx = two_houses().await;
    let bea = fx.bea.in_house(fx.a.id);
    let before = fingerprint(&fx.state, fx.b.id).await;
    let list = bea.get("/api/notifications").await.is(200).body;
    let ids: Vec<&str> = list["notifications"].as_array().unwrap().iter().map(|n| n["publicId"].as_str().unwrap()).collect();
    assert_eq!((ids, list["unreadCount"].as_i64()), (vec![fx.a.notice.as_str()], Some(1)));
    assert_eq!(bea.get("/api/notifications/unread-count").await.is(200).body["count"], 1);
    let path = format!("/api/notifications/{}", fx.b.notice);
    bea.send("PATCH", &path, json!({ "read": true })).await.refused(404, "NOTIFICATION_NOT_FOUND");
    bea.send("DELETE", &path, Value::Null).await.refused(404, "NOTIFICATION_NOT_FOUND");
    unchanged(&fx.state, fx.b.id, &before).await;

    let bea_b = fx.bea.in_house(fx.b.id);
    bea_b.send("PATCH", &path, json!({ "read": true })).await.is(200);
    bea_b.send("DELETE", &path, Value::Null).await.is(200);
}

async fn notices_in(state: &AppState, user: i32, house: i32) -> i64 {
    let db = state.pool.get().await.unwrap();
    db.query_one(r#"SELECT count(*) FROM "Notification" WHERE "userId" = $1 AND "groupId" = $2"#, &[&user, &house]).await.unwrap().get(0)
}

/// Criteria 21 and 22: after leaving or being removed, B's ids are gone for that person, and so are their B notices.
#[tokio::test]
async fn leaving_or_removal_ends_access() {
    let fx = two_houses().await;
    let (b, bob) = (&fx.b, fx.bob.in_house(fx.b.id));
    let expense_path = format!("/api/expenses/{}", b.expense);

    // Removed, with no other house: 403 NO_GROUP.
    let cid = register(&fx.app, "Cid", &suffix()).await.in_house(b.id);
    join(&cid, &b.join_code).await;
    let shared = bob.send("POST", "/api/expenses", expense("with Cid", bob.id)).await.is(201);
    let shared_path = format!("/api/expenses/{}", shared.body["expense"]["publicId"].as_str().unwrap());
    cid.get(&shared_path).await.is(200);
    assert_eq!(notices_in(&fx.state, cid.id, b.id).await, 1);
    bob.send("DELETE", &format!("/api/groups/active/members/{}", cid.public_id), Value::Null).await.is(200);
    cid.get(&shared_path).await.refused(403, "NO_GROUP");
    assert_eq!(notices_in(&fx.state, cid.id, b.id).await, 0);

    // Left, with another house: B's ids are 404 (she is answered as A).
    let bea = fx.bea.in_house(b.id);
    bea.get(&expense_path).await.is(200);
    bea.send("POST", "/api/groups/active/leave", json!({})).await.is(200);
    bea.get(&expense_path).await.refused(404, "Expense not found");
    assert_eq!(notices_in(&fx.state, bea.id, b.id).await, 0);
    assert_eq!(notices_in(&fx.state, bea.id, fx.a.id).await, 1);
}

/// Criteria 23 and 22: unregistering an endpoint removes only the caller's row (register needs VAPID keys, so
/// Alice's row is seeded in SQL).
#[tokio::test]
async fn push_unregister_removes_only_the_callers_row() {
    let (app, state) = server();
    let sfx = suffix();
    let (alice, bob) = (register(&app, "Alice", &sfx).await, register(&app, "Bob", &sfx).await);
    let endpoint = format!("https://fcm.googleapis.com/fcm/send/{sfx}");
    let db = state.pool.get().await.unwrap();
    db.execute(r#"INSERT INTO "PushSubscription" ("userId", "endpoint", "p256dh", "auth", "updatedAt") VALUES ($1, $2, 'p', 'a', now())"#, &[&alice.id, &endpoint])
        .await
        .unwrap();
    let owners = || async { db.query(r#"SELECT "userId" FROM "PushSubscription" WHERE "endpoint" = $1"#, &[&endpoint]).await.unwrap().iter().map(|r| r.get(0)).collect::<Vec<i32>>() };
    bob.send("DELETE", "/api/push-subscriptions", json!({ "endpoint": endpoint })).await.is(200);
    assert_eq!(owners().await, [alice.id]);
    alice.send("DELETE", "/api/push-subscriptions", json!({ "endpoint": endpoint })).await.is(200);
    assert_eq!(owners().await, Vec::<i32>::new());
}

/// Removing a member: an unknown person and another house's member get the very same answer, so an admin can't
/// probe which ids exist.
#[tokio::test]
async fn removing_an_unknown_or_foreign_person_answers_the_same() {
    let fx = two_houses().await;
    let alice = fx.alice.in_house(fx.a.id);
    let unknown = alice.send("DELETE", &format!("/api/groups/active/members/{ANY_ID}"), Value::Null).await.is(404);
    let foreign = alice.send("DELETE", &format!("/api/groups/active/members/{}", fx.bob.public_id), Value::Null).await.is(404);
    assert_eq!(unknown.text, foreign.text);
}
