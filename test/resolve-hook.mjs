/**
 * Resolve hook: bare `@deepseek-ai/*` specifiers come from a global DSH install.
 *
 * A plugin installed inside a profile resolves those packages through the
 * profile's own `node_modules`. This repository lives outside one, so the smoke
 * test points at a global CLI install instead:
 *
 *   DSH_CLI_ROOT="$(npm root -g)/@deepseek-ai/dsh"
 */
import { createRequire } from 'node:module'

const root = process.env.DSH_CLI_ROOT
if (root === undefined || root.length === 0) {
  throw new Error(
    'test/resolve-hook: defina DSH_CLI_ROOT para o install global do CLI, por exemplo DSH_CLI_ROOT="$(npm root -g)/@deepseek-ai/dsh"',
  )
}

const globalRequire = createRequire(new URL('package.json', `file:///${root.replaceAll('\\', '/')}/`))

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    try {
      const path = globalRequire.resolve(specifier).replaceAll('\\', '/')
      return { url: new URL(`file:///${path}`).href, shortCircuit: true }
    } catch {
      /* not a package: fall through to the normal resolver */
    }
  }
  return next(specifier, context)
}
