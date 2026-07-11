import { prisma } from '@/lib/prisma'
import { makeTagService } from './tag-service'

// A house's custom payment methods (system defaults from lib/payment-methods are i18n keys).
// Expense.paymentMethods[] holds a system key or a custom name.
export const paymentMethodService = makeTagService({
  delegate: prisma.paymentMethod,
  model: 'paymentMethod',
  column: 'paymentMethods',
  kind: 'payment',
  notFound: 'Payment method not found',
  duplicate: 'A payment method with that name already exists',
  systemCollision: 'That payment method already exists as a system default',
})
