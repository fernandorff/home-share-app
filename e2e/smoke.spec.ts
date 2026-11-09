import { expect, test, type APIRequestContext } from "@playwright/test";

// One house seeded through the real API, then the main screens driven through the UI.
// Usernames are unique per run, so the test can rerun against the same database.
const run = Date.now().toString(36);
const PASSWORD = "e2e-password-123";
const owner = { name: "E2E Owner", username: `e2e-owner-${run}`, password: PASSWORD };
const member = { name: "E2E Member", username: `e2e-member-${run}`, password: PASSWORD };

async function post(api: APIRequestContext, path: string, data: unknown) {
  const res = await api.post(path, { data });
  expect(res.ok(), `${path} → ${res.status()} ${await res.text()}`).toBe(true);
  return res.json();
}

test.beforeAll(async ({ playwright, baseURL }) => {
  const a = await playwright.request.newContext({ baseURL });
  const b = await playwright.request.newContext({ baseURL });
  await post(a, "/api/auth/register", owner);
  await post(b, "/api/auth/register", member);
  const created = await post(a, "/api/groups", { name: `E2E House ${run}` });
  await post(b, "/api/groups/join", { code: created.group?.joinCode ?? created.joinCode });
  const me = (await (await a.get("/api/auth/me")).json()).user;
  const other = (await (await b.get("/api/auth/me")).json()).user;
  await post(a, "/api/expenses", {
    description: "Seeded groceries", amount: 100, date: new Date().toLocaleDateString("en-CA"), // local YYYY-MM-DD
    payerId: me.id, splitEqually: true, participants: [{ userId: me.id }, { userId: other.id }],
  });
  await post(a, "/api/shopping-items", { name: "Seeded milk" });
  await a.dispose();
  await b.dispose();
});

test("login, expenses, new expense, balances and shopping", async ({ page }) => {
  const failed: string[] = [];
  page.on("response", (r) => { if (r.status() >= 500) failed.push(`${r.status()} ${r.url()}`); });
  page.on("pageerror", (e) => failed.push(`pageerror: ${e.message}`));

  await page.goto("/auth/login");
  await page.locator("#username").fill(owner.username);
  await page.locator("#password").fill(owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/expenses/);
  await expect(page.getByText("Seeded groceries").first()).toBeVisible();

  await page.getByRole("button", { name: "New expense" }).first().click();
  await page.locator("#exp-desc").fill("E2E dinner");
  await page.locator("#exp-amount").fill("42.50");
  await page.getByRole("dialog").getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("E2E dinner").first()).toBeVisible();

  await page.locator('a[href="/balances"]').first().click();
  await expect(page).toHaveURL(/\/balances/);
  await expect(page.getByText(member.name).first()).toBeVisible();

  await page.locator('a[href="/shopping"]').first().click();
  await expect(page).toHaveURL(/\/shopping/);
  await expect(page.getByText("Seeded milk").first()).toBeVisible();

  expect(failed).toEqual([]);
});
