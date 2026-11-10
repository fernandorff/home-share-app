// Screenshot comparison of every page (spec 013, task 4.3, criteria 19-20): the same pages, same data and same
// clock on BEFORE (the Next app) and AFTER (the Vite build — `vite preview` today, the Rust server once 4.2
// lands), on a phone and a desktop viewport, in the default theme (English) and the bolitas theme (Portuguese);
// every pixel compared in the browser itself, no extra dependency. Out of scope: modals, menus, hover/focus,
// empty or loading states — those are covered by the E2E test, not by pixels.
//
//   node server/gate/screens.mjs <BEFORE_URL> <AFTER_URL> [outDir]
//
// Both URLs must be http://localhost:<port> (the session cookie is Secure under `next start`; browsers accept it
// over http on localhost only) and must read the same database: the script seeds it through BEFORE's API on the
// first run (a later run checks the seed is complete). Signs in once per side and variant (the login rate limit
// is 30/min). Writes before/after/diff PNGs for every differing screen to outDir (default screens-out/) and
// exits 1 when any screen differs or a page did not end on its own URL with its data loaded.
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const [BEFORE, AFTER, OUT = 'screens-out'] = process.argv.slice(2)
if (!BEFORE || !AFTER) throw new Error('usage: node server/gate/screens.mjs <BEFORE_URL> <AFTER_URL> [outDir]')
const PASSWORD = 'screens-password-123'
const OWNER = { name: 'Screens Owner', username: 'screens-owner', password: PASSWORD }
const MEMBER = { name: 'Screens Member', username: 'screens-member', password: PASSWORD }
const NOW = new Date('2026-11-10T12:00:00')
const VIEWPORTS = { phone: { width: 412, height: 915 }, desktop: { width: 1280, height: 900 } }
const VARIANTS = { default: { theme: 'default', locale: 'en' }, bolitas: { theme: 'bolitas', locale: 'pt' } }
// Exact pixels, except a channel off by at most 1/255: the edge anti-aliasing of a rounded corner on a
// fractional-width box differed by that much between two identical computed styles (shopping input, 2026-11-09).
const MAX_DELTA = 1

// Every page.tsx under src/app (route groups add no segment); "/" is a redirect, not a screen.
const appDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/app')
const pages = (function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'api' ? [] : walk(path)
    if (name !== 'page.tsx') return []
    const url = '/' + relative(appDir, dir).split(/[\\/]/).filter((s) => s && !/^\(.*\)$/.test(s)).join('/')
    return url === '/' ? [] : [url]
  })
})(appDir).sort()

