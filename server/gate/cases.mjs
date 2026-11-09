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
]
