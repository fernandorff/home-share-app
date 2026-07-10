import { prisma } from '@/lib/prisma'
import { makeTagService } from './tag-service'

// A house's custom payment methods (system defaults from lib/payment-methods are i18n keys).
// Expense.paymentMethods[] holds a system key or a custom name.
export const paymentMethodService = makeTagService({
  delegate: prisma.paymentMethod,
  model: 'paymentMethod',
  column: 'formas_pagamento',
  kind: 'payment',
  notFound: 'Forma de pagamento não encontrada',
  duplicate: 'Já existe uma forma de pagamento com esse nome',
  systemCollision: 'Essa forma de pagamento já existe como padrão do sistema',
})
