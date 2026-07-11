-- One-time rename of every Portuguese table/column to the Prisma-default English names
-- (PascalCase tables / camelCase columns — same style as the already-unmapped "User",
-- "Expense", "ExpenseParticipant", "Group" tables). Applied manually to prod BEFORE
-- deploying the schema that drops all @map/@@map. Every statement is a metadata-only
-- rename: instant, no table rewrite, no data movement.

-- ── Tables ──────────────────────────────────────────────────────────────────
ALTER TABLE "membro_grupo"         RENAME TO "GroupMember";
ALTER TABLE "categoria_casa"       RENAME TO "Category";
ALTER TABLE "plataforma"           RENAME TO "Platform";
ALTER TABLE "forma_pagamento_casa" RENAME TO "PaymentMethod";
ALTER TABLE "item_compra"          RENAME TO "ShoppingItem";
ALTER TABLE "acerto"               RENAME TO "Settlement";
ALTER TABLE "registro_auditoria"   RENAME TO "AuditLog";
ALTER TABLE "revisao_entidade"     RENAME TO "EntityRevision";

-- ── Columns ─────────────────────────────────────────────────────────────────
-- User ("email" was a same-name @map: no SQL needed)
ALTER TABLE "User" RENAME COLUMN "nome"              TO "name";
ALTER TABLE "User" RENAME COLUMN "usuario"           TO "username";
ALTER TABLE "User" RENAME COLUMN "senha"             TO "password";
ALTER TABLE "User" RENAME COLUMN "email_verificado"  TO "emailVerified";
ALTER TABLE "User" RENAME COLUMN "google_id"         TO "googleId";
ALTER TABLE "User" RENAME COLUMN "versao_sessao"     TO "sessionVersion";
ALTER TABLE "User" RENAME COLUMN "excluido_em"       TO "deletedAt";

-- Group
ALTER TABLE "Group" RENAME COLUMN "nome"             TO "name";
ALTER TABLE "Group" RENAME COLUMN "descricao"        TO "description";
ALTER TABLE "Group" RENAME COLUMN "codigo_convite"   TO "joinCode";
ALTER TABLE "Group" RENAME COLUMN "moeda"            TO "currency";

-- GroupMember
ALTER TABLE "GroupMember" RENAME COLUMN "indice_cor" TO "colorIndex";
ALTER TABLE "GroupMember" RENAME COLUMN "saiu_em"    TO "leftAt";

-- Category / Platform / PaymentMethod
ALTER TABLE "Category"      RENAME COLUMN "grupo_id" TO "groupId";
ALTER TABLE "Category"      RENAME COLUMN "nome"     TO "name";
ALTER TABLE "Platform"      RENAME COLUMN "grupo_id" TO "groupId";
ALTER TABLE "Platform"      RENAME COLUMN "nome"     TO "name";
ALTER TABLE "PaymentMethod" RENAME COLUMN "grupo_id" TO "groupId";
ALTER TABLE "PaymentMethod" RENAME COLUMN "nome"     TO "name";

-- Expense
ALTER TABLE "Expense" RENAME COLUMN "plataforma_id"    TO "platformId";
ALTER TABLE "Expense" RENAME COLUMN "plataforma_ids"   TO "platformIds";
ALTER TABLE "Expense" RENAME COLUMN "descricao"        TO "description";
ALTER TABLE "Expense" RENAME COLUMN "observacao"       TO "notes";
ALTER TABLE "Expense" RENAME COLUMN "categoria"        TO "category";
ALTER TABLE "Expense" RENAME COLUMN "categorias"       TO "categories";
ALTER TABLE "Expense" RENAME COLUMN "plataformas"      TO "platforms";
ALTER TABLE "Expense" RENAME COLUMN "formas_pagamento" TO "paymentMethods";
ALTER TABLE "Expense" RENAME COLUMN "valor"            TO "amount";
ALTER TABLE "Expense" RENAME COLUMN "data"             TO "date";

-- ExpenseParticipant
ALTER TABLE "ExpenseParticipant" RENAME COLUMN "valor" TO "amount";

-- ShoppingItem
ALTER TABLE "ShoppingItem" RENAME COLUMN "nome"           TO "name";
ALTER TABLE "ShoppingItem" RENAME COLUMN "comprado"       TO "isPurchased";
ALTER TABLE "ShoppingItem" RENAME COLUMN "criado_em"      TO "createdAt";
ALTER TABLE "ShoppingItem" RENAME COLUMN "adicionado_por" TO "addedById";

-- Settlement
ALTER TABLE "Settlement" RENAME COLUMN "de_usuario"   TO "fromUserId";
ALTER TABLE "Settlement" RENAME COLUMN "para_usuario" TO "toUserId";
ALTER TABLE "Settlement" RENAME COLUMN "valor"        TO "amount";
ALTER TABLE "Settlement" RENAME COLUMN "observacao"   TO "note";
ALTER TABLE "Settlement" RENAME COLUMN "data"         TO "date";
ALTER TABLE "Settlement" RENAME COLUMN "criado_por"   TO "createdById";

-- AuditLog
ALTER TABLE "AuditLog" RENAME COLUMN "autor"         TO "actorId";
ALTER TABLE "AuditLog" RENAME COLUMN "tipo_entidade" TO "entityType";
ALTER TABLE "AuditLog" RENAME COLUMN "entidade_id"   TO "entityId";
ALTER TABLE "AuditLog" RENAME COLUMN "acao"          TO "action";
ALTER TABLE "AuditLog" RENAME COLUMN "resumo"        TO "summary";
ALTER TABLE "AuditLog" RENAME COLUMN "alteracoes"    TO "changes";

-- EntityRevision
ALTER TABLE "EntityRevision" RENAME COLUMN "tipo_entidade" TO "entityType";
ALTER TABLE "EntityRevision" RENAME COLUMN "entidade_id"   TO "entityId";
ALTER TABLE "EntityRevision" RENAME COLUMN "grupo_id"      TO "groupId";
ALTER TABLE "EntityRevision" RENAME COLUMN "acao"          TO "action";
ALTER TABLE "EntityRevision" RENAME COLUMN "autor"         TO "actorId";
ALTER TABLE "EntityRevision" RENAME COLUMN "antes"         TO "before";
ALTER TABLE "EntityRevision" RENAME COLUMN "depois"        TO "after";

-- Constraint / index / sequence renames are appended by the local rehearsal
-- (prisma migrate diff loop) — see scripts/rename-db-to-english.followup.sql.
