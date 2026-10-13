import { describe, it, expect } from 'vitest'
import { percentLabel, percentsTo100 } from './percent'
describe('percentsTo100', () => {
  it('sums to exactly 100', () => {
    const v = [12567.35, 2219.86, 1596.44, 1013.47, 858.34, 0.01]
    const p = percentsTo100(v)
    expect(p.reduce((a, b) => a + b, 0)).toBe(100)
    expect(p[0]).toBe(69)
  })
  it('returns zeros for an empty total', () => expect(percentsTo100([0, 0])).toEqual([0, 0]))

  it('a single positive value gets 100', () => {
    expect(percentsTo100([42])).toEqual([100])
  })

  it('keeps a zero among positives at 0 and the rest sum to 100', () => {
    const p = percentsTo100([0, 50, 50])
    expect(p[0]).toBe(0)
    expect(p[1] + p[2]).toBe(100)
  })

  it('breaks remainder ties deterministically by original index', () => {
    expect(percentsTo100([1, 1, 1])).toEqual([34, 33, 33])
  })

  it('returns all zeros when every value is zero', () => {
    expect(percentsTo100([0, 0, 0])).toEqual([0, 0, 0])
  })
})

describe('percentLabel (R2-29)', () => {
  it('reads "<1%" for a positive value that rounds to 0', () => expect(percentLabel(0, 45)).toBe('<1%'))
  it('keeps "0%" for a zero value', () => expect(percentLabel(0, 0)).toBe('0%'))
  it('prints whole percents as they are', () => expect(percentLabel(73, 9000)).toBe('73%'))
})
