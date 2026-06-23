// One-off data repair for legacy/copied data (Wave 1). Idempotent + safe to re-run.
//   A1: re-split expenses whose participant amounts don't sum to the total (largest-remainder).
//   A2: re-point platforms referenced by a group's expenses to that group (fixes copy orphans).
//   A3: generate a join code for any group missing one.
// Usage: node --env-file=.env scripts/repair-wave1.mjs           (DRY RUN — reports only)
//        node --env-file=.env scripts/repair-wave1.mjs --apply   (writes changes)
import { Pool } from 'pg'

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const genCode = () => Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('')
const splitCents = (total, parts) => {
  const base = Math.floor(total / parts)
  const rem = total - base * parts
  return Array.from({ length: parts }, (_, i) => base + (i < rem ? 1 : 0))
}
const cents = (s) => Math.round(parseFloat(s) * 100)

const apply = process.argv.includes('--apply')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const report = { apply, fixedExpenses: 0, fixedParticipants: 0, fixedPlatforms: 0, fixedJoinCodes: 0, examples: [] }

try {
  // A1 — participant splits that don't reconcile
  const { rows: exps } = await pool.query(`
    SELECT e.id, e.valor::text AS amount,
      json_agg(json_build_object('id', p.id, 'amount', p.valor::text) ORDER BY p.id) AS parts
    FROM "Expense" e JOIN "ExpenseParticipant" p ON p."expenseId" = e.id
    GROUP BY e.id`)
  for (const e of exps) {
    const amt = cents(e.amount)
    const sum = e.parts.reduce((s, p) => s + cents(p.amount), 0)
    if (sum === amt) continue
    const shares = splitCents(amt, e.parts.length)
    report.fixedExpenses++
    if (report.examples.length < 6) {
      report.examples.push({ expenseId: e.id, amount: amt / 100, oldSum: sum / 100, newShares: shares.map(c => c / 100) })
    }
    for (let i = 0; i < e.parts.length; i++) {
      if (shares[i] !== cents(e.parts[i].amount)) {
        report.fixedParticipants++
        if (apply) await pool.query(`UPDATE "ExpenseParticipant" SET valor = $1 WHERE id = $2`, [(shares[i] / 100).toFixed(2), e.parts[i].id])
      }
    }
  }

  // A2 — platforms used by a group's expenses but not scoped to that group
  const { rows: plat } = await pool.query(`
    SELECT DISTINCT pl.id, pl.nome, pl.grupo_id, e."groupId" AS g
    FROM plataforma pl JOIN "Expense" e ON e.plataforma_id = pl.id
    WHERE pl.grupo_id IS DISTINCT FROM e."groupId"`)
  for (const p of plat) {
    report.fixedPlatforms++
    if (apply) await pool.query(`UPDATE plataforma SET grupo_id = $1 WHERE id = $2`, [p.g, p.id])
  }

  // A3 — groups with no join code
  const { rows: groups } = await pool.query(`SELECT id, nome FROM "Group" WHERE codigo_convite IS NULL`)
  for (const g of groups) {
    report.fixedJoinCodes++
    if (apply) {
      let code, taken = true
      while (taken) {
        code = genCode()
        taken = (await pool.query(`SELECT 1 FROM "Group" WHERE codigo_convite = $1`, [code])).rowCount > 0
      }
      await pool.query(`UPDATE "Group" SET codigo_convite = $1 WHERE id = $2`, [code, g.id])
    }
  }

  console.log(JSON.stringify(report, null, 2))
} finally {
  await pool.end()
}
