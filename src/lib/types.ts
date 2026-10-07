// Shared API types — mirror the verified route/service response shapes.
// NOTE: Prisma Decimal fields (expense/participant amount) serialize to STRING in JSON;
// computed balances come as number. `Money` captures both — always coerce via toNumber.

import type { NotificationType } from "@/lib/notifications";

export type Money = number | string;
export type Role = "ADMIN" | "MEMBER";

export interface PublicUser {
  id: number;
  publicId: string;
  name: string;
  username: string;
}

export interface MeGroup {
  id: number;
  publicId: string;
  name: string;
  role: Role;
  colorIndex: number;
  joinCode: string | null; // only present for ADMINs
  currency: string; // ISO 4217 (BRL | USD | EUR | GBP) — display only
  // spec 006: the user is this house's only active admin while others remain — leaving (or
  // deleting the account) is refused with LAST_ADMIN until someone else is made admin.
  lastAdmin: boolean;
}

export interface Me {
  user: {
    id: number;
    publicId: string;
    name: string;
    username: string;
    email: string | null;
    hasPassword: boolean;
    groups: MeGroup[];
  };
  activeGroupId: number | null;
}

export interface Member {
  id: number;
  publicId: string;
  name: string;
  username: string;
  role: Role;
  colorIndex: number;
  // false = ex-member (left or was removed, BL-16) — still returned (with real name/color) so
  // historical expenses/balances/activity resolve correctly; excluded from new-expense selection.
  active: boolean;
  // true = the account itself was deleted (BL-23) — name/username were scrubbed at that point.
  deleted: boolean;
}

/** A house's custom tag entry (category / platform / payment method). System defaults are not stored. */
export interface NamedTag {
  id: number;
  publicId: string;
  name: string;
  groupId: number;
  createdAt: string;
  _count?: { expenses: number };
}
export type Category = NamedTag;
export type Platform = NamedTag;
export type PaymentMethod = NamedTag;

export interface ExpenseParticipant {
  id: number;
  expenseId: number;
  userId: number;
  amount: Money;
  // Only present on create/update responses (full include); the list omits it to trim payload.
  user?: PublicUser;
}

export interface Expense {
  id: number;
  publicId: string;
  groupId: number;
  payerId: number;
  description: string;
  notes: string | null;
  // Three tag dimensions; each entry is a system-default key OR a custom name.
  categories: string[];
  platforms: string[];
  paymentMethods: string[];
  amount: Money;
  date: string;
  createdAt: string;
  updatedAt: string;
  payer: PublicUser;
  participants: ExpenseParticipant[];
  // spec 008: the recurring rule that posted this expense (null for a manual one, or after the rule
  // was deleted). Present on list and detail rows; set only by the poster, never from a request body.
  recurringExpenseId: number | null;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  // Sum of `amount` across every row matching the current filters (not just the loaded page) —
  // lets the filtered-total widget stay correct while infinite scroll has only loaded some pages.
  totalAmount: Money;
  // Opt-in aggregate used by the paged by-person view. It stays exact even while the client has
  // loaded only the first pages; omitted for ordinary list requests to avoid an extra DB query.
  payerTotals?: { payerId: number; totalAmount: Money }[];
  // Opt-in (includeMonthTotals=true, B5): exact per-month totals across the complete filtered
  // result, and the same split per payer for the by-person view.
  monthTotals?: { month: string; totalAmount: Money }[];
  payerMonthTotals?: { payerId: number; month: string; totalAmount: Money }[];
}

export interface ExpenseListResponse {
  expenses: Expense[];
  pagination: Pagination;
}

export type ExpenseSortField =
  | "date"
  | "amount"
  | "description"
  | "payer"
  | "createdAt";

export interface Balance {
  userId: number;
  userName: string;
  balance: number;
}

export interface Settlement {
  from: { id: number; name: string };
  to: { id: number; name: string };
  amount: number;
}

/** A recorded payment between two members (clears/reduces a balance). */
export interface Payment {
  publicId: string;
  fromUser: { id: number; name: string };
  toUser: { id: number; name: string };
  amount: string;
  note: string | null;
  date: string;
}

export interface CategorySpend {
  category: string;
  total: number;
}
export interface MonthSpend {
  month: string;
  total: number;
}

export interface BalancesResponse {
  balances: Balance[];
  settlements: Settlement[];
  totalExpenses: number;
  payments: Payment[];
  byCategory: CategorySpend[];
  byMonth: MonthSpend[];
}

export type AuditEntityType =
  | "EXPENSE"
  | "SETTLEMENT"
  | "SHOPPING_ITEM"
  | "GROUP"
  | "PLATFORM"
  | "CATEGORY"
  | "PAYMENT_METHOD"
  | "RECURRING_EXPENSE";
export type AuditAction = "CREATE" | "UPDATE" | "DELETE" | "CLEAR" | "PAUSE" | "RESUME" | "SKIP" | "UNSKIP";

export interface ActivityEntry {
  id: number;
  actor: { id: number; name: string } | null;
  entityType: AuditEntityType;
  entityId: string | null;
  action: AuditAction;
  summary: string;
  changes: Record<string, unknown> | null;
  createdAt: string;
}

export interface ActivityResponse {
  entries: ActivityEntry[];
  // True when the route truncated the list (more rows exist beyond ACTIVITY_SUMMARY_LIMIT) — the
  // page shows the "N most recent" notice only when this is true (fix round 1, task 13).
  hasMore: boolean;
}

