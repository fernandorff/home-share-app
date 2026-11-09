// Parity gate (spec 013, task 2.6, criteria 1-3): the same requests against the Next app and the Rust server,
// each on its own copy of the same database; the answers (status + JSON) and, after every write, the rows of
// every table must match. Values that are random or "now" (UUIDs, fresh timestamps) are normalized.
//
//   node server/gate/gate.mjs reset          # (re)create gate_a and gate_b: migrations + fixture.sql
//   node server/gate/gate.mjs run [filter]   # run the cases whose name contains [filter]
//
// Env: GATE_PG (admin URL of the gate's own Postgres), NEXT_URL (server on gate_a), RUST_URL (server on gate_b),
// JWT_SECRET (the same in both servers). Never point GATE_PG at a real database: reset drops gate_a/gate_b.
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { SignJWT } from 'jose'
import { cases } from './cases.mjs'

// timestamp columns are UTC wall time: read them as text, never in this machine's zone.
pg.types.setTypeParser(1114, (text) => text)
const here = dirname(fileURLToPath(import.meta.url))
const { GATE_PG, NEXT_URL, RUST_URL, JWT_SECRET } = process.env
const dbUrl = (name) => GATE_PG.replace(/\/[^/?]*(\?|$)/, `/${name}$1`)

async function reset() {
  const admin = new pg.Client({ connectionString: GATE_PG })
  await admin.connect()
  const migrations = join(here, '../../prisma/migrations')
  const dirs = readdirSync(migrations, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  dirs.sort((a, b) => parseInt(a) - parseInt(b))
  for (const name of ['gate_a', 'gate_b']) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${name}`)
    const db = new pg.Client({ connectionString: dbUrl(name) })
    await db.connect()
    for (const dir of dirs) await db.query(readFileSync(join(migrations, dir, 'migration.sql'), 'utf8'))
    await db.query(readFileSync(join(here, 'fixture.sql'), 'utf8'))
    await db.end()
  }
  await admin.end()
  console.log(`reset: gate_a and gate_b from ${dirs.length} migrations + fixture`)
}

// Fixture users (fixture.sql): sessionVersion 0 for all.
const USERS = { ana: [1, '00000000-0000-7000-8000-000000000001', 'Ana'], bruno: [2, '00000000-0000-7000-8000-000000000002', 'Bruno'],
  carla: [3, '00000000-0000-7000-8000-000000000003', 'Carla "C"'], davi: [4, '00000000-0000-7000-8000-000000000004', 'Davi'] }

async function cookieFor(c, side) {
  const parts = []
  // `useSession: 'x'`: the session cookie this side handed out on an earlier case with `saveSession: 'x'`.
  if (c.useSession) parts.push(`homeshare_session=${sessions[side][c.useSession] ?? ''}`)
  if (c.as) {
    const [userId, publicId, name] = USERS[c.as]
    const token = await new SignJWT({ userId, publicId, name, sessionVersion: c.sessionVersion ?? 0, authAt: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('30d').sign(new TextEncoder().encode(JWT_SECRET))
    parts.push(`homeshare_session=${token}`)
  }
  if (c.rawSession) parts.push(`homeshare_session=${c.rawSession}`)
  if (c.house) parts.push(`homeshare_group=${c.house}`)
  return parts.join('; ')
}

const WRITTEN_AFTER_RESPONSE = new Set(['EntityRevision', 'Notification'])
const UNORDERED = new Set(['payerTotals', 'monthTotals', 'payerMonthTotals'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FIXTURE_UUID = /^00000000-0000-7000-8000-/
const JOIN_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/

/** Fresh UUIDs become #1, #2... in order of appearance; timestamps from the last hour become <now>. */
function normalize(value, uuids = new Map()) {
  if (value instanceof Date) value = value.toISOString()
  if (typeof value === 'string') {
    if (UUID.test(value) && !FIXTURE_UUID.test(value)) {
      if (!uuids.has(value)) uuids.set(value, `#uuid${uuids.size + 1}`)
      return uuids.get(value)
    }
    if (ISO.test(value) && Math.abs(Date.parse(value.replace(' ', 'T').replace(/Z?$/, 'Z')) - Date.now()) < 3600_000) return '<now>'
    return value
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, uuids))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      // A fresh join code is random on each side: only its format must match.
      if (k === 'joinCode' && typeof v === 'string' && JOIN_CODE.test(v)) return [k, '<joinCode>']
      // bcrypt salts are random: only the format must match.
      if (k === 'password' && typeof v === 'string' && /^\$2[aby]\$10\$[./A-Za-z0-9]{53}$/.test(v)) return [k, '<bcrypt>']
      const n = normalize(v, uuids)
      // Prisma groupBy has no ORDER BY: these lists come in whatever order Postgres groups them.
      return [k, UNORDERED.has(k) && Array.isArray(n) ? [...n].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))) : n]
    }))
  }
  return value
}