async function seed(browser) {
  const ctx = await browser.newContext({ baseURL: BEFORE })
  const api = ctx.request
  const call = async (method, path, data) => {
    const res = await api.fetch(path, { method, data })
    if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`)
    return res.json()
  }
  const register = await api.post('/api/auth/register', { data: OWNER })
  if (register.status() === 409) {
    // Already seeded: make sure a previous run did not die halfway (shopping items are created last).
    await call('POST', '/api/auth/login', { username: OWNER.username, password: PASSWORD })
    const { items } = await call('GET', '/api/shopping-items')
    if (items.length !== 8) throw new Error(`incomplete seed (${items.length}/8 shopping items): use a fresh database`)
    return ctx.close()
  }
  if (!register.ok()) throw new Error(`register → ${register.status()} ${await register.text()}`)
  const other = await browser.newContext({ baseURL: BEFORE })
  await other.request.post('/api/auth/register', { data: MEMBER })
  const { group } = await call('POST', '/api/groups', { name: 'Screens House' })
  await other.request.post('/api/groups/join', { data: { code: group.joinCode } })
  const me = (await call('GET', '/api/auth/me')).user
  const them = (await (await other.request.get('/api/auth/me')).json()).user
  for (let i = 1; i <= 24; i++) {
    await call('POST', '/api/expenses', {
      description: `Groceries ${i}`, amount: 10 + i * 1.37, date: `2026-${i > 12 ? 11 : 10}-${String((i % 12) + 1).padStart(2, '0')}`,
      payerId: i % 3 ? me.id : them.id, splitEqually: true, participants: [{ userId: me.id }, { userId: them.id }],
    })
  }
  for (let i = 1; i <= 8; i++) await call('POST', '/api/shopping-items', { name: `Milk ${i}` })
  await other.close()
  await ctx.close()
}

async function sideContext(browser, origin, viewport, { theme, locale }, signedIn) {
  const ctx = await browser.newContext({ baseURL: origin, viewport, reducedMotion: 'reduce' })
  const url = origin
  await ctx.addCookies([{ name: 'homeshare_theme', value: theme, url }, { name: 'locale', value: locale, url }])
  if (signedIn) {
    const res = await ctx.request.post('/api/auth/login', { data: { username: OWNER.username, password: PASSWORD } })
    if (!res.ok()) throw new Error(`login on ${origin} → ${res.status()}`)
  }
  return ctx
}

async function shoot(ctx, path) {
  const page = await ctx.newPage()
  await page.clock.setFixedTime(NOW)
  await page.goto(path, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(500)
  // The same picture on both sides proves nothing if both bounced to the login page or are still loading.
  const at = new URL(page.url()).pathname
  if (at !== path) throw new Error(`${path} ended on ${at}`)
  if (await page.locator('.skeleton').count()) throw new Error(`${path} still shows skeletons`)
  const png = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' })
  await page.close()
  return png
}

// Pixel comparison inside a blank page: both PNGs on canvases, count the pixels any channel of which differs.
async function compare(page, a, b) {
  return page.evaluate(async ([a, b]) => {
    const load = (b64) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('bad png')); i.src = 'data:image/png;base64,' + b64 })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height)
    const data = (img) => { const c = new OffscreenCanvas(w, h), x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h) }
    const da = data(ia).data, db = data(ib).data
    if (!da.some((v) => v) || !db.some((v) => v)) throw new Error('blank screenshot (canvas too large?)')
    const out = new OffscreenCanvas(w, h), ox = out.getContext('2d'), diff = ox.createImageData(w, h)
    let differing = 0, maxDelta = 0
    for (let p = 0; p < da.length; p += 4) {
      const delta = Math.max(Math.abs(da[p] - db[p]), Math.abs(da[p + 1] - db[p + 1]), Math.abs(da[p + 2] - db[p + 2]), Math.abs(da[p + 3] - db[p + 3]))
      if (delta > maxDelta) maxDelta = delta
      const off = delta > 0
      if (off) differing++
      diff.data.set(off ? [255, 0, 0, 255] : [da[p], da[p + 1], da[p + 2], 60], p)
    }
    ox.putImageData(diff, 0, 0)
    const blob = await out.convertToBlob({ type: 'image/png' })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let bin = ''; for (const byte of bytes) bin += String.fromCharCode(byte)
    return { differing, maxDelta, total: w * h, sameSize: ia.width === ib.width && ia.height === ib.height, size: [ia.width, ia.height, ib.width, ib.height], diff: btoa(bin) }
  }, [a.toString('base64'), b.toString('base64')])
}

const browser = await chromium.launch()
await seed(browser)
mkdirSync(OUT, { recursive: true })
const blank = await (await browser.newContext()).newPage()
let failures = 0
for (const [variant, prefs] of Object.entries(VARIANTS)) {
  for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
    const ctx = {}
    for (const [side, origin] of [['before', BEFORE], ['after', AFTER]]) {
      ctx[side] = {
        in: await sideContext(browser, origin, viewport, prefs, true),
        out: await sideContext(browser, origin, viewport, prefs, false),
      }
    }
    for (const path of pages) {
      const which = path.startsWith('/auth/') ? 'out' : 'in'
      const before = await shoot(ctx.before[which], path)
      const after = await shoot(ctx.after[which], path)
      const r = await compare(blank, before, after)
      const same = r.sameSize && r.maxDelta <= MAX_DELTA
      if (!same) {
        failures++
        const base = join(OUT, `${variant}-${vp}-${path.slice(1).replaceAll('/', '_')}`)
        writeFileSync(`${base}-before.png`, before)
        writeFileSync(`${base}-after.png`, after)
        writeFileSync(`${base}-diff.png`, Buffer.from(r.diff, 'base64'))
      }
      const size = r.sameSize ? '' : `  size ${r.size[0]}x${r.size[1]} → ${r.size[2]}x${r.size[3]}`
      const pct = ((100 * r.differing) / r.total).toFixed(3)
      console.log(`${same ? (r.differing ? 'same±1' : 'same  ') : 'DIFF  '}  ${variant.padEnd(8)} ${vp.padEnd(7)} ${path.padEnd(26)} ${pct}% of pixels, max delta ${r.maxDelta}${size}`)
    }
    for (const side of Object.values(ctx)) {
      await side.in.close()
      await side.out.close()
    }
  }
}
await browser.close()
console.log(failures ? `${failures} screen(s) differ — see ${OUT}/` : `every screen identical (max ${MAX_DELTA}/255 per channel)`)
process.exit(failures ? 1 : 0)