/** One row of the Envers-style EntityRevision trail (post-state snapshot + who/when). */
export interface RevisionRecord {
  id: number;
  entityType: string; // Prisma model name (Expense, Settlement, …)
  entityId: string;
  action: string; // CREATE | UPDATE | DELETE
  actorId: number | null;
  actorName: string | null;
  createdAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface ExpenseHistoryResponse {
  revisions: RevisionRecord[];
}

export interface RevisionsResponse {
  revisions: RevisionRecord[];
  // R3-21: more revisions exist beyond the page (the page shows the "most recent" notice).
  hasMore: boolean;
}

export interface ShoppingItem {
  id: number;
  publicId: string;
  name: string;
  isPurchased: boolean;
  createdAt: string;
  addedBy: { id: number; name: string } | null;
  linkedExpenses: ShoppingLinkedExpense[];
}

export interface ShoppingLinkedExpense {
  publicId: string;
  description: string;
  amount: string;
  date: string;
}

/** A monthly rule that posts an expense by itself (spec 008). Amount is a Decimal string ("1800.00"). */
export interface RecurringExpense {
  publicId: string;
  description: string;
  amount: string;
  dayOfMonth: number; // 1–31, clamped to the month's last day
  payerId: number;
  splitMode: "ALL" | "SELECTED";
  participantIds: number[]; // SELECTED only
  timezone: string; // IANA zone that defines the rule's "today"
  activeFrom: string; // YYYY-MM-DD
  paused: boolean;
  pauseReason: "MANUAL" | "MEMBER_LEFT" | null;
  skippedPeriods: string[]; // YYYY-MM, only periods without a ledger row
  lastClosedPeriod: string | null; // highest YYYY-MM with a ledger row
  upcoming: { period: string; dueOn: string; skipped: boolean }[]; // next 3; [] while paused
  canManage: boolean; // the viewer is the payer or an admin
  updatedAt: string; // ISO — sent back as expectedUpdatedAt
}

/** One closed period (posted or skipped) of the house's rules. `expense` is null when skipped or deleted. */
export interface RecurringHistoryItem {
  period: string;
  dueOn: string;
  status: "POSTED" | "SKIPPED";
  rule: { publicId: string; description: string };
  expense: { publicId: string; amount: string; payerId: number; participantCount: number } | null;
}

/** GET /api/recurring-expenses. Summary amounts are Decimal strings over the unpaused rules. */
export interface RecurringListResponse {
  rules: RecurringExpense[];
  summary: { monthlyTotal: string; myMonthlyShare: string; activeCount: number; pausedCount: number };
  history: RecurringHistoryItem[]; // 50 newest closed periods of the house
}

/** POST /api/recurring-expenses and PATCH …/{publicId}: `postedNow` = periods posted right away. */
export interface RecurringSaveResponse {
  rule: RecurringExpense;
  postedNow: number;
}

/**
 * What the text of each kind of notice needs (spec 009): the page fills `Notifications.text.<type>` from
 * these. The server also stores publicIds in `params`; the UI never reads them (a tap opens a list screen).
 * Declare the params of a new `NotificationType` here — `AppNotification` below stops compiling until then.
 */
interface NotificationParamsByType {
  /** `recurring`: posted by a rule (spec 008) — no actor, worded "was posted automatically". */
  EXPENSE_NEW: { description: string; amount: string; recurring: boolean };
  /** `fromUserId`: the payer, resolved to a name like the actor (any member may record a payment between two others). */
  PAYMENT_RECEIVED: { fromUserId: number; amount: string };
  /** The absolute amount the member owes in the house. */
  DEBT_REMINDER: { amount: string };
  /** `dueOn`: the rule's next period, YYYY-MM-DD. */
  RECURRING_DUE: { description: string; amount: string; dueOn: string };
}

/** One notice of the notification center (spec 009). Amounts are 2-decimal strings of the house currency. */
export type AppNotification = {
  [T in NotificationType]: {
    publicId: string;
    type: T;
    actorId: number | null; // resolved to a name with the house's members (incl. ex-members); null = automatic
    params: NotificationParamsByType[T];
    read: boolean;
    createdAt: string; // ISO
  };
}[NotificationType];

/** GET /api/notifications — the active house's notices, at most 50, newest first. */
export interface NotificationListResponse {
  notifications: AppNotification[];
  unreadCount: number;
  /** The house the server answered for (MeGroup.id): another tab may have switched it. */
  groupId: number;
}

/** GET /api/notifications/unread-count — the bell's badge. */
export interface UnreadCountResponse {
  count: number;
  /** The house the server counted for (MeGroup.id): another tab may have switched it. */
  groupId: number;
}

/** PATCH /api/notifications/{publicId}, DELETE …/{publicId} and POST /api/notifications/read-all. */
export interface NotificationMutationResponse {
  unreadCount: number;
}

/** Per-user switches, every type present (a type without a stored override is on). */
export type NotificationPreferences = Record<NotificationType, boolean>;

/** GET and PUT /api/notification-preferences. */
export interface NotificationPreferencesResponse {
  preferences: NotificationPreferences;
}

export interface InvalidRow {
  line: number;
  code: string;
  values?: { value?: string; max?: number };
}

export interface ImportResult {
  message?: string;
  created: number | unknown[];
  invalidRows: InvalidRow[];
  totalValue: number;
}
