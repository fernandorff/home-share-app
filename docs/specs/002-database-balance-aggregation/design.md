# Database balance aggregation — Design

`BalanceService.aggregate(groupId)` owns the production Prisma queries. PostgreSQL performs two
grouped sums: expense amounts by payer and participant amounts by user, both scoped through the
expense's `groupId`. The service converts every Decimal sum to integer cents before subtraction and
returns the existing numeric `Balance` boundary type.

The route remains responsible for orchestration: it loads aggregated balances, settlements and
insight rows in parallel, then uses the pure Node.js `applySettlements` and `simplifyDebts` rules.
Integration tests use the in-process PostgreSQL-compatible test database and invoke the service,
eliminating the duplicate in-memory expense aggregation.
