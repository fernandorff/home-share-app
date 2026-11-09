-- CreateTable
CREATE TABLE "BalanceCredit" (
    "groupId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "cents" BIGINT NOT NULL,
    "n" INTEGER NOT NULL,

    CONSTRAINT "BalanceCredit_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateTable
CREATE TABLE "BalanceDebit" (
    "groupId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "cents" BIGINT NOT NULL,
    "n" INTEGER NOT NULL,

    CONSTRAINT "BalanceDebit_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateTable
CREATE TABLE "BalanceCategoryTotal" (
    "groupId" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "cents" BIGINT NOT NULL,
    "n" INTEGER NOT NULL,

    CONSTRAINT "BalanceCategoryTotal_pkey" PRIMARY KEY ("groupId","category")
);

-- CreateTable
CREATE TABLE "BalanceMonthTotal" (
    "groupId" INTEGER NOT NULL,
    "month" TEXT NOT NULL,
    "cents" BIGINT NOT NULL,
    "n" INTEGER NOT NULL,

    CONSTRAINT "BalanceMonthTotal_pkey" PRIMARY KEY ("groupId","month")
);

-- CreateTable
CREATE TABLE "GroupVersion" (
    "groupId" INTEGER NOT NULL,
    "v" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "GroupVersion_pkey" PRIMARY KEY ("groupId")
);


-- Precomputed balances (spec 013, from the spec 012 pilot's mat.sql and version.sql, renamed from Pilot*).
-- Totals follow every write through row triggers, so they stay right whichever server writes.

-- Same split as the live query: n categories share the cents, the first (cents % n) get one more.
CREATE FUNCTION balance_shares(cents bigint, cats text[]) RETURNS TABLE (category text, share bigint) LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN cardinality(cats) = 0 THEN '' ELSE t.cat END,
         CASE WHEN cardinality(cats) <= 1 THEN cents
              ELSE cents / cardinality(cats) + CASE WHEN t.ord - 1 < cents % cardinality(cats) THEN 1 ELSE 0 END END
  FROM (SELECT 1) one LEFT JOIN LATERAL unnest(cats) WITH ORDINALITY AS t(cat, ord) ON true
$$;

CREATE FUNCTION balance_expense_apply(g int, payer int, amount numeric, cats text[], d timestamp, sign int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c bigint := (amount * 100)::bigint * sign;
BEGIN
  INSERT INTO "BalanceCredit" VALUES (g, payer, c, sign)
    ON CONFLICT ("groupId", "userId") DO UPDATE SET cents = "BalanceCredit".cents + c, n = "BalanceCredit".n + sign;
  INSERT INTO "BalanceMonthTotal" VALUES (g, to_char(d, 'YYYY-MM'), c, sign)
    ON CONFLICT ("groupId", month) DO UPDATE SET cents = "BalanceMonthTotal".cents + c, n = "BalanceMonthTotal".n + sign;
  INSERT INTO "BalanceCategoryTotal" SELECT g, s.category, s.share * sign, sign FROM balance_shares((amount * 100)::bigint, cats) s
    ON CONFLICT ("groupId", category) DO UPDATE SET cents = "BalanceCategoryTotal".cents + excluded.cents, n = "BalanceCategoryTotal".n + sign;
  IF sign < 0 THEN -- an insert never brings a count to zero
    DELETE FROM "BalanceCredit" WHERE "groupId" = g AND "userId" = payer AND n = 0;
    DELETE FROM "BalanceMonthTotal" WHERE "groupId" = g AND month = to_char(d, 'YYYY-MM') AND n = 0;
    DELETE FROM "BalanceCategoryTotal" WHERE "groupId" = g AND n = 0;
  END IF;
END $$;

CREATE FUNCTION balance_debit_apply(g int, u int, amount numeric, sign int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "BalanceDebit" VALUES (g, u, (amount * 100)::bigint * sign, sign)
    ON CONFLICT ("groupId", "userId") DO UPDATE SET cents = "BalanceDebit".cents + excluded.cents, n = "BalanceDebit".n + sign;
  IF sign < 0 THEN DELETE FROM "BalanceDebit" WHERE "groupId" = g AND "userId" = u AND n = 0; END IF;
END $$;

CREATE FUNCTION balance_expense_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM balance_expense_apply(OLD."groupId", OLD."payerId", OLD."amount", OLD."categories", OLD."date", -1); END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN PERFORM balance_expense_apply(NEW."groupId", NEW."payerId", NEW."amount", NEW."categories", NEW."date", 1); END IF;
  -- An expense moved to another house carries its participants' debits along.
  IF TG_OP = 'UPDATE' AND OLD."groupId" <> NEW."groupId" THEN
    PERFORM balance_debit_apply(OLD."groupId", p."userId", p."amount", -1), balance_debit_apply(NEW."groupId", p."userId", p."amount", 1)
      FROM "ExpenseParticipant" p WHERE p."expenseId" = NEW."id";
  END IF;
  RETURN NULL;
END $$;

-- Deleting an expense cascades to its participants after the expense row is gone, so their debits are
-- taken out here, while the house is still known; the participant trigger then finds no expense and skips.
CREATE FUNCTION balance_expense_before_delete_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM balance_debit_apply(OLD."groupId", p."userId", p."amount", -1) FROM "ExpenseParticipant" p WHERE p."expenseId" = OLD."id";
  RETURN OLD;
END $$;

CREATE FUNCTION balance_participant_trg() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g int;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "groupId" INTO g FROM "Expense" WHERE "id" = OLD."expenseId";
    IF g IS NOT NULL THEN PERFORM balance_debit_apply(g, OLD."userId", OLD."amount", -1); END IF;
  END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN
    SELECT "groupId" INTO g FROM "Expense" WHERE "id" = NEW."expenseId";
    IF g IS NOT NULL THEN PERFORM balance_debit_apply(g, NEW."userId", NEW."amount", 1); END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER balance_expense_after AFTER INSERT OR UPDATE OR DELETE ON "Expense" FOR EACH ROW EXECUTE FUNCTION balance_expense_trg();
CREATE TRIGGER balance_expense_before_delete BEFORE DELETE ON "Expense" FOR EACH ROW EXECUTE FUNCTION balance_expense_before_delete_trg();
CREATE TRIGGER balance_participant_after AFTER INSERT OR UPDATE OR DELETE ON "ExpenseParticipant" FOR EACH ROW EXECUTE FUNCTION balance_participant_trg();

-- Version counter: any write that changes a house's balances bumps it.
CREATE FUNCTION balance_bump(g int) RETURNS void LANGUAGE sql AS $$
  INSERT INTO "GroupVersion" VALUES (g, 1) ON CONFLICT ("groupId") DO UPDATE SET v = "GroupVersion".v + 1
$$;

-- Expense and Settlement carry the house; a participant row reaches it through its expense.
CREATE FUNCTION balance_version_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'ExpenseParticipant' THEN
    PERFORM balance_bump(e."groupId") FROM "Expense" e
      WHERE e."id" IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD."expenseId" END, CASE WHEN TG_OP <> 'DELETE' THEN NEW."expenseId" END);
  ELSE
    IF TG_OP <> 'INSERT' THEN PERFORM balance_bump(OLD."groupId"); END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM balance_bump(NEW."groupId"); END IF;
  END IF;
  RETURN NULL;
END $$;

-- A renamed user changes the names shown in every house they belong to.
CREATE FUNCTION balance_version_user_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."name" IS DISTINCT FROM OLD."name" THEN
    PERFORM balance_bump(m."groupId") FROM "GroupMember" m WHERE m."userId" = NEW."id";
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER balance_version_expense AFTER INSERT OR UPDATE OR DELETE ON "Expense" FOR EACH ROW EXECUTE FUNCTION balance_version_trg();
CREATE TRIGGER balance_version_participant AFTER INSERT OR UPDATE OR DELETE ON "ExpenseParticipant" FOR EACH ROW EXECUTE FUNCTION balance_version_trg();
CREATE TRIGGER balance_version_settlement AFTER INSERT OR UPDATE OR DELETE ON "Settlement" FOR EACH ROW EXECUTE FUNCTION balance_version_trg();
CREATE TRIGGER balance_version_user AFTER UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION balance_version_user_trg();

-- Backfill from what is already there.
INSERT INTO "BalanceCredit" SELECT "groupId", "payerId", SUM(("amount" * 100)::bigint), COUNT(*) FROM "Expense" GROUP BY 1, 2;
INSERT INTO "BalanceDebit" SELECT e."groupId", p."userId", SUM((p."amount" * 100)::bigint), COUNT(*)
  FROM "ExpenseParticipant" p JOIN "Expense" e ON e."id" = p."expenseId" GROUP BY 1, 2;
INSERT INTO "BalanceMonthTotal" SELECT "groupId", to_char("date", 'YYYY-MM'), SUM(("amount" * 100)::bigint), COUNT(*) FROM "Expense" GROUP BY 1, 2;
INSERT INTO "BalanceCategoryTotal" SELECT e."groupId", s.category, SUM(s.share), COUNT(*)
  FROM "Expense" e, balance_shares(("amount" * 100)::bigint, e."categories") s GROUP BY 1, 2;
INSERT INTO "GroupVersion" ("groupId") SELECT "id" FROM "Group";
