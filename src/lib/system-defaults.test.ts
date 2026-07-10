import { describe, it, expect } from 'vitest'
import { isSystemDefaultName } from '@/lib/system-defaults'

describe('isSystemDefaultName', () => {
  it('matches a category default in the exact case shown in the UI', () => {
    expect(isSystemDefaultName('category', 'Groceries')).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(isSystemDefaultName('category', 'groceries')).toBe(true)
    expect(isSystemDefaultName('category', 'GROCERIES')).toBe(true)
  })

  it('matches a default translated in a locale other than English', () => {
    expect(isSystemDefaultName('category', 'Outros')).toBe(true) // pt "other"
  })

  it('does not match a genuine house-custom name', () => {
    expect(isSystemDefaultName('category', 'Streaming')).toBe(false)
  })

  it('checks platform defaults independently of category defaults', () => {
    expect(isSystemDefaultName('platform', 'Amazon')).toBe(true)
    expect(isSystemDefaultName('category', 'Amazon')).toBe(false)
  })

  it('checks payment defaults', () => {
    expect(isSystemDefaultName('payment', 'Pix')).toBe(true)
    expect(isSystemDefaultName('payment', 'Random Bank')).toBe(false)
  })

  it('trims surrounding whitespace before comparing', () => {
    expect(isSystemDefaultName('category', '  Groceries  ')).toBe(true)
  })
})
