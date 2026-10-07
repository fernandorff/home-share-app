import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import en from "@/messages/en.json";

// The Recurring UI is client-only and fetches in effects (no DOM environment here), so pin its contracts on
// the source, like the other page-level tests (spec 008, tasks 18–19).
const FILES = {
  form: "src/components/recurring/RecurringExpenseFormModal.tsx",
  card: "src/components/recurring/RecurringRuleCard.tsx",
  page: "src/app/(app)/recurring/page.tsx",
  nav: "src/components/app/navigation.tsx",
  expenses: "src/app/(app)/expenses/page.tsx",
  detail: "src/components/expenses/ExpenseDetailModal.tsx",
} as const;
const read = (path: string) => (existsSync(join(process.cwd(), path)) ? readFileSync(join(process.cwd(), path), "utf8") : "");
const form = read(FILES.form);
const card = read(FILES.card);
const page = read(FILES.page);
const nav = read(FILES.nav);

type Tree = { [key: string]: string | Tree };
function has(tree: Tree, path: string): boolean {
  let node: string | Tree | undefined = tree;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || !(part in node)) return false;
    node = node[part];
  }
  return typeof node === "string";
}

/** Every literal `t("key")` / `t.rich("key")` of a file, resolved against the namespace its translator reads. */
function missingKeys(source: string): string[] {
  const namespaces = new Map(
    [...source.matchAll(/const (\w+) = useTranslations\("([\w.]+)"\)/g)].map((m) => [m[1], m[2]] as const)
  );
  const missing: string[] = [];
  for (const [name, namespace] of namespaces) {
    for (const m of source.matchAll(new RegExp(`\\b${name}(?:\\.rich)?\\(\\s*"([^"]+)"`, "g"))) {
      const path = `${namespace}.${m[1]}`;
      if (!has(en as unknown as Tree, path)) missing.push(path);
    }
  }
  return missing;
}

describe("every UI text comes from the messages (en has each key the files read)", () => {
  it.each(Object.entries(FILES))("%s", (_, path) => {
    const source = read(path);
    expect(source).not.toBe("");
    expect(missingKeys(source)).toEqual([]);
  });
});

