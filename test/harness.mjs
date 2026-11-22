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

function userText(text, session = { id: 'session-test' }) {
  return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } }
}

function fireUser(env, text, session = { id: 'session-test' }) {
  fire(env, userText(text), session)
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

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
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers || {}
      },
      end(raw) {
        this.raw = raw
        let body = null
        try {
          body = JSON.parse(raw)
        } catch {
          body = raw
        }
        resolve({ status: this.status, body, headers: this.headers })
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

// ── 12. Continuous review: autoContinue keeps asking past one batch ──────
const contDir = join(root, 'continue')
const contEnv = freshEnv(contDir, { queueSize: 2, wrongInject: 0 })
await contEnv.tools.get('vocab_import').execute({ words: 'alpha, beta, gamma, delta, epsilon' }, { agent: contEnv.agent })
assert.deepEqual(loadLedger(contDir).queue, ['alpha', 'beta'], 'one batch is queueSize words')
for (let index = 0; index < 5; index++) {
  const word = loadLedger(contDir).pendingWord
  assert.ok(word, `question ${index + 1} is pending`)
  fire(contEnv, answerText(`✅ ${word} = m`))
  await new Promise((resolve) => setTimeout(resolve, 20))
}
const contLedger = loadLedger(contDir)
for (const word of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
  assert.equal(contLedger.words[word].correct, 1, `${word} was asked even beyond the first batch`)
}
assert.equal(contLedger.dailyCounters.total, 5, 'five questions were asked in one continuous session')
assert.equal(contEnv.prompts.length, 4, 'one continuation per answer except the last')
assert.equal(contLedger.loop, 'idle', 'the loop only stops once nothing is due')
assert.equal(contLedger.idleReason.kind, 'no-due')
assert.ok(contLedger.idleReason.nextDueAt > Date.now(), 'the idle reason carries the next due time')
const contState = await state(contEnv)
assert.equal(contState.loop, 'idle')
assert.equal(contState.dueNow, 0)
assert.ok(contState.idleReason && contState.idleReason.kind === 'no-due')
console.log('PASS continuous review: autoContinue refills past queueSize=2, asks all 5 due words, stops with a no-due reason')

// ── 13. QQ channel: the automatic stop explains itself ──────────────────
const qqIdleDir = join(root, 'qq-idle')
const qqIdleEnv = freshEnv(qqIdleDir, { qqStatePath }, {
  sessionId: 'session-web',
  sessions: [
    { sessionId: 'session-web', updatedAt: Date.now(), projections: { values: { title: 'Web chat' } } },
    { sessionId: qqBindingSession, updatedAt: Date.now(), projections: { values: { title: 'QQ chat' } } },
  ],
  qqSend: true,
})
await qqIdleEnv.tools.get('vocab_import').execute({ words: 'solo' }, { agent: qqIdleEnv.agent })
await post(qqIdleEnv, 'select', { sessionId: qqBindingSession })
const qqIdleStarted = await post(qqIdleEnv, 'start')
assert.equal(qqIdleStarted.ok, true)
await new Promise((resolve) => setTimeout(resolve, 120))
assert.equal(qqIdleEnv.qqPushes.length, 1, 'Start pushed the only question')
fire(qqIdleEnv, answerText(`✅ ${loadLedger(qqIdleDir).pendingWord} = m`), { id: qqBindingSession })
await new Promise((resolve) => setTimeout(resolve, 150))
const qqIdleLedger = loadLedger(qqIdleDir)
assert.equal(qqIdleLedger.loop, 'idle')
assert.equal(qqIdleLedger.idleReason.kind, 'no-due')
assert.equal(qqIdleEnv.qqPushes.length, 2, 'QQ gets one message explaining why review stopped')
assert.match(qqIdleEnv.qqPushes[1], /复习完/u)
console.log('PASS QQ idle: an automatic stop pushes one explanation to QQ instead of going silent')

// ── 14. Plugin veto: ✅ with a different meaning is scheduled as wrong ────
const vetoDir = join(root, 'veto')
const vetoEnv = freshEnv(vetoDir)
await vetoEnv.tools.get('vocab_import').execute({ words: 'abandon' }, { agent: vetoEnv.agent })
fireUser(vetoEnv, '放弃')
fire(vetoEnv, answerText('✅ abandon = 放弃'))
await settle()
let vetoLedger = loadLedger(vetoDir)
assert.equal(vetoLedger.words.abandon.correct, 1)
assert.equal(vetoLedger.words.abandon.meaning, '放弃')
// Make the word due again without waiting for the real interval.
vetoLedger.words.abandon.dueAt = Date.now() - 1_000
vetoLedger.words.abandon.lastResultAt = Date.now() - 5_000
writeFileSync(join(vetoDir, 'ledger.json'), JSON.stringify(vetoLedger))
const vetoEnv2 = freshEnv(vetoDir)
assert.equal((await post(vetoEnv2, 'start')).ok, true)
fireUser(vetoEnv2, '得到')
fire(vetoEnv2, answerText('✅ abandon = 放弃'))
await settle()
const vetoAfter = loadLedger(vetoDir)
assert.equal(vetoAfter.words.abandon.errors, 1, 'a conflicting answer is wrong even when the model said ✅')
assert.equal(vetoAfter.words.abandon.correct, 1, 'the earlier correct answer is untouched')
assert.equal(vetoAfter.words.abandon.stage, 0, 'a veto resets the ladder like a real mistake')
assert.ok(vetoAfter.lastConflict && vetoAfter.lastConflict.word === 'abandon')
assert.match(vetoAfter.lastConflict.answer, /得到/u)
assert.match(vetoAfter.lastConflict.expected, /放弃/u)
console.log('PASS veto: model ✅ with a different meaning is recorded as wrong and reported as lastConflict')

// ── 15. Fuzzy tier: hedging downgrades ✅, half interval, stage kept ──────
const fuzzyDir = join(root, 'fuzzy')
const fuzzyEnv = freshEnv(fuzzyDir)
await fuzzyEnv.tools.get('vocab_import').execute({ words: 'cautious' }, { agent: fuzzyEnv.agent })
fireUser(fuzzyEnv, '好像 谨慎的')
fire(fuzzyEnv, answerText('✅ cautious = 谨慎的'))
await settle()
const fuzzyLedger = loadLedger(fuzzyDir)
assert.equal(fuzzyLedger.words.cautious.fuzzy, 1)
assert.equal(fuzzyLedger.words.cautious.correct, 0)
assert.equal(fuzzyLedger.words.cautious.errors, 0)
assert.equal(fuzzyLedger.words.cautious.stage, 0, 'fuzzy does not advance the ladder')
const fuzzyDueIn = fuzzyLedger.words.cautious.dueAt - Date.now()
assert.ok(fuzzyDueIn > 14 * 60_000 && fuzzyDueIn < 16 * 60_000, `fuzzy returns at half of 30m, got ${Math.round(fuzzyDueIn / 60_000)}m`)
console.log('PASS fuzzy: a hedged answer is neither correct nor wrong; half interval, stage kept')

// ── 16. Explicit 🤔 line, then a real ✅ advances the ladder ─────────────
const halfDir = join(root, 'half')
const halfEnv = freshEnv(halfDir)
await halfEnv.tools.get('vocab_import').execute({ words: 'benefit' }, { agent: halfEnv.agent })
fire(halfEnv, answerText('🤔 benefit = 好处'))
await settle()
let halfLedger = loadLedger(halfDir)
assert.equal(halfLedger.words.benefit.fuzzy, 1)
assert.equal(halfLedger.words.benefit.meaning, '好处')
assert.equal(halfLedger.words.benefit.stage, 0)
halfLedger.words.benefit.dueAt = Date.now() - 1_000
halfLedger.words.benefit.lastResultAt = Date.now() - 5_000
writeFileSync(join(halfDir, 'ledger.json'), JSON.stringify(halfLedger))
const halfEnv2 = freshEnv(halfDir)
assert.equal((await post(halfEnv2, 'start')).ok, true)
fireUser(halfEnv2, '好处')
fire(halfEnv2, answerText('✅ benefit = 好处'))
await settle()
halfLedger = loadLedger(halfDir)
assert.equal(halfLedger.words.benefit.correct, 1)
assert.equal(halfLedger.words.benefit.stage, 1, 'a matching ✅ advances the ladder after a fuzzy')
assert.ok(halfLedger.words.benefit.dueAt > Date.now() + 60 * 60_000)
assert.equal(halfLedger.lastConflict, null, 'a matching answer never creates a veto')
console.log('PASS half-step: 🤔 is recorded as fuzzy, the following matching ✅ advances the ladder')

// ── 17. Weak-word book: state, master / forget / remove, CSV export ──────
const bookDir = join(root, 'book')
const bookEnv = freshEnv(bookDir)
await bookEnv.tools.get('vocab_import').execute({ words: 'abandon, benefit, cautious' }, { agent: bookEnv.agent })
fireUser(bookEnv, '不知道')
fire(bookEnv, answerText('❌ abandon = 放弃'))
await settle()
fireUser(bookEnv, '好像 好处')
fire(bookEnv, answerText('✅ benefit = 好处'))
await settle()
fireUser(bookEnv, '谨慎的')
fire(bookEnv, answerText('✅ cautious = 谨慎的'))
await settle()
const bookState = await state(bookEnv)
assert.equal(bookState.total, 3)
assert.equal(bookState.wrongCount, 1)
assert.equal(bookState.fuzzyCount, 1)
assert.equal(bookState.verifyAnswers, true)
assert.equal(bookState.weakWords.length, 2, 'only failed/half-known words are in the book')
const abandonedRow = bookState.weakWords.find((row) => row.word === 'abandon')
const benefitRow = bookState.weakWords.find((row) => row.word === 'benefit')
assert.equal(abandonedRow.errors, 1)
assert.equal(benefitRow.fuzzy, 1)
assert.equal(bookState.weakWords.some((row) => row.word === 'cautious'), false)
// master: leaves the book, scheduled at the top of the ladder
const mastered = await post(bookEnv, 'words/master', { word: 'abandon' })
assert.equal(mastered.ok, true)
assert.equal(mastered.value.weakWords.some((row) => row.word === 'abandon'), false)
const masteredLedger = loadLedger(bookDir)
assert.equal(masteredLedger.words.abandon.errors, 0)
assert.ok(masteredLedger.words.abandon.dueAt > Date.now() + 7 * 24 * 60 * 60_000, 'mastered word is scheduled far out')
// forget: due right now again
const forgotten = await post(bookEnv, 'words/forget', { word: 'benefit' })
assert.equal(forgotten.ok, true)
assert.ok(loadLedger(bookDir).words.benefit.dueAt <= Date.now() + 1_000)
// remove: gone from the ledger
const removed = await post(bookEnv, 'words/remove', { word: 'cautious' })
assert.equal(removed.ok, true)
assert.equal((await state(bookEnv)).total, 2)
assert.equal((await state(bookEnv)).weakWords.some((row) => row.word === 'cautious'), false)
// CSV export (BOM + header + rows, all words)
const csvResponse = await callRoute(bookEnv, 'GET', '/api/dsh-vocab-review/export.csv?scope=all')
assert.equal(csvResponse.status, 200)
assert.equal(csvResponse.headers['content-type'], 'text/csv; charset=utf-8')
assert.ok(String(csvResponse.body).startsWith('\uFEFFword,meaning,errors,fuzzy,stage,ease,correct,due_at,last_result_at'))
assert.ok(String(csvResponse.body).includes('benefit'))
assert.ok(String(csvResponse.body).includes('好处'))
assert.ok(!String(csvResponse.body).includes('cautious'))
const weakCsv = await callRoute(bookEnv, 'GET', '/api/dsh-vocab-review/export.csv?scope=weak')
assert.ok(String(weakCsv.body).includes('benefit'))
console.log('PASS weak-word book: state lists failed/half words, master/forget/remove work, CSV exports with BOM')

// ── 18. A newer ledger schema is set aside instead of misread ────────────
const futureDir = join(root, 'future')
mkdirSync(futureDir, { recursive: true })
writeFileSync(
  join(futureDir, 'ledger.json'),
  JSON.stringify({ version: 9, plugin: 'dsh-vocab-review', words: { ghost: { word: 'ghost' } } }),
)
const futureEnv = freshEnv(futureDir)
const futureState = await state(futureEnv)
assert.equal(futureState.total, 0, 'words from an unknown schema are not loaded')
assert.ok(existsSync(join(futureDir, 'ledger.json.v9.bak')), 'the newer ledger is kept as a .bak file')
console.log('PASS schema guard: a future ledger version is moved to .bak and a clean state is used')

// ── 19. "不知道" is wrong even when the model grades it ✅ ────────────────
const dontDir = join(root, 'dont-know')
const dontEnv = freshEnv(dontDir)
await dontEnv.tools.get('vocab_import').execute({ words: 'doubt' }, { agent: dontEnv.agent })
fireUser(dontEnv, '不知道')
fire(dontEnv, answerText('✅ doubt = 怀疑'))
await settle()
const dontLedger = loadLedger(dontDir)
assert.equal(dontLedger.words.doubt.errors, 1)
assert.equal(dontLedger.words.doubt.correct, 0)
assert.equal(dontLedger.words.doubt.stage, 0)
console.log('PASS don\'t-know: an explicit 不知道 is always wrong, whatever the model says')

// ── 20. A short partial Chinese answer is not vetoed ────────────────────
const partDir = join(root, 'partial')
const partEnv = freshEnv(partDir)
await partEnv.tools.get('vocab_import').execute({ words: 'genuine' }, { agent: partEnv.agent })
fireUser(partEnv, '真正的')
fire(partEnv, answerText('✅ genuine = 真正的；真诚的'))
await settle()
const partLedger = loadLedger(partDir)
partLedger.words.genuine.dueAt = Date.now() - 1_000
partLedger.words.genuine.lastResultAt = Date.now() - 5_000
writeFileSync(join(partDir, 'ledger.json'), JSON.stringify(partLedger))
const partEnv2 = freshEnv(partDir)
assert.equal((await post(partEnv2, 'start')).ok, true)
fireUser(partEnv2, '真的')
fire(partEnv2, answerText('✅ genuine = 真正的；真诚的'))
await settle()
const partAfter = loadLedger(partDir)
assert.equal(partAfter.words.genuine.correct, 1, 'the first answer was correct')
assert.equal(partAfter.words.genuine.errors, 0, 'a partial rewording is never vetoed')
assert.equal(partAfter.words.genuine.fuzzy, 1, 'a partial rewording is graded half-known')
assert.ok(partAfter.words.genuine.meanings.includes('真的'), 'the user wording joins the accepted-gloss pool')
assert.equal(partAfter.lastConflict, null)
console.log('PASS partial: a short Chinese rewording is half-known (not wrong) and joins the gloss pool')

// ── 22. Article image: basic words filtered, batch capped, loop not started ─
const artDir = join(root, 'article')
const artEnv = freshEnv(artDir, { articleMaxWords: 5 })
const art = await artEnv.tools.get('vocab_import_article').execute(
  { words: 'abandon, the, benefit, is, cautious, genuine:high, grocery, promote, school, theory, quixotic:out' },
  { agent: artEnv.agent },
)
assert.equal(art.ok, true)
assert.deepEqual(art.added, ['abandon', 'benefit', 'cautious', 'genuine', 'grocery'], 'the cap keeps the model order')
assert.deepEqual(art.skippedBasic, ['the', 'is', 'school'], 'basic everyday words are filtered out')
assert.deepEqual(art.notExam, ['quixotic'], 'words the model marked :out are refused')
assert.deepEqual(art.overLimit, ['promote', 'theory'], 'the per-article cap is respected')
assert.ok(art.message.includes('Scope: high-frequency words for the CET-4 exam'))
assert.ok(art.message.includes('Added 5'))
assert.ok(art.message.includes('Filtered out 3'))
assert.ok(art.message.includes('out of scope'))
assert.ok(art.message.includes('开始背单词'))
assert.equal(artEnv.prompts.length, 0, 'an article import never starts the review loop')
const artLedger = loadLedger(artDir)
assert.equal(artLedger.loop, 'stopped')
assert.deepEqual(artLedger.queue, ['abandon', 'benefit', 'cautious', 'genuine', 'grocery'])
assert.equal(artLedger.words.abandon.source, 'article')
assert.equal(artLedger.words.genuine.source, 'article')
assert.equal(artLedger.words.genuine.freq, 'high', 'a :high hint is kept')
assert.equal(artLedger.words.abandon.freq, 'normal', 'unmarked words get the normal frequency')
assert.equal(artLedger.words.the, undefined, 'the basic word never enters the ledger')
const artStarted = await post(artEnv, 'start')
assert.equal(artStarted.ok, true, 'Start after an article import begins the review')
assert.equal(artEnv.prompts.length, 1)
const artProtocol = artEnv.sections[0].text()
assert.ok(artProtocol.includes('vocab_import_article'), 'the protocol tells the model about the article path')
assert.ok(artProtocol.includes('HIGH-FREQUENCY IN REAL EXAMS'), 'the protocol asks for exam high-frequency words')
assert.ok(artProtocol.includes('🤔'), 'the protocol still documents the three grades')
console.log('PASS article image: basic words dropped, batch capped, loop waits for Start, protocol updated')

// ── 23. Article image: only basic words / only known words ──────────────
const artBasicDir = join(root, 'article-basic')
const artBasicEnv = freshEnv(artBasicDir)
const artBasic = await artBasicEnv.tools.get('vocab_import_article').execute(
  { words: 'the, is, school' },
  { agent: artBasicEnv.agent },
)
assert.equal(artBasic.ok, true)
assert.deepEqual(artBasic.added, [])
assert.equal(artBasic.skippedBasic.length, 3)
assert.ok(artBasic.message.includes('basic words or outside the exam scope'))
assert.equal(loadLedger(artBasicDir).queue.length, 0)
const artKnown = await artBasicEnv.tools.get('vocab_import_article').execute(
  { words: 'theory, the' },
  { agent: artBasicEnv.agent },
)
assert.deepEqual(artKnown.added, ['theory'])
const artAgain = await artBasicEnv.tools.get('vocab_import_article').execute(
  { words: 'theory, cautious' },
  { agent: artBasicEnv.agent },
)
assert.deepEqual(artAgain.added, ['cautious'])
assert.deepEqual(artAgain.existing, ['theory'])
assert.ok(artAgain.message.includes('Already known'))
console.log('PASS article edge cases: all-basic imports explain themselves, known words are reported not re-added')

// ── 24. Exam scope: per-call exam level, :out refused, config default ────
const examDir = join(root, 'exam')
const examEnv = freshEnv(examDir, { articleMaxWords: 10 })
const exam = await examEnv.tools.get('vocab_import_article').execute(
  { words: 'ubiquitous, precarious, quixotic:out, the', exam: 'kaoyan' },
  { agent: examEnv.agent },
)
assert.equal(exam.ok, true)
assert.deepEqual(exam.added, ['ubiquitous', 'precarious'])
assert.deepEqual(exam.notExam, ['quixotic'])
assert.deepEqual(exam.skippedBasic, ['the'])
assert.equal(exam.examLevel, 'kaoyan')
assert.ok(exam.message.includes('考研'), 'the scope line names the requested exam')
const examLedger = loadLedger(examDir)
assert.equal(examLedger.words.ubiquitous.source, 'article')
assert.equal(examLedger.words.quixotic, undefined)
const examDefault = freshEnv(join(root, 'exam-default'), { examLevel: 'gaokao' })
const examGk = await examDefault.tools.get('vocab_import_article').execute(
  { words: 'genuine' },
  { agent: examDefault.agent },
)
assert.equal(examGk.examLevel, 'gaokao', 'the plugin examLevel is the fallback')
assert.ok(examGk.message.includes('高考'))
console.log('PASS exam scope: per-call exam level, :out words refused, configured examLevel as the default')

// ── 25. Ease factor: answers bend the interval (SM-2 style) ──────────────
const easeDir = join(root, 'ease')
const easeEnv = freshEnv(easeDir)
await easeEnv.tools.get('vocab_import').execute({ words: 'abandon' }, { agent: easeEnv.agent })
fireUser(easeEnv, '不知道')
fire(easeEnv, answerText('❌ abandon = 放弃'))
await settle()
let easeLedger = loadLedger(easeDir)
assert.equal(easeLedger.words.abandon.ease, 0.85, 'a wrong answer lowers ease by 0.15')
easeLedger.words.abandon.dueAt = Date.now() - 1_000
easeLedger.words.abandon.lastResultAt = Date.now() - 5_000
writeFileSync(join(easeDir, 'ledger.json'), JSON.stringify(easeLedger))
const easeEnv2 = freshEnv(easeDir)
assert.equal((await post(easeEnv2, 'start')).ok, true)
fireUser(easeEnv2, '放弃')
fire(easeEnv2, answerText('✅ abandon = 放弃'))
await settle()
easeLedger = loadLedger(easeDir)
assert.equal(easeLedger.words.abandon.ease, 0.9, 'a correct answer raises ease by 0.05')
const easeDueIn = easeLedger.words.abandon.dueAt - Date.now()
assert.ok(easeDueIn > 155 * 60_000 && easeDueIn < 170 * 60_000, `3h tallered by ease 0.9, got ${Math.round(easeDueIn / 60_000)}m`)
console.log('PASS ease: wrong answers shrink intervals, correct answers stretch them, clamped 0.7-1.5')

// ── 26. Export formats: CSV, JSON, Anki TSV ──────────────────────────────
const exportDir = join(root, 'export')
const exportEnv = freshEnv(exportDir)
await exportEnv.tools.get('vocab_import').execute({ words: 'abandon, cautious' }, { agent: exportEnv.agent })
fireUser(exportEnv, '不知道')
fire(exportEnv, answerText('❌ abandon = 放弃'))
await settle()
const jsonExport = await callRoute(exportEnv, 'GET', '/api/dsh-vocab-review/export.json?scope=all')
assert.equal(jsonExport.status, 200)
assert.match(String(jsonExport.headers['content-type']), /application\/json/u)
const jsonRows = Array.isArray(jsonExport.body) ? jsonExport.body : JSON.parse(String(jsonExport.body))
assert.equal(jsonRows.length, 2)
const abandonJson = jsonRows.find((row) => row.word === 'abandon')
assert.equal(abandonJson.errors, 1)
assert.equal(typeof abandonJson.ease, 'number')
assert.match(abandonJson.dueAt, /^\d{4}-\d{2}-\d{2}T/u, 'dueAt is ISO in JSON export')
const ankiExport = await callRoute(exportEnv, 'GET', '/api/dsh-vocab-review/export.anki?scope=weak')
assert.equal(ankiExport.status, 200)
assert.match(String(ankiExport.headers['content-type']), /tab-separated-values/u)
assert.match(String(ankiExport.body), /^abandon\t放弃\tdsh-vocab$/mu)
console.log('PASS export: CSV + JSON (ISO dates) + Anki TSV with the dsh-vocab tag')

// ── 27. Daily history: the previous day is kept for the trend line ───────
const historyDir = join(root, 'history')
const historySeed = freshEnv(historyDir)
await historySeed.tools.get('vocab_import').execute({ words: 'later' }, { agent: historySeed.agent })
const historyLedger = loadLedger(historyDir)
historyLedger.dailyCounters = { date: '2000-01-01', new: 2, review: 3, total: 5, minutes: 9, errors: 2, fuzzy: 1 }
writeFileSync(join(historyDir, 'ledger.json'), JSON.stringify(historyLedger))
const historyEnv = freshEnv(historyDir)
const historyState = await state(historyEnv)
assert.equal(historyState.counters.total, 0, 'counters restart on a new day')
assert.equal(historyState.history.length, 1)
assert.deepEqual(historyState.history[0], { date: '2000-01-01', asked: 5, errors: 2, fuzzy: 1 })
console.log('PASS history: a completed day is appended to the 30-day history before counters reset')

// ── 28. Diagnostics + last import are exposed to the panel ───────────────
const diagState = await state(exportEnv)
assert.equal(typeof diagState.diag.lastSaveMs, 'number')
assert.ok(diagState.diag.ledgerBytes > 0, 'ledger size is measured')
assert.equal(diagState.diag.verifyAnswers, true)
assert.equal(diagState.diag.examLevel, 'cet4')
assert.equal(diagState.lastImport.mode, 'list')
assert.equal(diagState.lastImport.parsed, 2)
assert.equal(diagState.lastImport.added, 2)
const diagArticle = await state(artEnv)
assert.equal(diagArticle.lastImport.mode, 'article')
assert.equal(diagArticle.lastImport.skippedBasic, 3)
console.log('PASS diagnostics: save latency/size, verify config and last import are in the state payload')

// ── 29. Performance: a 1500-word ledger loads and saves quickly ──────────
const perfDir = join(root, 'perf')
mkdirSync(perfDir, { recursive: true })
const perfWords = {}
const perfNow = Date.now()
for (let index = 0; index < 1500; index++) {
  const word = `word${String(index).padStart(4, '0')}`
  perfWords[word] = {
    word, display: word, meaning: '测试', meanings: [], freq: 'normal', stage: index % 6, ease: 1,
    dueAt: perfNow + index * 1000, createdAt: perfNow, lastAskedAt: null,
    lastResultAt: null, lastErrorAt: null, lastFuzzyAt: null, correct: 0, errors: 0, fuzzy: 0,
  }
}
writeFileSync(
  join(perfDir, 'ledger.json'),
  JSON.stringify({ version: 2, plugin: 'dsh-vocab-review', updatedAt: perfNow, loop: 'stopped', words: perfWords }),
)
const perfStart = performance.now()
const perfEnv = freshEnv(perfDir)
const perfLoadMs = performance.now() - perfStart
const perfState = await state(perfEnv)
assert.equal(perfState.total, 1500)
assert.ok(perfLoadMs < 2_000, `1500-word ledger loads in ${Math.round(perfLoadMs)}ms (< 2000ms)`)
assert.ok((await post(perfEnv, 'words/forget', { word: 'word0001' })).ok)
const perfSaveMs = (await state(perfEnv)).diag.lastSaveMs
assert.ok(perfSaveMs < 300, `1500-word save takes ${perfSaveMs}ms (< 300ms)`)
assert.ok((await state(perfEnv)).diag.ledgerBytes > 100_000)
console.log(`PASS performance: 1500 words load=${Math.round(perfLoadMs)}ms save=${perfSaveMs}ms`)

// ── 30. Underlined worksheet also imports exam high-frequency extras ─────
const extrasDir = join(root, 'worksheet-extras')
const extrasEnv = freshEnv(extrasDir, { articleMaxWords: 2 })
const extrasImport = await extrasEnv.tools.get('vocab_import').execute(
  { words: 'alpha, beta', extra: 'abandon, the, alpha, quixotic:out, genuine:high, cautious, promote' },
  { agent: extrasEnv.agent },
)
assert.equal(extrasImport.ok, true)
assert.deepEqual(extrasImport.extras, ['abandon', 'genuine'], 'basic, duplicate, :out and over-cap extras are filtered')
assert.ok(extrasImport.message.includes('Also added 2 exam high-frequency word(s)'))
assert.deepEqual(extrasImport.queue.slice(0, 4), ['alpha', 'beta', 'abandon', 'genuine'], 'underlined words come first')
const extrasLedger = loadLedger(extrasDir)
assert.equal(extrasLedger.words.abandon.source, 'exam', 'extras are marked as exam words')
assert.equal(extrasLedger.words.genuine.freq, 'high', 'a :high hint on an extra is kept')
assert.equal(extrasLedger.words.the, undefined, 'basic words are never added as extras')
assert.equal(extrasLedger.words.quixotic, undefined, ':out extras are refused')
assert.equal(extrasLedger.words.cautious, undefined, 'extras respect the articleMaxWords cap')
const extrasState = await state(extrasEnv)
assert.equal(extrasState.lastImport.extra, 2)
console.log('PASS extras: a worksheet import also takes exam high-frequency words (filtered + capped)')

// ── 31. includeHighFreq:false keeps the old underlined-only behaviour ────
const extrasOffDir = join(root, 'worksheet-extras-off')
const extrasOffEnv = freshEnv(extrasOffDir, { includeHighFreq: false })
const extrasOff = await extrasOffEnv.tools.get('vocab_import').execute(
  { words: 'alpha', extra: 'abandon, benefit' },
  { agent: extrasOffEnv.agent },
)
assert.equal(extrasOff.ok, true)
assert.deepEqual(extrasOff.extras, [])
assert.equal(extrasOff.message.includes('Also added'), false)
const extrasOffLedger = loadLedger(extrasOffDir)
assert.equal(extrasOffLedger.words.abandon, undefined)
assert.equal(extrasOffLedger.words.benefit, undefined)
console.log('PASS extras config: includeHighFreq=false imports only the underlined words')

rmSync(root, { recursive: true, force: true })
console.log('\nALL CHECKS PASSED')
