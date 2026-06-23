import { PrismaClient } from '@/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Bound per-container connections so warm serverless instances can't exhaust Neon.
    max: 5,
    idleTimeoutMillis: 10_000,
  })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({ adapter })
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

// Cache on globalThis in EVERY environment: in dev it survives HMR; in prod it guarantees
// a single Pool per warm container regardless of how many times this module is bundled/loaded.
globalForPrisma.prisma = prisma