describe("rule form (task 18)", () => {
  // The bodies themselves (timezone + house guard on create; lock token, never `paused`/`timezone` on edit) are
  // behavior-tested in recurring-view.test.ts › buildRuleBody; here only that the form sends what it builds.
  it("create and edit send the body buildRuleBody makes, to the rule routes", () => {
    expect(form).toContain('api.post<RecurringSaveResponse>("/api/recurring-expenses", buildRuleBody(');
    expect(form).toContain('mode: "create"');
    expect(form).toContain("timezone: browserTimeZone()");
    expect(form).toContain("api.patch<RecurringSaveResponse>(");
    expect(form).toContain("`/api/recurring-expenses/${rule.publicId}`");
    expect(form).toContain('mode: "edit", groupId: activeGroup?.id, lockToken');
    expect(form).not.toContain("type SaveResponse");
  });

  it("a stale save (409) offers loading the latest version instead of failing again, and focus moves to it", () => {
    expect(form).toContain('err.code === "STALE_RECURRING_EXPENSE"');
    expect(form).toContain('te("loadLatest")');
    expect(form).toContain('id="rec-load-latest"');
    expect(form).toContain('if (staleError) document.getElementById("rec-load-latest")?.focus();');
  });

  it("after Load latest reseeds the form, focus returns to the first field (the button unmounts)", () => {
    const load = form.slice(form.indexOf("async function loadLatest"), form.indexOf("// Load latest is the only useful action"));
    expect(load).toContain("reseeded.current = true;");
    expect(form).toContain('else if (reseeded.current) {');
    expect(form).toContain('document.getElementById("rec-desc")?.focus();');
  });

  it("errors are translated, and a field's own error sits under that field (U11)", () => {
    expect(form).toContain("apiErr(err, t(\"saveError\"))");
    expect(form).toContain("fieldForErrorCode(");
    expect(form.match(/error=\{fieldErrors\.\w+\}/g)?.length).toBeGreaterThanOrEqual(3);
    // The split is a group of buttons, not one control: its error is wired by hand.
    expect(form).toContain("{fieldErrors.split}");
  });

  it("a rule deleted elsewhere (404) or no longer the viewer's (403) closes the form and reloads the list", () => {
    expect(form).toContain("closesOnError(err.code)");
    const branch = form.slice(form.indexOf("closesOnError(err.code)"));
    expect(branch.indexOf("onOpenChange(false)")).toBeGreaterThan(-1);
    expect(branch.indexOf("onChanged()")).toBeGreaterThan(-1);
  });

  it("closing a filled form asks first (✕, overlay, Escape and both Cancels go through requestClose)", () => {
    expect(form).toContain("ruleFormDirty(pristine, values)");
    expect(form).toContain("onOpenChange={(o) => !o && requestClose()}");
    expect(form.match(/onClick=\{requestClose\}/g)).toHaveLength(2);
    expect(form).not.toContain("onClick={() => onOpenChange(false)}");
    for (const key of ['te("discardTitle")', 'te("discardPrompt")', 'te("discardChanges")', 'te("keepEditing")']) expect(form).toContain(key);
    // Load latest reseeds the baseline too, so the reloaded version is not "unsaved changes".
    expect(form).toContain("setPristine(next)");
  });

  it("one Cancel label in both footers", () => {
    expect(form).not.toContain('tc("cancel")');
    expect(form.match(/\{t\("form\.cancel"\)\}/g)).toHaveLength(2);
  });

  it("day stepper: − / + with their own labels, a live value and the clamp hint", () => {
    expect(form).toContain('aria-label={t("form.dayDecrease")}');
    expect(form).toContain('aria-label={t("form.dayIncrease")}');
    expect(form).toContain("stepDay(day, -1)");
    expect(form).toContain("stepDay(day, 1)");
    expect(form).toContain("t(dayHintKey(day), { day })");
    expect(form).toContain('role="group"');
  });

  it("the steppers stay focusable at 1 and 31 (aria-disabled; stepDay already clamps)", () => {
    expect(form).toContain("aria-disabled={day <= DAY_MIN}");
    expect(form).toContain("aria-disabled={day >= DAY_MAX}");
    expect(form).not.toMatch(/(?<!-)\bdisabled=\{day/);
  });

  it("the split is a labelled group, not a <label> without a control", () => {
    expect(form).toMatch(/role="group"\s+aria-labelledby="rec-split-label"/);
    expect(form).toContain('aria-describedby={fieldErrors.split ? "rec-split-error" : undefined}');
    expect(form).toContain('id="rec-split-label"');
    expect(form).not.toContain('<Field label={t("form.split")}');
  });

  it("the preview names an existing rule's next posting, and nothing while it is paused", () => {
    expect(form).toContain("previewPostingKey(rule ? base : null)");
    expect(form).toContain('t("pausedNothing")');
  });

  it("split modes ALL / SELECTED, and the live preview from the shared helpers", () => {
    expect(form).toContain('setSplitMode("ALL")');
    expect(form).toContain('setSplitMode("SELECTED")');
    expect(form).toContain("previewFirstPosting(");
    expect(form).toContain("equalShareCents(");
    expect(form).toContain('aria-live="polite"');
  });

  it("description limit like the expense form", () => {
    expect(form).toContain("maxLength={LIMITS.DESCRIPTION}");
  });
});

describe("rule card (task 19)", () => {
  it("money-moving actions only for the payer or an admin", () => {
    expect(card).toContain("rule.canManage &&");
    expect(card).toContain('t("actionsFor", { name: rule.description })');
  });

  it("skip ↔ undo targets the next period; pause ↔ resume", () => {
    expect(card).toContain('t("skipMonth", { month: monthName(next.period, locale) })');
    expect(card).toContain('t("undoSkip")');
    expect(card).toContain('t("pause")');
    expect(card).toContain('t("resume")');
  });

  it("status line covers the member-left pause", () => {
    expect(card).toContain('t("pausedMemberLeft")');
  });

  it("a rule paused because a member left offers Edit, not a Resume that can only fail", () => {
    const actions = card.slice(card.indexOf("rule.canManage &&"));
    expect(actions).toContain('status.kind === "memberLeft" ? (');
    expect(actions.indexOf("onClick={onEdit}")).toBeGreaterThan(-1);
  });

  it("a member-left pause offers Resume again once an edit replaced the people (status from the active members)", () => {
    expect(card).toContain("ruleStatus(rule, new Set(members.filter((m) => m.active).map((m) => m.id)))");
  });

  it("each card action is described by its rule's name (every card reads \"Skip November\")", () => {
    expect(card).toContain("<span id={titleId}");
    const actions = card.slice(card.indexOf("rule.canManage &&"), card.indexOf("<Menu"));
    expect(actions.match(/aria-describedby=\{titleId\}/g)).toHaveLength(4);
  });

  it("the viewer as payer has its own sentence (\"paid by you\", not \"paid by You\")", () => {
    expect(card).toContain('t("everyDayYou", { day: rule.dayOfMonth })');
    expect(card).not.toContain('t("you")');
  });

  it("only the title and the amount share the top row; the payer line spans the card", () => {
    const top = card.indexOf("<Money value={rule.amount}");
    const line = card.indexOf("{payerLine}");
    expect(top).toBeGreaterThan(-1);
    // The payer line comes after the row holding the amount has closed.
    expect(line).toBeGreaterThan(top);
    expect(card.slice(top, line)).toContain("</div>");
  });
});

describe("Recurring page (task 19)", () => {
  it("three real tabs", () => {
    expect(page).toContain('role="tablist"');
    expect(page).toContain('role="tab"');
    expect(page).toContain("aria-selected=");
    expect(page).toContain('role="tabpanel"');
    for (const tab of ['t("tabs.rules")', 't("tabs.upcoming")', 't("tabs.posted")']) expect(page).toContain(tab);
  });

  it("tab panels are focusable even when they hold nothing focusable (WAI-ARIA tabs)", () => {
    expect(page.match(/role="tabpanel"[^>]*tabIndex=\{0\}/g)).toHaveLength(3);
  });

  it("a rule deleted elsewhere closes the delete dialog (the list reloads)", () => {
    const confirm = page.slice(page.indexOf("async function confirmDelete"));
    expect(confirm).toContain("if (e instanceof ApiError && closesOnError(e.code)) setDeleteTarget(null);");
  });

  it("your share is bold inside the translated sentence (rich text, no slot split)", () => {
    expect(page).toContain('t.rich("yourShare", {');
    expect(page).not.toContain("SLOT");
    expect(page).not.toContain("\uE000");
  });

  it("each Upcoming action names its rule (same-month rows would all read \"Skip November\")", () => {
    expect(page).toContain("aria-describedby={descriptionId}");
    expect(page).toContain("id={descriptionId}");
  });

  it("delete asks first: question title, statement body closed by the irreversibility sentence", () => {
    expect(en.Recurring.deleteTitle.endsWith("?")).toBe(true);
    const body = page.slice(page.indexOf('t("deleteBody")'));
    expect(page).toContain('title={t("deleteTitle")}');
    expect(body.indexOf('te("deleteUndoNote")')).toBeGreaterThan(-1);
    expect(en.Expenses.deleteUndoNote).toBe("This action cannot be undone.");
  });

  it("pause/resume and skip/unskip through the rule routes", () => {
    expect(page).toContain("{ paused, expectedGroupId: activeGroup?.id }");
    expect(page).toContain("/skips/${period}");
  });

  it("a posting made right away is named in the toast", () => {
    expect(page).toContain('t("toast.resumedPostedToday"');
    expect(form).toContain('t("toast.createdPostedToday"');
  });

  it("loading skeletons and staggered entrances", () => {
    expect(page).toContain("<SkeletonRows");
    expect(page).toContain("revealDelay(");
    expect(page).toContain("upcomingAcrossRules(");
  });
});

describe("navigation entry (task 19)", () => {
  it("Recurring sits right after Expenses (sidebar and drawer read the same list)", () => {
    const expenses = nav.indexOf('{ href: "/expenses", key: "expenses"');
    const recurring = nav.indexOf('{ href: "/recurring", key: "recurring", Icon: RepeatIcon }');
    const balances = nav.indexOf('{ href: "/balances", key: "balances"');
    expect(expenses).toBeGreaterThan(-1);
    expect(recurring).toBeGreaterThan(expenses);
    expect(balances).toBeGreaterThan(recurring);
  });
});

describe("recurring marker on expenses (criterion 23)", () => {
  it("list rows show ↻ with an accessible name", () => {
    const expenses = read(FILES.expenses);
    expect(expenses).toContain("e.recurringExpenseId != null");
    expect(expenses).toContain('aria-label={t("recurringBadge")}');
    // desktop row, mobile card and the by-person table all render it
    expect(expenses.match(/<RecurringMark /g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("the row and card buttons describe themselves with the ↻ (a button's inner role=img is not read)", () => {
    const expenses = read(FILES.expenses);
    expect(expenses.match(/<RecurringMark expense=\{e\} id=\{recurringId\}/g)).toHaveLength(2);
    expect(expenses).toContain("aria-describedby={selectionMode || e.recurringExpenseId == null ? undefined : recurringId}");
    expect(expenses).toContain("aria-describedby={e.recurringExpenseId == null ? undefined : recurringId}");
  });

  it("the card's ↻ sits outside the 3-line clamp, so a long title never hides it", () => {
    const expenses = read(FILES.expenses);
    const clamp = expenses.indexOf('<span className="line-clamp-3');
    const closing = expenses.indexOf("</span>", clamp);
    const mark = expenses.indexOf("<RecurringMark", clamp);
    expect(clamp).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(closing);
  });

  it("the detail says it was created by a rule", () => {
    const detail = read(FILES.detail);
    expect(detail).toContain("expense.recurringExpenseId != null");
    expect(detail).toContain('t("recurringDetail")');
  });

  // E5: the detail's history names the system actor of a posting through the shared rule (actorLabelKey).
  it("the detail's history names a recurring posting's actor \"Automatic\" through actorLabelKey", () => {
    const detail = read(FILES.detail);
    const auditDiff = read("src/lib/audit-diff.ts");
    expect(detail).toContain('const tact = useTranslations("Activity")');
    expect(detail).toContain('e.actorLabel === "automatic" ? tact("automatic") : t("history.someone")');
    expect(detail).toContain("buildExpenseHistory(");
    expect(auditDiff).toContain("import { actorLabelKey } from './activity-format'");
    expect(auditDiff).toContain("actorLabelKey({ actorId: r.actorId, entityType: 'Expense', action, after: r.after })");
  });
});
