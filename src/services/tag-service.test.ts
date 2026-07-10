import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    category: { findFirst: vi.fn(), create: vi.fn() },
    platform: { findFirst: vi.fn(), create: vi.fn() },
    paymentMethod: { findFirst: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import { categoryService } from './category.service'
import { platformService } from './platform.service'
import { paymentMethodService } from './payment-method.service'
import { ApiError } from '@/lib/errors'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('tag services — reject a house-custom name that collides with a system default (BL-11/M1)', () => {
  it('rejects a category matching a system default, case-insensitively, before even hitting the DB', async () => {
    await expect(categoryService.create(1, 'groceries')).rejects.toThrow(ApiError)
    expect(mockPrisma.category.findFirst).not.toHaveBeenCalled()
  })

  it('rejects a category matching a default translated in a non-English locale', async () => {
    await expect(categoryService.create(1, 'Outros')).rejects.toMatchObject({ code: 'SYSTEM_DEFAULT_COLLISION' })
  })

  it('rejects a platform matching a system default', async () => {
    await expect(platformService.create(1, 'Amazon')).rejects.toMatchObject({ code: 'SYSTEM_DEFAULT_COLLISION' })
  })

  it('rejects a payment method matching a system default', async () => {
    await expect(paymentMethodService.create(1, 'Pix')).rejects.toMatchObject({ code: 'SYSTEM_DEFAULT_COLLISION' })
  })

  it('still allows a genuine house-custom name not shared with any default', async () => {
    mockPrisma.category.findFirst.mockResolvedValue(null)
    mockPrisma.category.create.mockResolvedValue({ id: 1, publicId: 'p1', groupId: 1, name: 'Streaming', createdAt: new Date() })
    const row = await categoryService.create(1, 'Streaming')
    expect(row.name).toBe('Streaming')
  })

  it('still rejects a house-vs-house duplicate (unrelated to system defaults)', async () => {
    mockPrisma.category.findFirst.mockResolvedValue({ id: 1, publicId: 'p1', groupId: 1, name: 'Streaming', createdAt: new Date() })
    await expect(categoryService.create(1, 'Streaming')).rejects.toMatchObject({ code: 'DUPLICATE_NAME' })
  })
})
