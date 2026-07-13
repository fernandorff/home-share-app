import { describe, it, expect } from 'vitest'
import { applySettlements, simplifyDebts, type Balance } from '@/lib/balance'

// Ana paid 100, split 50/50 with Bruno → Ana +50, Bruno -50.
const baseBalances: Balance[] = [
  { userId: 1, userName: 'Ana', balance: 50 },
  { userId: 2, userName: 'Bruno', balance: -50 },
]
const settle = (amount: number) => ([{
  fromUserId: 2, toUserId: 1,
  fromUser: { id: 2, name: 'Bruno' }, toUser: { id: 1, name: 'Ana' },
  amount,
}])
const byId = (bs: { userId: number; balance: number }[]) =>
  Object.fromEntries(bs.map(b => [b.userId, b.balance]))

describe('applySettlements — recorded payments fold into balances', () => {
  it('a full payment clears both balances to zero', () => {
    const b = applySettlements(baseBalances, settle(50))
    expect(byId(b)).toEqual({ 1: 0, 2: 0 })
  })

  it('a partial payment reduces both balances', () => {
    const b = byId(applySettlements(baseBalances, settle(30)))
    expect(b[1]).toBeCloseTo(20, 2)
    expect(b[2]).toBeCloseTo(-20, 2)
  })

  it('an overpayment flips who owes whom', () => {
    const b = byId(applySettlements(baseBalances, settle(60)))
    expect(b[1]).toBeCloseTo(-10, 2)
    expect(b[2]).toBeCloseTo(10, 2)
  })

  it('keeps the zero-sum invariant', () => {
    const b = applySettlements(baseBalances, settle(37))
    const sumCents = b.reduce((s, x) => s + Math.round(x.balance * 100), 0)
    expect(sumCents).toBe(0)
  })

  it('a full settlement leaves simplifyDebts with no transfers', () => {
    const b = applySettlements(baseBalances, settle(50))
    expect(simplifyDebts(b)).toEqual([])
  })
})
