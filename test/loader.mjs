/**
 * Resolve `@deepseek-ai/*` for the Host smoke test only.
 *
 * The plugin lives in this repository, but the DSH packages it imports live in a
 * global CLI install (a profile resolves them from its own `node_modules`). A
 * junction would need a privilege the sandbox withholds, so the test redirects
 * those bare specifiers with a resolve hook instead.
 *
 *   DSH_CLI_ROOT="$(npm root -g)/@deepseek-ai/dsh" node --import ./test/loader.mjs test/smoke.mjs …
 */
import { register } from 'node:module'

register(new URL('./resolve-hook.mjs', import.meta.url))
