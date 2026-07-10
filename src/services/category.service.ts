import { prisma } from '@/lib/prisma'
import { makeTagService } from './tag-service'

// A house's custom categories (system defaults from lib/categories are i18n keys, not stored).
// Expense.categories[] holds a system key or a custom name.
export const categoryService = makeTagService({
  delegate: prisma.category,
  model: 'category',
  column: 'categorias',
  kind: 'category',
  notFound: 'Categoria não encontrada',
  duplicate: 'Já existe uma categoria com esse nome',
  systemCollision: 'Essa categoria já existe como padrão do sistema',
})
