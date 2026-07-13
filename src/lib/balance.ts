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

export interface SettlementForBalance {
  fromUserId: number
  toUserId: number
  fromUser: { id: number; name: string }
  toUser: { id: number; name: string }
  amount: number | string | { toString(): string }
}

/**
 * Fold recorded payments into balances. A settlement is `from` paying `to`: the
 * payer's debt shrinks (balance rises toward 0) and the receiver is owed less.
 * Pure + integer-cents, so a full payment cancels exactly and the zero-sum holds.
 */
export function applySettlements(
  balances: Balance[],
  settlements: SettlementForBalance[]
): Balance[] {
  const map = new Map<number, { name: string; cents: number }>()
  for (const b of balances) map.set(b.userId, { name: b.userName, cents: toCents(b.balance) })

  for (const s of settlements) {
    const amountCents = toCents(s.amount)
    const from = map.get(s.fromUserId) || { name: s.fromUser.name, cents: 0 }
    from.cents += amountCents
    map.set(s.fromUserId, from)

    const to = map.get(s.toUserId) || { name: s.toUser.name, cents: 0 }
    to.cents -= amountCents
    map.set(s.toUserId, to)
  }

  return Array.from(map.entries())
    .map(([userId, data]) => ({ userId, userName: data.name, balance: fromCents(data.cents) }))
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
