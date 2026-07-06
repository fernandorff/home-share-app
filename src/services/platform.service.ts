import { prisma } from '@/lib/prisma'
import { makeTagService } from './tag-service'

// A house's custom platforms (system defaults from lib/platforms are i18n keys, not stored).
// Expense.platforms[] holds a system key or a custom name.
export const platformService = makeTagService({
  delegate: prisma.platform,
  model: 'platform',
  column: 'plataformas',
  notFound: 'Plataforma não encontrada',
  duplicate: 'Já existe uma plataforma com esse nome',
})
