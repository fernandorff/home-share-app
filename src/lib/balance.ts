import { toCents, fromCents } from '@/lib/currency'

export interface Balance {
  userId: number
  userName: string
  balance: number
}

export interface SimplifiedDebt {
  from: { id: number; name: string }
  to: { id: number; name: string }
  amount: number
}

export interface ExpenseForBalance {
  payerId: number
  payer: { id: number; name: string }
  amount: number | string | { toString(): string }
  participants: {
    userId: number
    user: { id: number; name: string }
    amount: number | string | { toString(): string }
  }[]
}

// All arithmetic happens in integer cents; reais only at the boundaries.
export function calculateBalances(expenses: ExpenseForBalance[]): Balance[] {
  const balanceMap = new Map<number, { name: string; cents: number }>()

  for (const expense of expenses) {
    const expenseCents = toCents(expense.amount)

    const payerBalance = balanceMap.get(expense.payerId) || {
      name: expense.payer.name,
      cents: 0
    }
    payerBalance.cents += expenseCents
    balanceMap.set(expense.payerId, payerBalance)

    for (const participant of expense.participants) {
      const partCents = toCents(participant.amount)
      const pBalance = balanceMap.get(participant.userId) || {
        name: participant.user.name,
        cents: 0
      }
      pBalance.cents -= partCents
      balanceMap.set(participant.userId, pBalance)
    }
  }

  return Array.from(balanceMap.entries())
    .map(([userId, data]) => ({
      userId,
      userName: data.name,
      balance: fromCents(data.cents)
    }))
    .sort((a, b) => b.balance - a.balance)
}

export function simplifyDebts(balances: Balance[]): SimplifiedDebt[] {
  const creditors = balances
    .filter(b => toCents(b.balance) > 0)
    .map(b => ({ ...b, remainingCents: toCents(b.balance) }))

  const debtors = balances
    .filter(b => toCents(b.balance) < 0)
    .map(b => ({ ...b, remainingCents: -toCents(b.balance) }))

  const settlements: SimplifiedDebt[] = []

  creditors.sort((a, b) => b.remainingCents - a.remainingCents)
  debtors.sort((a, b) => b.remainingCents - a.remainingCents)

  for (const debtor of debtors) {
    while (debtor.remainingCents > 0) {
      const creditor = creditors.find(c => c.remainingCents > 0)
      if (!creditor) break

      const amountCents = Math.min(debtor.remainingCents, creditor.remainingCents)

      settlements.push({
        from: { id: debtor.userId, name: debtor.userName },
        to: { id: creditor.userId, name: creditor.userName },
        amount: fromCents(amountCents)
      })

      debtor.remainingCents -= amountCents
      creditor.remainingCents -= amountCents
    }
  }

  return settlements
}
