import { describe, it, expect } from 'vitest'
import { simplifyDebts } from './balance'

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
