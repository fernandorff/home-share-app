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

export interface Platform {
  id: number;
  publicId: string;
  name: string;
  groupId: number | null;
  createdAt: string;
  _count?: { expenses: number };
}

export interface ExpenseParticipant {
  id: number;
  expenseId: number;
  userId: number;
  amount: Money;
  user: PublicUser;
}

export interface ExpensePlatformRef {
  id: number;
  publicId: string;
  name: string;
}

export interface Expense {
  id: number;
  publicId: string;
  groupId: number;
  payerId: number;
  platformId: number | null;
  description: string;
  notes: string | null;
  amount: Money;
  date: string;
  createdAt: string;
  updatedAt: string;
  payer: PublicUser;
  platform: ExpensePlatformRef | null;
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
  | "platformId"
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

export interface BalancesResponse {
  balances: Balance[];
  settlements: Settlement[];
  totalExpenses: number;
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
