import { prisma } from '@/lib/prisma'
import { makeTagService } from './tag-service'

// A house's custom platforms (system defaults from lib/platforms are i18n keys, not stored).
// Expense.platforms[] holds a system key or a custom name.
export const platformService = makeTagService({
  delegate: prisma.platform,
  model: 'platform',
  column: 'plataformas',
  kind: 'platform',
  notFound: 'Platform not found',
  duplicate: 'A platform with that name already exists',
  systemCollision: 'That platform already exists as a system default',
})
