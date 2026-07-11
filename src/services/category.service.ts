import { prisma } from '@/lib/prisma'
import { makeTagService } from './tag-service'

// A house's custom categories (system defaults from lib/categories are i18n keys, not stored).
// Expense.categories[] holds a system key or a custom name.
export const categoryService = makeTagService({
  delegate: prisma.category,
  model: 'category',
  column: 'categories',
  kind: 'category',
  notFound: 'Category not found',
  duplicate: 'A category with that name already exists',
  systemCollision: 'That category already exists as a system default',
})
