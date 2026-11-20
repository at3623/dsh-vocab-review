/**
 * Offline harness for dsh-vocab-review (Host half).
 *
 * Covers: import → queue, answer parsing, Stop/Resume (loop-level, queue kept,
 * no prompt while stopped), daily total/new quota stops with the 今日已达上限
 * message, date-rollover reset, runtime settings edits, and once-per-day
 * timestamp-based reminders. The real committed `assistant/message` shape is
 * used, and `sessionController.prompt` asserts it receives an AbortSignal.
 *
 * Run: node test/harness.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'vocab-review-test-'))
process.env.DSH_HOME = join(root, 'home')

const { apply } = await import('../index.js')

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function makeCtx(sessionId = 'session-test', options = {}) {
  const tools = new Map()
  const sections = []
  const contexts = []
  const handlers = new Map()
  const routes = []
  const prompts = []
  const timerCallbacks = []
  const qqPushes = []
  const actionLog = []
  const sessions = options.sessions || []
  const archived = options.archived || []
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      return ctx[name]
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on(name, handler) {
      const list = handlers.get(name) || []
      list.push(handler)
      handlers.set(name, list)
      return () => {}
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition)
        return () => {
          const index = sections.indexOf(definition)
          if (index >= 0) sections.splice(index, 1)
        }
      },
      context(definition) {
        contexts.push(definition)
        return () => {
          const index = contexts.indexOf(definition)
          if (index >= 0) contexts.splice(index, 1)
        }
      },
    },
    tools: {
      register(definition) {
        assert.equal(tools.has(definition.name), false, `duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => {}
      },
      // The QQ channel delivers through dsh-qq-bot's own tool; when the harness
      // opts in, the send is captured instead of touching a real QQ chat.
      get(name) {
        if (name !== 'send_qq_message' || !options.qqSend) return undefined
        return {
          name,
          description: '',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: () => [] },
          async execute(args) {
            qqPushes.push(String(args && args.text ? args.text : ''))
            return '已推送到 QQ'
          },
        }
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    sessionController: {
      async prompt(request, signal) {
        assert.ok(signal instanceof AbortSignal, 'sessionController.prompt receives an AbortSignal')
        prompts.push({ request })
        return { accepted: true }
      },
      async list() {
        return { items: sessions }
      },
    },
    agents: {
      list: () => [agent],
      get: (id) => (id === agent.id ? agent : undefined),
    },
    workspaceRegistry: {
      archivedSessionIds: archived,
    },
    jobs: {
      list: (caller) => {
        actionLog.push(['jobs.list', caller])
        return options.jobs || []
      },
      kill: (id, caller, reason) => {
        actionLog.push(['jobs.kill', id, caller, reason])
      },
    },
    terminals: {
      list: (owner) => {
        actionLog.push(['terminals.list', owner.id])
        return options.terminals || []
      },
      kill: async (owner, id, reason) => {
        actionLog.push(['terminals.kill', id, reason])
      },
    },
    subagents: {
      listDescendants: async (sessionId) => {
        actionLog.push(['subagents.listDescendants', sessionId])
        return options.children || []
      },
      interrupt: (childId, authority) => {
        actionLog.push(['subagents.interrupt', childId, authority && authority.kind])
      },
    },
    timer: {
      interval(callback) {
        timerCallbacks.push(callback)
        return () => {}
      },
      timeout() {
        return () => {}
      },
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
  const agent = {
    id: sessionId,
    session: { id: sessionId },
    ctx: scoped,
    status: 'idle',
    cancel(cause, cancelOptions) {
      actionLog.push(['agent.cancel', cause, cancelOptions])
      this.status = 'idle'
    },
  }
  return { ctx, agent, tools, sections, contexts, handlers, routes, prompts, timerCallbacks, actionLog, qqPushes }
}

function fire(env, event, session = { id: 'session-test' }) {
  for (const handler of env.handlers.get('session/event') || []) handler(session, event)
}

function answerText(text) {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

function callRoute(env, method, path, body) {
  const route = env.routes.find((candidate) => candidate.path === '/api/dsh-vocab-review')
  assert.ok(route, 'API route is registered')
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
      status: 0,
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

function loadLedger(dataDir) {
  return JSON.parse(readFileSync(join(dataDir, 'ledger.json'), 'utf8'))
}

function freshEnv(dataDir, config = {}, ctxOptions = {}) {
  const env = makeCtx(ctxOptions.sessionId || 'session-test', ctxOptions)
  apply(env.ctx, { dataDir, queueSize: 5, wrongInject: 2, retryDelayMinutes: 5, ...config })
  return env
}

// ── 1. Import: 3 words → queue 3, first question counted, ledger written ──
const dataDir = join(root, 'basic')
const env = freshEnv(dataDir)
const imported = await env.tools.get('vocab_import').execute(
  { words: 'Abandon, benefit, cautious.' },
  { agent: env.agent },
)
assert.equal(imported.ok, true)
assert.equal(imported.words.length, 3)
assert.deepEqual(imported.queue, ['abandon', 'benefit', 'cautious'])
assert.ok(imported.message.includes('Q: abandon'))
assert.ok(existsSync(join(dataDir, 'ledger.json')))
assert.ok(existsSync(join(dataDir, 'settings.json')))
let ledger = loadLedger(dataDir)
assert.equal(ledger.version, 2)
assert.equal(ledger.loop, 'running')
assert.equal(ledger.dailyCounters.total, 1)
assert.equal(ledger.dailyCounters.date, today())
assert.equal(ledger.pendingWord, 'abandon')
assert.deepEqual(ledger.queue, ['abandon', 'benefit', 'cautious'])
console.log('PASS import: 3 words -> 3 queue, first question counted, ledger + settings written')

// ── 2. Correct/wrong answers: ledger + counters + auto-continue ──────────
fire(env, answerText('✅ abandon = 放弃'))
await new Promise((resolve) => setTimeout(resolve, 20))
ledger = loadLedger(dataDir)
assert.equal(ledger.words.abandon.correct, 1)
assert.equal(ledger.words.abandon.meaning, '放弃')
assert.ok(ledger.words.abandon.dueAt > Date.now())
assert.deepEqual(ledger.queue, ['benefit', 'cautious'])
assert.equal(ledger.pendingWord, 'benefit')
assert.equal(ledger.dailyCounters.total, 2)
assert.equal(ledger.dailyCounters.new, 2)
assert.equal(env.prompts.length, 1)
assert.equal(env.prompts[0].request.content[0].text, '继续复习')
fire(env, answerText('❌ benefit = 好处'))
await new Promise((resolve) => setTimeout(resolve, 20))
ledger = loadLedger(dataDir)
assert.equal(ledger.words.benefit.errors, 1)
assert.ok(ledger.words.benefit.lastErrorAt > 0)
assert.equal(ledger.words.benefit.stage, 0)
assert.deepEqual(ledger.queue, ['cautious'])
assert.equal(env.prompts.length, 2)
console.log('PASS answers: ✅ schedules forward, ❌ records errors/lastErrorAt, auto-continue issued')

// ── 3. Compact injection: QUEUE + one DUE line ───────────────────────────
const queueContext = env.contexts.find((definition) => definition.name === 'vocab-review-queue')
assert.ok(queueContext)
const contextText = queueContext.text()
assert.ok(contextText.startsWith('QUEUE: cautious'))
assert.ok(contextText.includes('DUE: '))
assert.ok(contextText.split('\n').length <= 3)
console.log('PASS compact injection: QUEUE + one DUE line')

// ── 4. Stop is loop-level: keeps queue, issues no next question, no fake msg ─
const stopBefore = env.prompts.length
const stopResponse = await post(env, 'stop')
assert.equal(stopResponse.ok, true)
assert.equal(stopResponse.value.loop, 'stopped')
assert.deepEqual(stopResponse.value.queue, ['cautious'])
assert.equal(env.prompts.length, stopBefore, 'Stop must not inject a transcript message')
assert.equal(queueContext.text(), '', 'no QUEUE injected while stopped')
// The in-flight answer still records after Stop, but no next question is issued.
fire(env, answerText('✅ cautious = 谨慎的'))
await new Promise((resolve) => setTimeout(resolve, 20))
ledger = loadLedger(dataDir)
assert.equal(ledger.words.cautious.correct, 1)
assert.deepEqual(ledger.queue, [])
assert.equal(env.prompts.length, stopBefore, 'no question after the current turn stopped')
assert.equal(ledger.loop, 'stopped')
console.log('PASS stop: queue kept until answered, no next question, no fake transcript message')

// ── 5. Stop while a question is pending, then Start resumes at queue head ─
const resumeDir = join(root, 'resume')
const resumeEnv = freshEnv(resumeDir)
await resumeEnv.tools.get('vocab_import').execute({ words: 'alpha, beta, gamma, delta' }, { agent: resumeEnv.agent })
const beforeStop = loadLedger(resumeDir)
assert.equal(beforeStop.pendingWord, 'alpha')
await post(resumeEnv, 'stop')
const afterStop = loadLedger(resumeDir)
assert.equal(afterStop.loop, 'stopped')
assert.equal(afterStop.pendingWord, 'alpha')
assert.deepEqual(afterStop.queue, ['alpha', 'beta', 'gamma', 'delta'])
const resumed = await post(resumeEnv, 'start')
assert.equal(resumed.ok, true)
const afterStart = loadLedger(resumeDir)
assert.equal(afterStart.loop, 'running')
assert.equal(afterStart.pendingWord, 'alpha')
assert.equal(afterStart.dailyCounters.total, beforeStop.dailyCounters.total, 'resume must not double-count the pending question')
assert.equal(resumeEnv.prompts.length, 1)
console.log('PASS resume: Start resumes from queue head, counters intact, no double count')

// ── 6. dailyTotalLimit = 5 stops exactly after the 5th question ──────────
const quotaDir = join(root, 'quota')
const quotaEnv = freshEnv(quotaDir, { queueSize: 10 })
await post(quotaEnv, 'settings', { dailyTotalLimit: 5 })
const quotaImport = await quotaEnv.tools.get('vocab_import').execute(
  { words: 'one, two, three, four, five, six, seven' },
  { agent: quotaEnv.agent },
)
assert.equal(quotaImport.ok, true)
assert.equal(quotaImport.message.includes('QUEUE:'), true)
let expectedPrompts = 0
for (let index = 0; index < 4; index++) {
  const word = loadLedger(quotaDir).pendingWord
  assert.ok(word, `question ${index + 2} is pending`)
  fire(quotaEnv, answerText(`✅ ${word} = m`))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expectedPrompts += 1
  assert.equal(quotaEnv.prompts.length, expectedPrompts)
}
const quotaLedger = loadLedger(quotaDir)
assert.equal(quotaLedger.dailyCounters.total, 5)
assert.ok(quotaLedger.queue.length > 0)
// Answer the 5th question; the next advance must stop instead of asking #6.
fire(quotaEnv, answerText(`✅ ${quotaLedger.pendingWord} = m`))
await new Promise((resolve) => setTimeout(resolve, 20))
const stoppedLedger = loadLedger(quotaDir)
assert.equal(stoppedLedger.loop, 'stopped')
assert.equal(stoppedLedger.dailyCounters.total, 5)
assert.ok(stoppedLedger.quota && stoppedLedger.quota.message.includes('total 5/5'), 'quota message names the limit')
assert.equal(quotaEnv.prompts.length, 4, 'no sixth question was issued')
const quotaState = await state(quotaEnv)
assert.ok(quotaState.quota && quotaState.quota.message.includes('total 5/5'))
console.log('PASS quota: dailyTotalLimit=5 stops after exactly 5 questions and shows the limit message')

// ── 7. Runtime settings: new-word limit applies without restart ──────────
const settingsDir = join(root, 'settings')
const settingsEnv = freshEnv(settingsDir)
await post(settingsEnv, 'settings', { dailyNewLimit: 1, dailyTotalLimit: 0, dailyReviewLimit: 0 })
await settingsEnv.tools.get('vocab_import').execute({ words: 'solo, second, third' }, { agent: settingsEnv.agent })
fire(settingsEnv, answerText('✅ solo = 单独'))
await new Promise((resolve) => setTimeout(resolve, 20))
const newLimitLedger = loadLedger(settingsDir)
assert.equal(newLimitLedger.loop, 'stopped')
assert.ok(newLimitLedger.quota.message.includes('new 1/1'))
assert.equal(settingsEnv.prompts.length, 0)
const settingsState = await state(settingsEnv)
assert.equal(settingsState.settings.dailyNewLimit, 1)
console.log('PASS settings: sidebar-edited dailyNewLimit=1 applies immediately and stops on the next new word')

// ── 8. Reminder: timestamp based, once per day, never without due words ──
const reminderDir = join(root, 'reminder')
const reminderEnv = freshEnv(reminderDir)
assert.ok(reminderEnv.timerCallbacks.length >= 1, 'Host reminder timer is registered')
const tick = reminderEnv.timerCallbacks[0]
await reminderEnv.tools.get('vocab_import').execute({ words: 'remind, later' }, { agent: reminderEnv.agent })
await post(reminderEnv, 'settings', { reminderMaxPerDay: 1 })
const beforeReminder = await state(reminderEnv)
tick()
const afterFirst = await state(reminderEnv)
assert.equal(afterFirst.reminder.version, beforeReminder.reminder.version + 1)
assert.ok(afterFirst.reminder.at > 0)
tick()
const afterSecond = await state(reminderEnv)
assert.equal(afterSecond.reminder.version, afterFirst.reminder.version, 'at most once per day')
const settingsFile = JSON.parse(readFileSync(join(reminderDir, 'settings.json'), 'utf8'))
assert.equal(settingsFile.lastRemindedDate, today())
assert.equal(settingsFile.remindCount, 1)
// No due words -> no reminder.
const noDueDir = join(root, 'no-due')
mkdirSync(noDueDir, { recursive: true })
writeFileSync(
  join(noDueDir, 'ledger.json'),
  JSON.stringify({
    version: 2,
    plugin: 'dsh-vocab-review',
    updatedAt: Date.now(),
    loop: 'stopped',
    activeSessionId: null,
    queue: [],
    queueCreatedAt: null,
    pendingWord: null,
    pendingCounted: false,
    lastTickAt: null,
    dailyCounters: { date: today(), new: 0, review: 0, total: 0, minutes: 0 },
    quota: null,
    reminderVersion: 0,
    reminderAt: null,
    reminderDueCount: 0,
    words: {
      later: {
        word: 'later', display: 'later', meaning: '', freq: 'normal', stage: 0,
        dueAt: Date.now() + 3_600_000, createdAt: Date.now(), lastAskedAt: null,
        lastResultAt: null, lastErrorAt: null, correct: 0, errors: 0,
      },
    },
  }),
)
const noDueEnv2 = freshEnv(noDueDir)
const noDueTick = noDueEnv2.timerCallbacks[0]
const noDueBefore = await state(noDueEnv2)
noDueTick()
const noDueAfter = await state(noDueEnv2)
assert.equal(noDueAfter.reminder.version, noDueBefore.reminder.version, 'no reminder when nothing is due')
console.log('PASS reminder: fires once per day on timestamps, never when nothing is due, lastRemindedDate persisted')

// ── 9. Date rollover resets daily counters ───────────────────────────────
const rolloverDir = join(root, 'rollover')
const rolloverSeed = freshEnv(rolloverDir)
await rolloverSeed.tools.get('vocab_import').execute({ words: 'rollover' }, { agent: rolloverSeed.agent })
const rolloverLedger = loadLedger(rolloverDir)
rolloverLedger.dailyCounters = { date: '2000-01-01', new: 7, review: 3, total: 10, minutes: 42 }
writeFileSync(join(rolloverDir, 'ledger.json'), JSON.stringify(rolloverLedger))
const rolloverEnv = freshEnv(rolloverDir)
const rolloverState = await state(rolloverEnv)
assert.equal(rolloverState.counters.date, today())
assert.equal(rolloverState.counters.new, 0)
assert.equal(rolloverState.counters.review, 0)
assert.equal(rolloverState.counters.total, 0)
assert.equal(rolloverState.counters.minutes, 0)
console.log('PASS date rollover: counters reset to zero on a new day')

// ── 10. Persistence across a reload ─────────────────────────────────────
const reloadEnv = freshEnv(dataDir)
const reloadState = await state(reloadEnv)
assert.equal(reloadState.total, 3)
assert.equal(reloadState.loop, 'stopped')
assert.deepEqual(reloadState.queue, [])
const history = JSON.parse(readFileSync(join(dataDir, 'ledger.json'), 'utf8'))
assert.equal(history.words.abandon.correct, 1)
assert.equal(history.words.benefit.errors, 1)
console.log('PASS persistence: reload sees the same ledger, counters and loop state')

// ── 11. QQ channel: plugin pushes questions, grades the QQ answer ────────
const qqBindingSession = 'session-qq'
const qqStatePath = join(root, 'qq-bot-state.json')
writeFileSync(
  qqStatePath,
  JSON.stringify({
    version: 1,
    sessionId: qqBindingSession,
    ownerOpenId: 'OWNER_OPENID',
    target: { scope: 'c2c', targetId: 'OWNER_OPENID' },
    seenMessageIds: [],
  }),
)
const qqEnv = freshEnv(join(root, 'qq-ledger'), { qqStatePath }, {
  sessionId: 'session-web',
  sessions: [
    { sessionId: 'session-web', updatedAt: Date.now(), projections: { values: { title: 'Web chat' } } },
    { sessionId: qqBindingSession, updatedAt: Date.now(), projections: { values: { title: 'QQ chat' } } },
  ],
  qqSend: true,
})
await qqEnv.tools.get('vocab_import').execute({ words: 'abandon, benefit' }, { agent: qqEnv.agent })
const qqStartState = await state(qqEnv)
assert.equal(qqStartState.qq.available, true, 'QQ bot binding is detected from its state file')
assert.equal(qqStartState.qq.mode, false, 'QQ channel stays off while a web chat is selected')
await post(qqEnv, 'select', { sessionId: qqBindingSession })
const qqSelectedState = await state(qqEnv)
assert.equal(qqSelectedState.qq.mode, true, 'selecting the QQ-bound conversation enters QQ mode')
assert.equal(qqEnv.qqPushes.length, 0, 'selecting a conversation alone pushes nothing')
const qqStarted = await post(qqEnv, 'start')
assert.equal(qqStarted.ok, true)
await new Promise((resolve) => setTimeout(resolve, 120))
assert.equal(qqEnv.prompts.length, 0, 'QQ mode never prompts the web session')
assert.equal(qqEnv.qqPushes.length, 1, 'Start pushes exactly one question to QQ')
assert.match(qqEnv.qqPushes[0], /^Q: (?:abandon|benefit)$/u)
const pending = qqSelectedState.pendingWord || qqStartState.pendingWord
fire(qqEnv, answerText(`✅ ${pending} = test meaning`), { id: qqBindingSession })
fire(qqEnv, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, { id: qqBindingSession })
await new Promise((resolve) => setTimeout(resolve, 1_800))
assert.equal(qqEnv.qqPushes.length, 2, 'the next question is pushed after the graded answer turn ends')
assert.match(qqEnv.qqPushes[1], /^Q: /u)
assert.equal(loadLedger(join(root, 'qq-ledger')).words[pending].correct, 1, 'the QQ-graded answer is recorded')
console.log('PASS QQ channel: binding discovered, Start pushes Q to QQ, QQ answer graded, next Q pushed after turn/end')

rmSync(root, { recursive: true, force: true })
console.log('\nALL CHECKS PASSED')
