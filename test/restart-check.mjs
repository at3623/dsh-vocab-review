/**
 * Restart-equivalence check: load the plugin from the PROFILE-INSTALLED
 * package (the path DSH resolves after a restart), with the real ledger and
 * settings under <DSH_HOME>/vocab-review, and confirm the queue survives and a
 * fresh process starts in a stopped loop (never asks on its own).
 *
 * Run: node test/restart-check.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const profileDir = join(homedir(), '.dsh', 'profiles', 'desktop')
const installed = join(profileDir, 'node_modules', 'dsh-vocab-review')
const entry = pathToFileURL(join(realpathSync(installed), 'index.js')).href
const { apply } = await import(entry)

const sections = []
const contexts = []
const routes = []
const scoped = {
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get(name) {
    return ctx[name]
  },
  get systemPrompt() {
    return ctx.systemPrompt
  },
}
const agent = { id: 'restart-check', session: { id: 'restart-check' }, ctx: scoped }
const ctx = {
  logger: { info() {}, warn() {} },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  on() {
    return () => {}
  },
  systemPrompt: {
    section(definition) {
      sections.push(definition)
      return () => {}
    },
    context(definition) {
      contexts.push(definition)
      return () => {}
    },
  },
  tools: { register: () => () => {} },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  sessionController: {
    async prompt() {
      return { accepted: true }
    },
    async list() {
      return { items: [] }
    },
  },
  agents: { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) },
  timer: { interval: () => () => {}, timeout: () => () => {} },
}

apply(ctx, {})

const route = routes.find((candidate) => candidate.path === '/api/dsh-vocab-review')
assert.ok(route, 'API route registered from the installed package')
const state = await new Promise((resolve, reject) => {
  const req = { method: 'GET', url: '/api/dsh-vocab-review/state', headers: {}, async *[Symbol.asyncIterator]() {} }
  const res = {
    writeHead(status) {
      this.status = status
    },
    end(raw) {
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    },
  }
  Promise.resolve(route.handler(req, res)).catch(reject)
})
assert.equal(state.ok, true)
assert.ok(state.value.total >= 1)
assert.ok(Array.isArray(state.value.queue))
assert.ok(sections.length >= 1, 'per-agent protocol section registered')
assert.ok(contexts.length >= 1, 'per-agent QUEUE context registered')
assert.equal(state.value.loop === 'running', false, 'a fresh process must not auto-run the loop')
const dataDir = join(homedir(), '.dsh', 'vocab-review')
assert.ok(existsSync(join(dataDir, 'ledger.json')), 'ledger.json exists')
assert.ok(existsSync(join(dataDir, 'settings.json')), 'settings.json exists')
console.log(`PASS installed package resolved: ${entry}`)
console.log(`PASS restart load: loop=${state.value.loop} total=${state.value.total} queue=${state.value.queue.slice(0, 6).join(',')}`)
