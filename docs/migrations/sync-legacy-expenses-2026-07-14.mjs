/**
 * One-time legacy expense sync (2026-07-14).
 *
 * Source: the production database of `la-casa-das-bolitas`.
 * Target: the production database of Home Share.
 *
 * Dry-run is the default. Pass --apply to commit. Both URLs must be supplied through the
 * environment; credentials are never stored in this repository.
 */
import pg from "pg";

const { Client } = pg;
const SOURCE_GROUP_PUBLIC_ID = "00000000-0000-0000-0000-000000000010";
const APPLY = process.argv.includes("--apply");

const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error("SOURCE_DATABASE_URL and TARGET_DATABASE_URL are required");
if (sourceUrl === targetUrl) throw new Error("Source and target databases must be different");

function toCents(value) {
  const match = String(value).match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`Invalid money value: ${value}`);
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0")));
}

function fromCents(value) {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function normalizedName(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function tagsForLegacyPlatform(name) {
  if (!name) return { platforms: [], paymentMethods: [] };
  const normalized = normalizedName(name);
  if (normalized === "credito") return { platforms: [], paymentMethods: ["credit"] };
  if (normalized === "pix") return { platforms: [], paymentMethods: ["pix"] };
  if (normalized === "amazon") return { platforms: ["amazon"], paymentMethods: [] };
  if (normalized === "mercado livre") return { platforms: ["mercadolivre"], paymentMethods: [] };
  if (normalized === "shopee") return { platforms: ["shopee"], paymentMethods: [] };
  return { platforms: [name], paymentMethods: [] };
}

/** Largest-remainder normalization; every imported split sums to the expense total exactly. */
function normalizeParticipants(participants, totalCents) {
  if (participants.length === 0) throw new Error("An expense has no participants");
  const ordered = [...participants].sort((a, b) => a.userId - b.userId);
  const sourceTotal = ordered.reduce((sum, row) => sum + toCents(row.valor), 0);
  if (sourceTotal <= 0) throw new Error("Participant total must be positive");

  const allocations = ordered.map((row) => {
    const numerator = totalCents * toCents(row.valor);
    return { ...row, cents: Math.floor(numerator / sourceTotal), remainder: numerator % sourceTotal };
  });
  let undistributed = totalCents - allocations.reduce((sum, row) => sum + row.cents, 0);
  const priority = [...allocations].sort((a, b) => b.remainder - a.remainder || a.userId - b.userId);
  for (let index = 0; undistributed > 0; index = (index + 1) % priority.length) {
    priority[index].cents += 1;
    undistributed -= 1;
  }
  return allocations.sort((a, b) => a.userId - b.userId);
}

function sumExpenseCents(rows, amountKey) {
  return rows.reduce((sum, row) => sum + toCents(row[amountKey]), 0);
}

async function main() {
  const source = new Client({ connectionString: sourceUrl });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();

  try {
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await target.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await target.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["home-share:legacy-expense-sync:2026-07-14"]);
    await target.query('LOCK TABLE "Expense", "ExpenseParticipant" IN SHARE ROW EXCLUSIVE MODE');

    const sourceGroup = (await source.query('SELECT * FROM "Group" WHERE "publicId" = $1', [SOURCE_GROUP_PUBLIC_ID])).rows[0];
    const targetGroup = (await target.query('SELECT * FROM "Group" WHERE "publicId" = $1', [SOURCE_GROUP_PUBLIC_ID])).rows[0];
    if (!sourceGroup || !targetGroup) throw new Error("Legacy household is missing from source or target");

    const sourceUsers = (await source.query('SELECT id, "publicId" FROM "User"')).rows;
    const targetUsers = (await target.query('SELECT id, "publicId" FROM "User"')).rows;
    const sourceUserPublicId = new Map(sourceUsers.map((row) => [row.id, row.publicId]));
    const targetUserId = new Map(targetUsers.map((row) => [row.publicId, row.id]));
    const mapUserId = (sourceId) => {
      const publicId = sourceUserPublicId.get(sourceId);
      const mapped = targetUserId.get(publicId);
      if (!mapped) throw new Error(`Could not map source user ${sourceId}`);
      return mapped;
    };

    const sourceExpenses = (await source.query('SELECT * FROM "Expense" WHERE "groupId" = $1 ORDER BY id', [sourceGroup.id])).rows;
    const sourceParticipants = (await source.query('SELECT * FROM "ExpenseParticipant" ORDER BY id')).rows;
    const sourcePlatforms = (await source.query('SELECT id, nome FROM plataforma')).rows;
    const platformNameById = new Map(sourcePlatforms.map((row) => [row.id, row.nome]));
    const participantsByExpense = new Map();
    for (const participant of sourceParticipants) {
      const list = participantsByExpense.get(participant.expenseId) ?? [];
      list.push(participant);
      participantsByExpense.set(participant.expenseId, list);
    }

    const targetExpenses = (await target.query('SELECT * FROM "Expense" WHERE "groupId" = $1 ORDER BY id', [targetGroup.id])).rows;
    const sourceByPublicId = new Map(sourceExpenses.map((row) => [row.publicId, row]));
    const targetByPublicId = new Map(targetExpenses.map((row) => [row.publicId, row]));
    const targetOnly = targetExpenses.filter((row) => !sourceByPublicId.has(row.publicId));
    if (targetOnly.length > 0) {
      throw new Error(`Target has ${targetOnly.length} expense(s) absent from source; refusing destructive reconciliation`);
    }

    const missing = sourceExpenses.filter((row) => !targetByPublicId.has(row.publicId));
    const amountConflicts = sourceExpenses.filter((row) => {
      const current = targetByPublicId.get(row.publicId);
      return current && toCents(row.valor) !== toCents(current.amount);
    });

    console.log(JSON.stringify({
      mode: APPLY ? "apply" : "dry-run",
      sourceCount: sourceExpenses.length,
      targetCountBefore: targetExpenses.length,
      missingCount: missing.length,
      amountConflictCount: amountConflicts.length,
      sourceTotal: fromCents(sumExpenseCents(sourceExpenses, "valor")),
      targetTotalBefore: fromCents(sumExpenseCents(targetExpenses, "amount")),
    }));

    for (const expense of missing) {
      const totalCents = toCents(expense.valor);
      const participants = normalizeParticipants(participantsByExpense.get(expense.id) ?? [], totalCents);
      const platformName = platformNameById.get(expense.plataforma_id) ?? null;
      const tags = tagsForLegacyPlatform(platformName);
      const payerId = mapUserId(expense.payerId);

      const inserted = (await target.query(
        `INSERT INTO "Expense"
          ("publicId", "groupId", "payerId", "platformId", "platformIds", description, notes,
           category, categories, platforms, "paymentMethods", amount, date, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, '{}'::integer[], $5, $6, NULL, '{}'::text[], $7::text[],
                 $8::text[], $9::numeric, $10, $11, $12)
         RETURNING *`,
        [expense.publicId, targetGroup.id, payerId, expense.plataforma_id, expense.descricao,
          expense.observacao, tags.platforms, tags.paymentMethods, fromCents(totalCents), expense.data,
          expense.createdAt, expense.updatedAt]
      )).rows[0];

      for (const participant of participants) {
        await target.query(
          'INSERT INTO "ExpenseParticipant" ("expenseId", "userId", amount) VALUES ($1, $2, $3::numeric)',
          [inserted.id, mapUserId(participant.userId), fromCents(participant.cents)]
        );
      }
      await target.query(
        'INSERT INTO "AuditLog" ("groupId", "actorId", "entityType", "entityId", action, summary, changes) VALUES ($1, NULL, $2, $3, $4, $5, $6::jsonb)',
        [targetGroup.id, "Expense", expense.publicId, "CREATE", expense.descricao,
          JSON.stringify({ source: "la-casa-das-bolitas", migration: "2026-07-14" })]
      );
      await target.query(
        'INSERT INTO "EntityRevision" ("entityType", "entityId", "groupId", action, "actorId", after) VALUES ($1, $2, $3, $4, NULL, $5::jsonb)',
        ["Expense", String(inserted.id), targetGroup.id, "CREATE", JSON.stringify(inserted)]
      );
    }

    for (const sourceExpense of amountConflicts) {
      const current = targetByPublicId.get(sourceExpense.publicId);
      const totalCents = toCents(sourceExpense.valor);
      const participants = normalizeParticipants(participantsByExpense.get(sourceExpense.id) ?? [], totalCents);
      const before = current;
      const updated = (await target.query(
        'UPDATE "Expense" SET amount = $1::numeric, "updatedAt" = now() WHERE id = $2 RETURNING *',
        [fromCents(totalCents), current.id]
      )).rows[0];
      await target.query('DELETE FROM "ExpenseParticipant" WHERE "expenseId" = $1', [current.id]);
      for (const participant of participants) {
        await target.query(
          'INSERT INTO "ExpenseParticipant" ("expenseId", "userId", amount) VALUES ($1, $2, $3::numeric)',
          [current.id, mapUserId(participant.userId), fromCents(participant.cents)]
        );
      }
      await target.query(
        'INSERT INTO "AuditLog" ("groupId", "actorId", "entityType", "entityId", action, summary, changes) VALUES ($1, NULL, $2, $3, $4, $5, $6::jsonb)',
        [targetGroup.id, "Expense", sourceExpense.publicId, "UPDATE", sourceExpense.descricao,
          JSON.stringify({ amount: { before: String(before.amount), after: fromCents(totalCents) }, source: "la-casa-das-bolitas", migration: "2026-07-14" })]
      );
      await target.query(
        'INSERT INTO "EntityRevision" ("entityType", "entityId", "groupId", action, "actorId", before, after) VALUES ($1, $2, $3, $4, NULL, $5::jsonb, $6::jsonb)',
        ["Expense", String(current.id), targetGroup.id, "UPDATE", JSON.stringify(before), JSON.stringify(updated)]
      );
    }

    const finalExpenses = (await target.query('SELECT * FROM "Expense" WHERE "groupId" = $1 ORDER BY id', [targetGroup.id])).rows;
    const finalByPublicId = new Set(finalExpenses.map((row) => row.publicId));
    const missingAfter = sourceExpenses.filter((row) => !finalByPublicId.has(row.publicId));
    const sourceTotalCents = sumExpenseCents(sourceExpenses, "valor");
    const finalTotalCents = sumExpenseCents(finalExpenses, "amount");
    if (missingAfter.length !== 0) throw new Error(`${missingAfter.length} source expense(s) still missing after sync`);
    if (finalExpenses.length !== sourceExpenses.length) throw new Error("Expense counts do not match after sync");
    if (finalTotalCents !== sourceTotalCents) {
      throw new Error(`Totals do not match after sync: ${fromCents(finalTotalCents)} != ${fromCents(sourceTotalCents)}`);
    }

    const invalidSplits = (await target.query(
      `SELECT e."publicId", e.amount, COALESCE(SUM(p.amount), 0) AS participant_total
         FROM "Expense" e LEFT JOIN "ExpenseParticipant" p ON p."expenseId" = e.id
        WHERE e."groupId" = $1 GROUP BY e.id HAVING e.amount <> COALESCE(SUM(p.amount), 0)`,
      [targetGroup.id]
    )).rows;
    if (invalidSplits.length > 0) throw new Error(`${invalidSplits.length} expense split(s) do not equal their expense amount`);

    const sourcePayerTotals = new Map();
    for (const expense of sourceExpenses) {
      const payerId = mapUserId(expense.payerId);
      sourcePayerTotals.set(payerId, (sourcePayerTotals.get(payerId) ?? 0) + toCents(expense.valor));
    }
    const finalPayerRows = (await target.query(
      'SELECT "payerId", SUM(amount)::text AS total FROM "Expense" WHERE "groupId" = $1 GROUP BY "payerId"',
      [targetGroup.id]
    )).rows;
    for (const row of finalPayerRows) {
      if (toCents(row.total) !== sourcePayerTotals.get(row.payerId)) {
        throw new Error(`Payer total mismatch for user ${row.payerId}`);
      }
    }

    console.log(JSON.stringify({
      validation: "passed",
      finalCount: finalExpenses.length,
      finalTotal: fromCents(finalTotalCents),
      imported: missing.length,
      reconciledAmounts: amountConflicts.length,
      invalidSplits: invalidSplits.length,
    }));

    if (APPLY) await target.query("COMMIT");
    else await target.query("ROLLBACK");
    await source.query("ROLLBACK");
    console.log(APPLY ? "Migration committed." : "Dry-run rolled back.");
  } catch (error) {
    await Promise.allSettled([target.query("ROLLBACK"), source.query("ROLLBACK")]);
    throw error;
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}

await main();
