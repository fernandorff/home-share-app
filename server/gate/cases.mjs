// Parity gate cases (spec 013). Run in order: writes change both databases the same way, so later cases see
// the effects of earlier ones. `as` = fixture user (ana, bruno, carla, davi); `house` = homeshare_group cookie.
export const cases = [
  // health
  { name: 'health', path: '/api/health' },
  { name: 'health db', path: '/api/health?db=1' },

  // balances (also covers the API gate, the session check and the active house)
  { name: 'balances no cookie', path: '/api/balances' },
  { name: 'balances garbage token', path: '/api/balances', rawSession: 'garbage' },
  { name: 'balances revoked session', path: '/api/balances', as: 'ana', sessionVersion: 9 },
  { name: 'balances no house', path: '/api/balances', as: 'davi' },
  { name: 'balances ana casa', path: '/api/balances', as: 'ana' },
  { name: 'balances ana praia', path: '/api/balances', as: 'ana', house: 2 },
  { name: 'balances carla left casa -> praia', path: '/api/balances', as: 'carla', house: 1 },
  { name: 'balances bruno other house cookie', path: '/api/balances', as: 'bruno', house: 2 },

  // settlements (task 3.3)
  { name: 'settlements list', path: '/api/settlements', as: 'ana' },
  { name: 'settlement users required', method: 'POST', path: '/api/settlements', as: 'ana', body: { toUserId: 1, amount: 10 } },
  { name: 'settlement same user', method: 'POST', path: '/api/settlements', as: 'ana', body: { fromUserId: 1, toUserId: 1, amount: 10 } },
  { name: 'settlement amount zero', method: 'POST', path: '/api/settlements', as: 'ana', body: { fromUserId: 2, toUserId: 1, amount: 0 } },
  { name: 'settlement amount precision', method: 'POST', path: '/api/settlements', as: 'ana', body: { fromUserId: 2, toUserId: 1, amount: 1.005 } },
  { name: 'settlement amount too high', method: 'POST', path: '/api/settlements', as: 'ana', body: { fromUserId: 2, toUserId: 1, amount: 100000000 } },
  { name: 'settlement note too long', method: 'POST', path: '/api/settlements', as: 'ana', body: { fromUserId: 2, toUserId: 1, amount: 1, note: 'x'.repeat(501) } },
  { name: 'settlement bad date', method: 'POST', path: '/api/settlements', as: 'ana', body: { fromUserId: 2, toUserId: 1, amount: 1, date: '2026-02-30' } },
  { name: 'settlement not a member', method: 'POST', path: '/api/settlements', as: 'ana', body: { fromUserId: 4, toUserId: 1, amount: 1 } },
  { name: 'settlement bruno pays ana (notice to ana)', method: 'POST', path: '/api/settlements', as: 'bruno', body: { fromUserId: 2, toUserId: 1, amount: 12.3, note: 'pix "março"', date: '2026-03-05' } },
  { name: 'settlement recorded by the recipient (no notice)', method: 'POST', path: '/api/settlements', as: 'ana', body: { fromUserId: 2, toUserId: 1, amount: 0.07, date: '2026-03-06T15:30:00.000Z' } },
  { name: 'settlement with the ex-member', method: 'POST', path: '/api/settlements', as: 'ana', body: { fromUserId: 1, toUserId: 3, amount: 5 } },
  { name: 'settlement delete invalid id', method: 'DELETE', path: '/api/settlements/nope', as: 'ana' },
  { name: 'settlement delete not found', method: 'DELETE', path: '/api/settlements/0190f4b3-7c2e-7a1b-9c3d-123456789abc', as: 'ana' },
  { name: 'settlement delete from another house', method: 'DELETE', path: '/api/settlements/00000000-0000-7000-8000-000000000601', as: 'carla' },
  { name: 'settlement delete', method: 'DELETE', path: '/api/settlements/00000000-0000-7000-8000-000000000601', as: 'bruno' },
  { name: 'settlements list after writes', path: '/api/settlements', as: 'ana' },
  { name: 'balances after settlements', path: '/api/balances', as: 'ana' },

  // expenses: list and detail (task 3.2)
  { name: 'expenses default', path: '/api/expenses', as: 'ana' },
  { name: 'expenses page 2 size 2 asc amount', path: '/api/expenses?page=2&pageSize=2&sortField=amount&sortDirection=asc', as: 'ana' },
  { name: 'expenses sort payer', path: '/api/expenses?sortField=payer', as: 'ana' },
  { name: 'expenses sort description asc', path: '/api/expenses?sortField=description&sortDirection=asc', as: 'ana' },
  { name: 'expenses sort createdAt', path: '/api/expenses?sortField=createdAt', as: 'ana' },
  { name: 'expenses bad sort', path: '/api/expenses?sortField=notes', as: 'ana' },
  { name: 'expenses junk paging', path: '/api/expenses?page=-3&pageSize=abc', as: 'ana' },
  { name: 'expenses totals', path: '/api/expenses?includePayerTotals=true&includeMonthTotals=true', as: 'ana' },
  { name: 'expenses filters', path: '/api/expenses?payerIds=1&payerIds=x&payerIds=3&categories=Pets&categories=home&fromDate=2026-01-20&toDate=2026-02-10&includeMonthTotals=true', as: 'ana' },
  { name: 'expenses tags', path: '/api/expenses?platforms=Feira&paymentMethods=Vale', as: 'ana' },
  { name: 'expenses query text', path: '/api/expenses?query=%20FEV%20', as: 'ana' },
  { name: 'expenses query payer name', path: '/api/expenses?query=brun', as: 'ana' },
  { name: 'expenses query percent', path: '/api/expenses?query=%25', as: 'ana' },
  { name: 'expenses query underscore', path: '/api/expenses?query=_', as: 'ana' },
  { name: 'expenses bad date filter', path: '/api/expenses?fromDate=2026-13-01&toDate=x', as: 'ana' },
  { name: 'expenses feb 30 filter', path: '/api/expenses?toDate=2026-02-30', as: 'ana' },
  { name: 'expenses other house', path: '/api/expenses', as: 'ana', house: 2 },
  { name: 'expense detail', path: '/api/expenses/00000000-0000-7000-8000-000000000501', as: 'ana' },
  { name: 'expense detail other house', path: '/api/expenses/00000000-0000-7000-8000-000000000504', as: 'ana' },
  { name: 'expense detail bad id', path: '/api/expenses/123', as: 'ana' },
]
