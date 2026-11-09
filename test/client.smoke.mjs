/**
 * Smoke test for the Web half without a DOM.
 *
 * The module registers itself through `window.__ModuleLoader__`, so this file
 * shims that loader, a minimal hook runtime, and the slots registry: it can then
 * assert what the settings section registers, how a phase reads, and that the
 * section's first render produces the copy the user sees. It catches the failure
 * that matters before a restart — a section that throws while rendering.
 *
 * Usage: node test/client.smoke.mjs
 */
import { readFileSync } from 'node:fs'

/** Hook state for one render pass: a tiny, honest stand-in for React. */
const hooks = []
let cursor = 0

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }
  },
  useState(initial) {
    const at = cursor++
    if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial
    return [
      hooks[at],
      (value) => {
        hooks[at] = typeof value === 'function' ? value(hooks[at]) : value
      },
    ]
  },
  useEffect() {
    cursor++
  },
  useRef(initial) {
    const at = cursor++
    if (!(at in hooks)) hooks[at] = { current: initial }
    return hooks[at]
  },
  useCallback(fn) {
    cursor++
    return fn
  },
}

let loaded
let moduleId
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      moduleId = module.id
      loaded = module.factory((specifier) => {
        if (specifier !== 'react') throw new Error(`require(${specifier}) inesperado`)
        return React
      })
    },
  },
}

await import('../client.js')

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const checks = []
const check = (label, ok) => checks.push([label, ok === true])

check('módulo carregou com o id do pacote', loaded !== undefined)
check('id do módulo é o nome do pacote', moduleId === manifest.name)
check('inject declara slots', JSON.stringify(loaded.inject) === '["slots"]')

// ── registro nos slots ─────────────────────────────────────────────────────
const registrations = []
const ctx = {
  slots: {
    inject(name, callback) {
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
loaded.apply(ctx)

const section = registrations.find((entry) => entry.options.name === 'settings.section')
const icon = registrations.find((entry) => entry.options.name === 'settings.section.icon')
check('registra uma seção em Configurações', section?.options.id === 'opentunnel' && section.options.label === 'OpenTunnel')
check('registra o ícone com o mesmo id', icon?.options.id === 'opentunnel')

// ── texto de estado ────────────────────────────────────────────────────────
const { phaseText } = loaded.__test
check('fase connected lê "ligado"', phaseText('connected', true) === 'ligado')
check('fase off desligada lê "desligado"', phaseText('off', false) === 'desligado')
check('fase starting lê "conectando"', phaseText('starting', true) === 'conectando')

// ── primeira renderização da seção ─────────────────────────────────────────
const tree = section.component({ close() {} })
const text = []
const walk = (node) => {
  if (node === undefined || node === null || node === false) return
  if (typeof node === 'string' || typeof node === 'number') {
    text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child)
    return
  }
  if (node.props !== undefined) {
    const { children } = node.props
    if (Array.isArray(children)) for (const child of children) walk(child)
    else walk(children)
  }
}
walk(tree)
const copy = text.join(' ')
check('renderiza sem lançar', tree !== undefined && tree !== null)
check('mostra o título', copy.includes('OpenTunnel'))
check('mostra o interruptor', copy.includes('Túnel público'))
check('mostra o estado inicial', copy.includes('Lendo o estado'))

const iconTree = loaded.__test.OpenTunnelIcon({ size: 16 })
check('ícone é um svg', iconTree?.type === 'svg')

console.log(`\n${checks.filter(([, ok]) => ok).length}/${checks.length} verificações`)
for (const [label, ok] of checks) console.log(`${ok ? ' ok ' : 'FAIL'} ${label}`)
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
