// Shared API types — mirror the verified route/service response shapes.
// NOTE: Prisma Decimal fields (expense/participant amount) serialize to STRING in JSON;
// computed balances come as number. `Money` captures both — always coerce via toNumber.

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
}

export interface Me {
  user: {
    id: number;
    publicId: string;
    name: string;
    username: string;
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
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
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

export type AuditEntityType = "EXPENSE" | "SETTLEMENT" | "SHOPPING_ITEM" | "GROUP" | "PLATFORM";
export type AuditAction = "CREATE" | "UPDATE" | "DELETE";

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
}

export interface ShoppingItem {
  id: number;
  publicId: string;
  name: string;
  isPurchased: boolean;
  createdAt: string;
  addedBy: { id: number; name: string } | null;
}

export interface InvalidRow {
  line: number;
  reason: string;
}

export interface ImportResult {
  message?: string;
  created: number | unknown[];
  invalidRows: InvalidRow[];
  totalValue: number;
}
