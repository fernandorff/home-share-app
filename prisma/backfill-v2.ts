/**
 * Backfill v2 — idempotent. Safe to run multiple times.
 *
 * - Creates GroupMember rows for the legacy household (Fernando ADMIN/0, Tatiana MEMBER/1)
 *   in group 1, if they don't exist yet.
 * - Generates a joinCode for group 1 if missing.
 *
 * Run: npx tsx prisma/backfill-v2.ts  (requires DATABASE_URL)
 */
import 'dotenv/config'
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { generateJoinCode } from '../src/lib/join-code'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

const LEGACY_GROUP_ID = 1
const LEGACY_MEMBERS = [
  { userId: 1, role: 'ADMIN' as const, colorIndex: 0 },
  { userId: 2, role: 'MEMBER' as const, colorIndex: 1 },
]

/**
 * Rows inserted with explicit IDs (seed/dumps) leave the autoincrement sequence
 * behind, making the next create() collide. Resync is idempotent and safe.
 */
async function resyncSequences() {
  const tables = ['User', 'Group', 'plataforma', 'membro_grupo', 'Expense', 'ExpenseParticipant', 'item_compra']
  for (const table of tables) {
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`
    )
  }
  console.log('Sequences resynced.')
}

async function main() {
  await resyncSequences()

  const group = await prisma.group.findUnique({ where: { id: LEGACY_GROUP_ID } })
  if (!group) {
    console.log(`Group ${LEGACY_GROUP_ID} not found — nothing to backfill.`)
    return
  }

  for (const member of LEGACY_MEMBERS) {
    const user = await prisma.user.findUnique({ where: { id: member.userId } })
    if (!user) {
      console.log(`User ${member.userId} not found — skipping membership.`)
      continue
    }
    await prisma.groupMember.upsert({
      where: { userId_groupId: { userId: member.userId, groupId: LEGACY_GROUP_ID } },
      update: {},
      create: {
        userId: member.userId,
        groupId: LEGACY_GROUP_ID,
        role: member.role,
        colorIndex: member.colorIndex,
      },
    })
    console.log(`Membership ok: user ${member.userId} → group ${LEGACY_GROUP_ID} (${member.role})`)
  }

  const orphanPlatforms = await prisma.platform.updateMany({
    where: { groupId: null },
    data: { groupId: LEGACY_GROUP_ID },
  })
  if (orphanPlatforms.count > 0) {
    console.log(`Platforms assigned to group ${LEGACY_GROUP_ID}: ${orphanPlatforms.count}`)
  }

  if (!group.joinCode) {
    const joinCode = generateJoinCode()
    await prisma.group.update({ where: { id: LEGACY_GROUP_ID }, data: { joinCode } })
    console.log(`Join code created for group ${LEGACY_GROUP_ID}: ${joinCode}`)
  } else {
    console.log(`Join code already set for group ${LEGACY_GROUP_ID}.`)
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
