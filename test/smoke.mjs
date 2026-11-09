/**
 * Smoke test for the Host half, against a real Web listener and a real tunnel.
 *
 * It mounts the plugin on a fake Context whose `webServer.port` points at a
 * running `dsh --profile web` listener, then exercises the whole Settings path:
 * the switch starts from off, `/enable` attaches the route, `/state` reports it,
 * `/link` and `/qr` hand back the tokenised URL, and `/disable` closes it again.
 * Then it walks the browser flow over the public HTTPS URL — no token, token
 * exchange, index, `/api`, WebSocket upgrade — because the rewriting proxy is
 * what makes `/api` answer instead of 403.
 *
 * Usage: node test/smoke.mjs <token-do-DSH> [targetPort]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import https from 'node:https'
import crypto from 'node:crypto'
import { apply, Config } from '../index.js'

const TOKEN = process.argv[2]
const TARGET = Number(process.argv[3] ?? 3099)
if (TOKEN === undefined) {
  console.error('uso: node test/smoke.mjs <token> [porta-alvo]')
  process.exit(2)
}

const routes = new Map()
const tools = new Map()
const disposers = []
const injectors = []

const ctx = {
  webServer: {
    port: TARGET,
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  tools: {
    register(tool) {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    },
  },
  on(event, listener) {
    if (event === 'webserver/index-inject') injectors.push(listener)
  },
  effect(fn) {
    disposers.push(fn())
  },
  get(service) {
    if (service === 'connection') return { authenticatedUrl: (url) => `${url}?token=${TOKEN}` }
    return undefined
  },
}

apply(ctx, Config({ profile: 'dsh-e2e', rewrite: true, printLink: false, enabled: false, linkFile: 'link.txt' }))

const table = []
for (const inject of injectors) inject(table)
const panelToken = table.find((row) => row.name === '__DSH_OPENTUNNEL__')?.value?.token
if (panelToken === undefined) {
  console.error('o plugin não injetou __DSH_OPENTUNNEL__')
  process.exit(1)
}
const headers = { 'x-dsh-opentunnel': panelToken }
const base = '/opentunnel'

const get = async (path, extra) => {
  const response = await routes.get(`${base}${path}`).resource(new Request(`http://local${base}${path}`, { headers: { ...headers, ...extra } }))
  return { status: response.status, body: await response.json() }
}

/** Drive a POST route through its node handler, returning status and body. */
const post = async (path, method = 'POST') =>
  new Promise((resolve) => {
    const res = {
      writeHead(status) {
        this.status = status
      },
      end(body) {
        resolve({ status: this.status, body: JSON.parse(body) })
      },
    }
    void routes.get(`${base}${path}`).handler({ method, headers, resume() {} }, res)
  })

const waitFor = async (predicate, label) => {
  for (let i = 0; i < 90; i++) {
    const value = await get('/state')
    if (predicate(value.body)) return value.body
    if (value.body.phase === 'error') throw new Error(`${label}: ${value.body.error}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`${label}: timeout`)
}

const checks = []
const check = (label, ok) => checks.push([label, ok === true])

// ── o interruptor ──────────────────────────────────────────────────────────
const initial = await get('/state')
check('boot começa desligado (config enabled:false)', initial.body.enabled === false && initial.body.phase === 'off')
check('sem o token da página -> 401', (await get('/state', { 'x-dsh-opentunnel': 'errado' })).status === 401)
check('GET em /enable -> 405', (await post('/enable', 'GET')).status === 405)

const enabled = await post('/enable')
check('/enable responde ok', enabled.body.ok === true && enabled.body.enabled === true)
const connected = await waitFor((state) => state.phase === 'connected', 'enable')
const clean = connected.url
check('rota pública anexou', clean?.startsWith('https://') === true)
check('proxy de reescrita de pé', connected.rewrite === true && connected.proxyPort > 0)

const link = await get('/link')
const hostname = new URL(clean).hostname
const code = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'opentunnel.json'), 'utf8')).entryCode
check('/link devolve o link permanente', link.body.url === `https://${hostname}/e/${code}` && link.body.durable === true)
const qr = await get('/qr')
check('/qr devolve SVG do link permanente', qr.body.svg.startsWith('<svg') && qr.body.url === link.body.url)

// ── a porta permanente e o fluxo do celular ────────────────────────────────
const door = await fetch(`${clean}/e/${code}`, { redirect: 'manual' })
const doorTo = door.headers.get('location') ?? ''
check('porta permanente -> 302 com o token atual', door.status === 302 && doorTo.includes(`token=${TOKEN}`))

const wrongCode = await fetch(`${clean}/e/${'0'.repeat(32)}`, { redirect: 'manual' })
check('código errado -> 403', wrongCode.status === 403)

const unauth = await fetch(`${clean}/`, { redirect: 'manual' })
check('sem token no celular -> 401', unauth.status === 401)

const exchange = await fetch(doorTo, { redirect: 'manual' })
const cookie = (exchange.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ')
check('troca do token -> 303 + cookie', exchange.status === 303 && cookie.length > 0)

const index = await fetch(`${clean}/`, { redirect: 'manual', headers: { cookie } })
const html = await index.text()
check('index com cookie -> 200', index.status === 200 && html.includes('id="root"'))

const api = await fetch(`${clean}/api/rpc`, {
  method: 'POST',
  redirect: 'manual',
  headers: { cookie, 'content-type': 'application/json' },
  body: '{}',
})
check('/api não reprovado pelo fence', api.status !== 403 && api.status !== 401)

const ws = await new Promise((resolve) => {
  const req = https.request({
    host: new URL(clean).hostname,
    port: 443,
    path: '/api/remote.mux',
    method: 'GET',
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
      'sec-websocket-version': '13',
      cookie,
    },
  })
  req.on('upgrade', (res, socket) => {
    socket.destroy()
    resolve(res.statusCode)
  })
  req.on('response', (res) => {
    res.resume()
    resolve(res.statusCode)
  })
  req.on('error', (e) => resolve(`erro ${e.message}`))
  req.end()
  setTimeout(() => resolve('timeout'), 20000)
})
check('upgrade WebSocket -> 101', ws === 101)

// ── desligar ───────────────────────────────────────────────────────────────
const disabled = await post('/disable')
check('/disable desliga', disabled.body.ok === true && disabled.body.enabled === false)
const off = await waitFor((state) => state.phase === 'off', 'disable')
check('rota fechada', off.url === '')
const deadLink = await get('/link')
check('/link recusa sem rota (409)', deadLink.status === 409)

// ── e a ferramenta do agente ───────────────────────────────────────────────
const tool = await tools.get('opentunnel').execute({}, { signal: undefined })
check('tool diz desligado e não vaza o token', tool.enabled === false && !JSON.stringify(tool).includes(TOKEN))

console.log(`\n${checks.filter(([, ok]) => ok).length}/${checks.length} verificações`)
for (const [label, ok] of checks) console.log(`${ok ? ' ok ' : 'FAIL'} ${label}`)
console.log(`\nurl: ${clean} · /api: ${api.status} · ws: ${ws} · html: ${html.length} bytes`)

for (const dispose of disposers.reverse()) await dispose?.()
await new Promise((r) => setTimeout(r, 1500))
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
