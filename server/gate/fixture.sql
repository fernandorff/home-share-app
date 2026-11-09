-- Parity gate data (spec 013, task 2.6): small, fixed, covering the cases the routes branch on.
-- Two houses; Ana admin of Casa, Bruno member, Carla left Casa (ex-member) and is admin of Praia;
-- Davi has no house. Fixed ids and timestamps so both copies are byte-identical.
INSERT INTO "User" ("id", "publicId", "name", "username", "sessionVersion", "createdAt", "updatedAt") VALUES
  (1, '00000000-0000-7000-8000-000000000001', 'Ana', 'ana', 0, '2026-01-01T12:00:00', '2026-01-01T12:00:00'),
  (2, '00000000-0000-7000-8000-000000000002', 'Bruno', 'bruno', 0, '2026-01-01T12:00:00', '2026-01-01T12:00:00'),
  (3, '00000000-0000-7000-8000-000000000003', 'Carla "C"', 'carla', 0, '2026-01-01T12:00:00', '2026-01-01T12:00:00'),
  (4, '00000000-0000-7000-8000-000000000004', 'Davi', 'davi', 0, '2026-01-01T12:00:00', '2026-01-01T12:00:00');
SELECT setval(pg_get_serial_sequence('"User"', 'id'), 4);

INSERT INTO "Group" ("id", "publicId", "name", "description", "joinCode", "currency", "createdAt", "updatedAt") VALUES
  (1, '00000000-0000-7000-8000-000000000101', 'Casa', 'Despesas da casa', 'CASA1234', 'BRL', '2026-01-01T12:00:00', '2026-01-01T12:00:00'),
  (2, '00000000-0000-7000-8000-000000000102', 'Praia', NULL, 'PRAIA567', 'USD', '2026-01-01T12:00:00', '2026-01-01T12:00:00');
SELECT setval(pg_get_serial_sequence('"Group"', 'id'), 2);

INSERT INTO "GroupMember" ("id", "userId", "groupId", "role", "colorIndex", "createdAt", "leftAt") VALUES
  (1, 1, 1, 'ADMIN', 0, '2026-01-01T12:00:00', NULL),
  (2, 2, 1, 'MEMBER', 1, '2026-01-02T12:00:00', NULL),
  (3, 3, 1, 'MEMBER', 2, '2026-01-03T12:00:00', '2026-03-01T12:00:00'),
  (4, 3, 2, 'ADMIN', 0, '2026-01-04T12:00:00', NULL),
  (5, 1, 2, 'MEMBER', 1, '2026-01-05T12:00:00', NULL);
SELECT setval(pg_get_serial_sequence('"GroupMember"', 'id'), 5);

INSERT INTO "Category" ("id", "publicId", "groupId", "name", "createdAt") VALUES
  (1, '00000000-0000-7000-8000-000000000201', 1, 'Pets', '2026-01-01T12:00:00');
SELECT setval(pg_get_serial_sequence('"Category"', 'id'), 1);
INSERT INTO "Platform" ("id", "publicId", "groupId", "name", "createdAt") VALUES
  (1, '00000000-0000-7000-8000-000000000301', 1, 'Feira', '2026-01-01T12:00:00');
SELECT setval(pg_get_serial_sequence('"Platform"', 'id'), 1);
INSERT INTO "PaymentMethod" ("id", "publicId", "groupId", "name", "createdAt") VALUES
  (1, '00000000-0000-7000-8000-000000000401', 1, 'Vale', '2026-01-01T12:00:00');
SELECT setval(pg_get_serial_sequence('"PaymentMethod"', 'id'), 1);

INSERT INTO "Expense" ("id", "publicId", "groupId", "payerId", "description", "notes", "categories", "platforms", "paymentMethods", "amount", "date", "createdAt", "updatedAt") VALUES
  (1, '00000000-0000-7000-8000-000000000501', 1, 1, 'Mercado', NULL, '{groceries,Pets}', '{Feira}', '{Vale}', 100.01, '2026-02-10T12:00:00', '2026-02-10T12:00:00', '2026-02-10T12:00:00'),
  (2, '00000000-0000-7000-8000-000000000502', 1, 2, 'Luz', 'conta de fevereiro', '{}', '{}', '{}', 59.90, '2026-02-15T12:00:00', '2026-02-15T12:00:00', '2026-02-15T12:00:00'),
  (3, '00000000-0000-7000-8000-000000000503', 1, 3, 'Gás', NULL, '{home}', '{}', '{}', 30.00, '2026-01-20T12:00:00', '2026-01-20T12:00:00', '2026-01-20T12:00:00'),
  (4, '00000000-0000-7000-8000-000000000504', 2, 3, 'Aluguel', NULL, '{}', '{}', '{}', 900.00, '2026-03-01T12:00:00', '2026-03-01T12:00:00', '2026-03-01T12:00:00');
SELECT setval(pg_get_serial_sequence('"Expense"', 'id'), 4);

INSERT INTO "ExpenseParticipant" ("id", "expenseId", "userId", "amount") VALUES
  (1, 1, 1, 33.34), (2, 1, 2, 33.34), (3, 1, 3, 33.33),
  (4, 2, 1, 29.95), (5, 2, 2, 29.95),
  (6, 3, 1, 10.00), (7, 3, 2, 10.00), (8, 3, 3, 10.00),
  (9, 4, 3, 450.00), (10, 4, 1, 450.00);
SELECT setval(pg_get_serial_sequence('"ExpenseParticipant"', 'id'), 10);

INSERT INTO "Settlement" ("id", "publicId", "groupId", "fromUserId", "toUserId", "amount", "note", "date", "createdById", "createdAt", "updatedAt") VALUES
  (1, '00000000-0000-7000-8000-000000000601', 1, 2, 1, 20.00, 'pix "parcial"', '2026-02-20T12:00:00', 2, '2026-02-20T12:00:00', '2026-02-20T12:00:00');
SELECT setval(pg_get_serial_sequence('"Settlement"', 'id'), 1);

-- The fixture is written with the triggers on, so the precomputed totals are already right; the versions
-- go back to zero so both copies start equal no matter how many rows were inserted.
UPDATE "GroupVersion" SET v = 0;
