import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

async function main() {
  // Create fixed users
  const fernando = await prisma.user.upsert({
    where: { username: 'fernando' },
    update: { name: 'Fernando' },
    create: {
      id: 1,
      publicId: '00000000-0000-0000-0000-000000000001',
      name: 'Fernando',
      username: 'fernando',
    },
  })

  const tatiana = await prisma.user.upsert({
    where: { username: 'tatiana' },
    update: { name: 'Tatiana' },
    create: {
      id: 2,
      publicId: '00000000-0000-0000-0000-000000000002',
      name: 'Tatiana',
      username: 'tatiana',
    },
  })

  // Create fixed group
  const group = await prisma.group.upsert({
    where: { publicId: '00000000-0000-0000-0000-000000000010' },
    update: { name: 'Casa' },
    create: {
      id: 1,
      publicId: '00000000-0000-0000-0000-000000000010',
      name: 'Casa',
      description: 'Despesas compartilhadas',
    },
  })

  console.log('Seed completed:', { fernando, tatiana, group })
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