// `save: 'x'` keeps each side's raw answer; `{x.a.b}` in a later path or body reads it back on the same side
// (ids and timestamps a server generated differ between the two, so each side uses its own).
const saved = { next: {}, rust: {} }
const sessions = { next: {}, rust: {} }
const fill = (text, side) => text.replace(/\{(\w+)\.([\w.]+)\}/g, (_, name, path) => path.split('.').reduce((v, k) => v?.[k], saved[side][name]) ?? '')

async function call(base, c, side) {
  const path = fill(c.path, side)
  const payload = c.body === undefined ? undefined : fill(JSON.stringify(c.body), side)
  const headers = { cookie: await cookieFor(c, side), ...(c.headers ?? {}) }
  let request = payload
  if (c.body !== undefined) headers['content-type'] = 'application/json'
  // `form`: a multipart upload like the browser's FormData ({ file: { name, text }, field: 'value' }).
  if (c.form) {
    request = new FormData()
    for (const [k, v] of Object.entries(c.form)) {
      if (v && typeof v === 'object') request.append(k, new Blob([v.text], { type: 'text/csv' }), v.name)
      else request.append(k, fill(String(v), side))
    }
  }
  if (c.text !== undefined) { headers['content-type'] = 'text/plain'; request = c.text }
  const res = await fetch(base + path, { method: c.method ?? 'GET', headers, body: request, redirect: 'manual' })
  const text = await res.text()
  let body = text
  try { body = text ? JSON.parse(text) : null } catch {}
  if (c.save) saved[side][c.save] = body
  if (c.saveSession) {
    const set = res.headers.getSetCookie().map((v) => v.split(';')[0]).find((v) => v.startsWith('homeshare_session=') && v.length > 'homeshare_session='.length)
    if (set) sessions[side][c.saveSession] = set.slice('homeshare_session='.length)
  }
  // Revision ids come from the Next app's after-response writes, whose order can swap: cases that show them opt out.
  if (c.revisionIdsFree && body?.revisions) body.revisions = body.revisions.map(({ id, ...rest }) => rest)
  // The Next app stores a batch of revisions with one timestamp, and Postgres returns ties in no set order.
  // Fresh UUIDs lose their numbering here (it follows the order of appearance, which is what is being ignored).
  if (c.revisionsAsSet && body?.revisions) {
    const unnumbered = JSON.parse(JSON.stringify(normalize(body.revisions)).replace(/#uuid\d+/g, '#uuid'))
    body.revisions = unnumbered.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
  }
  return { status: res.status, body: normalize(body), setCookie: res.headers.get('set-cookie') ? 'set' : null }
}

async function dump(name) {
  const db = new pg.Client({ connectionString: dbUrl(name) })
  await db.connect()
  const { rows: tables } = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY 1`)
  const out = {}
  const uuids = new Map()
  for (const { table_name } of tables) {
    let rows = normalize((await db.query(`SELECT * FROM "${table_name}" ORDER BY 1, 2`)).rows, uuids)
    // The Next app writes these after the response (after()), so two quick requests can swap their ids:
    // compare them as a set of rows, without the id.
    if (WRITTEN_AFTER_RESPONSE.has(table_name)) rows = rows.map(({ id, ...rest }) => rest).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
    out[table_name] = rows
  }
  await db.end()
  return out
}

function firstDifference(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDifference(a[k], b[k], `${path}.${k}`)
      if (d) return d
    }
    return null // same keys and values, only in another order
  }
  return `${path || '(root)'}: next=${JSON.stringify(a)?.slice(0, 200)} rust=${JSON.stringify(b)?.slice(0, 200)}`
}

async function run(filter) {
  let failed = 0
  for (const c of cases.filter((c) => !filter || c.name.includes(filter))) {
    const [a, b] = [await call(NEXT_URL, c, 'next'), await call(RUST_URL, c, 'rust')]
    let diff = firstDifference(a, b)
    if (!diff && c.method && c.method !== 'GET') {
      await new Promise((r) => setTimeout(r, 300)) // Next writes the audit revision after the response (after())
      diff = firstDifference(await dump('gate_a'), await dump('gate_b'))
    }
    console.log(`${diff ? 'FAIL' : 'ok  '} ${c.name} (${a.status})${diff ? `\n     ${diff}` : ''}`)
    if (diff) failed++
  }
  console.log(failed ? `${failed} case(s) differ` : 'all cases equal')
  process.exitCode = failed ? 1 : 0
}

const [command, filter] = process.argv.slice(2)
if (command === 'reset') await reset()
else if (command === 'run') await run(filter)
else console.log('usage: gate.mjs reset | run [filter]')
