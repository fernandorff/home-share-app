import { describe, it, expect } from 'vitest'
import { calculateBalances, simplifyDebts, ExpenseForBalance } from './balance'

const fernando = { id: 1, name: 'Fernando' }
const tatiana = { id: 2, name: 'Tatiana' }
const otavio = { id: 3, name: 'Otávio' }

function expense(
  payer: { id: number; name: string },
  amount: number,
  parts: [{ id: number; name: string }, number][]
): ExpenseForBalance {
  return {
    payerId: payer.id,
    payer,
    amount,
    participants: parts.map(([user, value]) => ({
      userId: user.id,
      user,
      amount: value,
    })),
  }
}

describe('calculateBalances', () => {
  it('two people, even split: payer is owed half', () => {
    const balances = calculateBalances([
      expense(fernando, 100, [
        [fernando, 50],
        [tatiana, 50],
      ]),
    ])
    expect(balances).toEqual([
      { userId: 1, userName: 'Fernando', balance: 50 },
      { userId: 2, userName: 'Tatiana', balance: -50 },
    ])
  })

  it('non-exact division in cents stays exact (no float drift)', () => {
    // R$100 split 3 ways as 33.34 + 33.33 + 33.33
    const balances = calculateBalances([
      expense(otavio, 100, [
        [fernando, 33.34],
        [tatiana, 33.33],
        [otavio, 33.33],
      ]),
    ])
    const total = balances.reduce((sum, b) => sum + b.balance, 0)
    expect(total).toBe(0)
    expect(balances.find(b => b.userId === 3)?.balance).toBe(66.67)
  })

  it('many small float-hostile amounts sum to zero', () => {
    const expenses = Array.from({ length: 30 }, () =>
      expense(fernando, 0.1, [
        [fernando, 0.05],
        [tatiana, 0.05],
      ])
    )
    const balances = calculateBalances(expenses)
    expect(balances.find(b => b.userId === 1)?.balance).toBe(1.5)
    expect(balances.find(b => b.userId === 2)?.balance).toBe(-1.5)
  })

  it('mutual expenses cancel out to zero balances', () => {
    const balances = calculateBalances([
      expense(fernando, 80, [
        [fernando, 40],
        [tatiana, 40],
      ]),
      expense(tatiana, 80, [
        [fernando, 40],
        [tatiana, 40],
      ]),
    ])
    expect(balances.every(b => b.balance === 0)).toBe(true)
  })
})

describe('simplifyDebts', () => {
  it('two people: single settlement', () => {
    const settlements = simplifyDebts([
      { userId: 1, userName: 'Fernando', balance: 50 },
      { userId: 2, userName: 'Tatiana', balance: -50 },
    ])
    expect(settlements).toEqual([
      { from: { id: 2, name: 'Tatiana' }, to: { id: 1, name: 'Fernando' }, amount: 50 },
    ])
  })

  it('three people resolve with minimal transfers and exact cents', () => {
    const settlements = simplifyDebts([
      { userId: 1, userName: 'Fernando', balance: 66.67 },
      { userId: 2, userName: 'Tatiana', balance: -33.33 },
      { userId: 3, userName: 'Otávio', balance: -33.34 },
    ])
    const paid = settlements.reduce((sum, s) => sum + s.amount, 0)
    expect(paid).toBeCloseTo(66.67, 10)
    expect(settlements).toHaveLength(2)
    expect(settlements.every(s => s.to.id === 1)).toBe(true)
  })

  it('settles 1-cent debts (no epsilon swallowing)', () => {
    const settlements = simplifyDebts([
      { userId: 1, userName: 'Fernando', balance: 0.01 },
      { userId: 2, userName: 'Tatiana', balance: -0.01 },
    ])
    expect(settlements).toEqual([
      { from: { id: 2, name: 'Tatiana' }, to: { id: 1, name: 'Fernando' }, amount: 0.01 },
    ])
  })

  it('zero balances produce no settlements', () => {
    expect(
      simplifyDebts([
        { userId: 1, userName: 'Fernando', balance: 0 },
        { userId: 2, userName: 'Tatiana', balance: 0 },
      ])
    ).toEqual([])
  })
})
