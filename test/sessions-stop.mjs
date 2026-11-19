/**
 * Offline harness for requirements 7 (conversation selector) and 8
 * (strong-pause Stop).
 *
 * Run: node test/sessions-stop.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'vocab-sessions-test-'))
process.env.DSH_HOME = join(root, 'home')

const { apply } = await import('../index.js')

const sessionRows = [
  {
    sessionId: 'session-main',
    updatedAt: 30,
    blank: false,
    projections: { values: { title: 'Main conversation' } },
  },
  {
    sessionId: 'session-review',
    updatedAt: 20,
    blank: false,
    projections: { values: { title: 'Review desk' } },
  },
  {
    sessionId: 'session-archived',
    updatedAt: 10,
    blank: false,
    projections: { values: { title: 'Archived old chat' } },
  },
  {
    sessionId: 'session-child',
    updatedAt: 40,
    blank: false,
    origin: 'subagent',
    parentSessionId: 'session-main',
    projections: { values: { title: 'Child agent' } },
  },
]

function makeEnv(dataDir, sessionId = 'session-review') {
  const sections = []
  const contexts = []
  const routes = []
  const prompts = []
  const actions = []
  const timers = []
  const agent = {
    id: sessionId,
    session: { id: sessionId },
    status: 'idle',
    cancel(cause, options) {
      actions.push(['cancel', cause, options])
      this.status = 'idle'
    },
  }
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
  agent.ctx = scoped
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on() {
      return () => {}
    },
    get(name) {
      return ctx[name]
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
      async prompt(request, signal) {
        assert.ok(signal instanceof AbortSignal)
        prompts.push(request)
        return { accepted: true }
      },
      async list() {
        return { items: sessionRows }
      },
    },
    agents: { list: () => [agent], get: (id) => (id === agent.id ? agent : undefined) },
    workspaceRegistry: { archivedSessionIds: ['session-archived'] },
    jobs: {
      list: () => [{ id: 'job-1', status: 'running' }],
      kill: (id, caller, reason) => actions.push(['jobs.kill', id, caller, reason]),
    },
    terminals: {
      list: () => [{ id: 'term-1' }],
      kill: async (owner, id, reason) => actions.push(['terminals.kill', id, reason]),
    },
    subagents: {
      listDescendants: async () => [{ id: 'session-child', kind: 'child' }],
      interrupt: (childId, authority) => actions.push(['subagents.interrupt', childId, authority && authority.kind]),
    },
    timer: {
      interval(callback) {
        timers.push(callback)
        return () => {}
      },
      timeout() {
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir })
  return { ctx, agent, routes, prompts, actions, sections, contexts, timers }
}

function callRoute(env, method, path, body) {
  const route = env.routes.find((candidate) => candidate.path === '/api/dsh-vocab-review')
  assert.ok(route, 'API route registered')
  return new Promise((resolve, reject) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url: path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    }
    const res = {
      writeHead(status) {
        this.status = status
      },
      end(raw) {
        try {
          resolve({ status: this.status, body: JSON.parse(raw) })
        } catch (error) {
          reject(error)
        }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

async function state(env) {
  const response = await callRoute(env, 'GET', '/api/dsh-vocab-review/state')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  return response.body.value
}

async function post(env, action, body) {
  const response = await callRoute(env, 'POST', `/api/dsh-vocab-review/${action}`, body)
  assert.equal(response.status, 200)
  return response.body
}

const dataDir = join(root, 'data')
const env = makeEnv(dataDir)

// 1. Dropdown list: titles only, archived and subagent rows excluded.
let snapshot = await state(env)
assert.deepEqual(
  snapshot.sessions.map((session) => session.title),
  ['Main conversation', 'Review desk'],
)
assert.equal(snapshot.sessions.some((session) => session.sessionId === 'session-archived'), false)
assert.equal(snapshot.sessions.some((session) => session.sessionId === 'session-child'), false)
assert.equal(snapshot.selectedSessionId, 'session-main')
console.log('PASS sessions: titles listed, archived + subagent conversations excluded')

// 2. Selecting a conversation persists to settings.json and survives reload.
const selected = await post(env, 'select', { sessionId: 'session-review' })
assert.equal(selected.ok, true)
assert.equal(selected.value.selectedSessionId, 'session-review')
const settingsFile = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
assert.equal(settingsFile.selectedSessionId, 'session-review')
const reloaded = makeEnv(dataDir)
const reloadedState = await state(reloaded)
assert.equal(reloadedState.selectedSessionId, 'session-review')
console.log('PASS selection: sessionId persisted in settings.json and restored after reload')

// 3. Starting a review routes the prompt to the selected session, not main.
const imported = await post(reloaded, 'import', { words: 'alpha, beta, gamma' })
assert.equal(imported.ok, true)
assert.equal(imported.value.deferred, true)
const started = await post(reloaded, 'start')
assert.equal(started.ok, true)
assert.equal(reloaded.prompts.length, 1)
assert.equal(reloaded.prompts[0].sessionId, 'session-review')
assert.equal(reloaded.prompts[0].content[0].text, '开始词汇复习')
assert.equal(started.value.selectedSessionId, 'session-review')
console.log('PASS routing: Start sends the Q/A prompt to the selected session, not the main conversation')

// 4. Strong-pause Stop: enabled state, silent cancellation, full cleanup.
reloaded.agent.status = 'running'
let runningState = await state(reloaded)
assert.equal(runningState.turnInFlight, true)
const promptsBeforeStop = reloaded.prompts.length
const stopResponse = await post(reloaded, 'interrupt')
assert.equal(stopResponse.ok, true)
assert.equal(stopResponse.value.turnInFlight, false)
assert.equal(reloaded.prompts.length, promptsBeforeStop, 'interrupt is silent: no transcript prompt')
const cancel = reloaded.actions.find((action) => action[0] === 'cancel')
assert.ok(cancel, 'agent.cancel was called')
assert.deepEqual(cancel[1], { kind: 'user' })
assert.deepEqual(cancel[2], { keepInbox: true })
assert.ok(reloaded.actions.some((action) => action[0] === 'jobs.kill'), 'background job killed')
assert.ok(reloaded.actions.some((action) => action[0] === 'terminals.kill'), 'terminal killed')
const childInterrupt = reloaded.actions.find((action) => action[0] === 'subagents.interrupt')
assert.ok(childInterrupt, 'child agent interrupted')
assert.equal(childInterrupt[2], 'ancestor')
assert.equal(stopResponse.value.interrupt.agentCancelled, true)
assert.equal(stopResponse.value.interrupt.jobs, 1)
assert.equal(stopResponse.value.interrupt.terminals, 1)
assert.equal(stopResponse.value.interrupt.subagents, 1)
console.log('PASS interrupt: cancel + jobs/terminals/subagents, silent, turnInFlight back to false')

// 5. Stop while idle does nothing and the button state stays disabled.
reloaded.agent.status = 'idle'
const cancelCount = reloaded.actions.filter((action) => action[0] === 'cancel').length
const idleState = await state(reloaded)
assert.equal(idleState.turnInFlight, false)
const idleStop = await post(reloaded, 'interrupt')
assert.equal(idleStop.ok, true)
assert.equal(idleStop.value.interrupt.agentCancelled, false)
// The endpoint may still reap leftover background work, but it must never
// cancel an idle agent or inject a transcript message.
assert.equal(reloaded.actions.filter((action) => action[0] === 'cancel').length, cancelCount, 'no cancel when idle')
assert.equal(reloaded.prompts.length, promptsBeforeStop, 'no prompt when idle')
console.log('PASS idle stop: no-op, turnInFlight false (button disabled)')

// 6. A selected conversation that became archived falls back to a live one.
const fallbackDir = join(root, 'fallback')
makeEnv(fallbackDir)
const fallbackFile = join(fallbackDir, 'settings.json')
const fallbackSettings = JSON.parse(readFileSync(fallbackFile, 'utf8'))
fallbackSettings.selectedSessionId = 'session-archived'
writeFileSync(fallbackFile, JSON.stringify(fallbackSettings))
const fallbackEnv = makeEnv(fallbackDir)
const fallbackState = await state(fallbackEnv)
assert.equal(fallbackState.selectedSessionId, 'session-main')
assert.equal(fallbackState.sessions.some((session) => session.sessionId === 'session-archived'), false)
console.log('PASS archived selection: fallback to the first live conversation')

rmSync(root, { recursive: true, force: true })
console.log('\nALL CHECKS PASSED')
