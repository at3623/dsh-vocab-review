/**
 * Offline harness for the built-in QQ bot (no SDK, no real QQ credentials).
 *
 * A fake WebSocket stands in for the QQ gateway and a fake fetch answers the
 * token, gateway and message-send endpoints plus an inbound image URL. Covers:
 * configure & connect, identify + heartbeat, inbound text → model prompt →
 * relay, inbound image → image content block, commands (start), grading round
 * trip with the next question pushed, deduplication, and disconnect status.
 *
 * Run: node test/qq-builtin.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'vocab-qq-builtin-'))
process.env.DSH_HOME = join(root, 'home')
const dataDir = join(root, 'data')

// ── Fake QQ gateway ───────────────────────────────────────────────────────
class FakeWs {
  static instances = []
  constructor(url) {
    this.url = url
    this.sent = []
    this.listeners = { message: [], close: [], error: [] }
    this.readyState = 1
    FakeWs.instances.push(this)
  }
  addEventListener(type, handler) {
    ;(this.listeners[type] || (this.listeners[type] = [])).push(handler)
  }
  emit(type, event) {
    for (const handler of this.listeners[type] || []) handler(event)
  }
  send(data) {
    this.sent.push(JSON.parse(data))
  }
  close(code = 1000) {
    this.readyState = 3
    this.emit('close', { code })
  }
  // test helpers
  hello(interval = 60) {
    this.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: interval } }) })
  }
  dispatch(type, data, seq = 1) {
    this.emit('message', { data: JSON.stringify({ op: 0, t: type, s: seq, d: data }) })
  }
}

// ── Fake HTTP ─────────────────────────────────────────────────────────────
const sentMessages = []
const panels = []
const httpCalls = { token: 0, gateway: 0 }
// When set, /gateway answers the QQ rate-limit error (400 / code 100017 /
// err_code 40023001) so the retry policy can be tested offline.
let gatewayRateLimitUntil = 0
function response({ status = 200, body = null, mediaType = 'application/json', bytes = null }) {
  const text = bytes ? '' : JSON.stringify(body ?? {})
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? mediaType : null) },
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => (bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0)),
  }
}
async function fakeFetch(url, init = {}) {
  const target = String(url)
  const pathname = target.split('?')[0]
  const method = String(init.method || 'GET').toUpperCase()
  if (target.includes('/app/getAppAccessToken')) {
    httpCalls.token += 1
    return response({ body: { access_token: 'TOKEN-1', expires_in: 7200 } })
  }
  if (pathname.endsWith('/gateway')) {
    httpCalls.gateway += 1
    if (Date.now() < gatewayRateLimitUntil) {
      return response({ status: 400, body: { message: '接口调用超过频率限制', code: 100017, err_code: 40023001 } })
    }
    return response({ body: { url: 'wss://gateway.test/websocket' } })
  }
  if (pathname.endsWith('/v2/panels') && method === 'GET') return response({ body: { records: panels } })
  if (pathname.endsWith('/v2/panels') && method === 'POST') {
    const body = JSON.parse(init.body)
    panels.push({ panel_id: `panel-${panels.length + 1}`, scope: body.scope, target_type: body.target_type, panel: body.panel })
    return response({ body: {} })
  }
  if (/\/v2\/panels\/[^/]+$/u.test(pathname) && method === 'PUT') {
    const body = JSON.parse(init.body)
    const panel = panels.find((record) => pathname.endsWith(encodeURIComponent(record.panel_id)))
    if (panel) panel.panel = body.panel
    return response({ body: {} })
  }
  if (/\/v2\/(?:users|groups)\/[^/]+\/messages$/u.test(pathname)) {
    const body = init.body ? JSON.parse(init.body) : {}
    sentMessages.push({ url: target, body })
    return response({ body: { id: `sent-${sentMessages.length}` } })
  }
  if (target.includes('media.test')) {
    return response({ mediaType: 'image/jpeg', bytes: Buffer.from('fake-jpeg-bytes') })
  }
  return response({ status: 404, body: { message: 'not found' } })
}
globalThis.fetch = fakeFetch
globalThis.WebSocket = FakeWs

const { apply } = await import('../index.js')

// ── Minimal Host context ──────────────────────────────────────────────────
const warnings = []
function makeCtx(sessionId) {
  const handlers = new Map()
  const tools = new Map()
  const routes = []
  const prompts = []
  const replies = ['好的', '收到', '导入完成']
  const emit = (session, event) => {
    for (const handler of handlers.get('session/event') || []) handler(session, event)
  }
  const agent = { id: sessionId, session: { id: sessionId }, status: 'idle' }
  const ctx = {
    logger: {
      info() {},
      warn(...args) {
        warnings.push(args.map(String).join(' '))
      },
      error() {},
    },
    get: (name) => ctx[name],
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on(name, handler) {
      const list = handlers.get(name) || []
      list.push(handler)
      handlers.set(name, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
      get: () => undefined,
    },
    webServer: { register: (route) => (routes.push(route), () => {}) },
    sessionController: {
      async prompt(request, signal) {
        assert.ok(signal instanceof AbortSignal, 'prompt gets an AbortSignal')
        prompts.push(request)
        const session = { id: request.sessionId }
        setTimeout(() => {
          emit(session, { type: 'user/message', data: { role: 'user', content: request.content } })
          const text = replies.shift() || '好的'
          emit(session, {
            type: 'assistant/message',
            data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
          })
          emit(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
        }, 5)
        return { accepted: true }
      },
      async list() {
        return { items: [{ sessionId, updatedAt: Date.now(), projections: { values: { title: 'Web chat' } } }] }
      },
    },
    agents: { list: () => [agent], get: (id) => (id === sessionId ? agent : undefined) },
    workspaceRegistry: { archivedSessionIds: [] },
    timer: { interval: () => () => {}, timeout: () => () => {} },
    qqStatePath: join(root, 'no-bot-state.json'),
  }
  return { ctx, tools, routes, prompts, handlers, emit }
}

function callRoute(routes, method, path, body) {
  const route = routes.find((candidate) => candidate.path === '/api/dsh-vocab-review')
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
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers || {}
      },
      end(raw) {
        let parsed = raw
        try {
          parsed = JSON.parse(raw)
        } catch {
          /* keep text */
        }
        resolve({ status: this.status, body: parsed, headers: this.headers })
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function stateOf(routes) {
  const response = await callRoute(routes, 'GET', '/api/dsh-vocab-review/state')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  return response.body.value
}
async function post(routes, action, body) {
  const response = await callRoute(routes, 'POST', `/api/dsh-vocab-review/${action}`, body)
  assert.equal(response.status, 200)
  return response.body
}

// ── 1. Configure the built-in bot: token → gateway → identify ─────────────
const env = makeCtx('session-test')
apply(env.ctx, { dataDir, queueSize: 2, wrongInject: 0 })
let state = await stateOf(env.routes)
assert.equal(state.qq.transport, 'none')
assert.equal(state.qq.builtin.configured, false)

const saved = await post(env.routes, 'qq/builtin/save', {
  appId: '123456789',
  appSecret: 'super-secret',
  apiBase: 'https://api.test',
  enabled: true,
})
assert.equal(saved.ok, true)
await wait(20)
assert.equal(FakeWs.instances.length, 1, 'gateway socket opened')
const ws = FakeWs.instances[0]
assert.equal(ws.url, 'wss://gateway.test/websocket')
state = await stateOf(env.routes)
assert.equal(state.qq.transport, 'builtin')
assert.equal(state.qq.builtin.state, 'connecting')
ws.hello(60)
await wait(10)
const identify = ws.sent.find((payload) => payload.op === 2)
assert.ok(identify, 'identify sent on HELLO')
assert.equal(identify.d.token, 'QQBot TOKEN-1')
assert.equal(identify.d.intents, 1 << 25, 'C2C + group @ intent')
state = await stateOf(env.routes)
assert.equal(state.qq.builtin.state, 'connected')
assert.equal(state.qq.builtin.secretSet, true)
assert.match(state.qq.builtin.appId, /…/u, 'appId is masked in the panel payload')
assert.equal(JSON.stringify(state).includes('super-secret'), false, 'the AppSecret never reaches the client')
// The slash-command panel is created on READY and updated in place afterwards.
ws.dispatch('READY', { session_id: 'gateway-session' })
await wait(30)
assert.equal(panels.length, 1, 'command panel created')
assert.equal(panels[0].panel.remark, 'dsh-vocab-review')
assert.deepEqual(
  panels[0].panel.items.map((item) => item.name),
  ['start', 'stats', 'stop', 'reset', 'help'],
  'the panel exposes /start /stats /stop /reset /help',
)
ws.dispatch('READY', { session_id: 'gateway-session' })
await wait(30)
assert.equal(panels.length, 1, 'an existing panel is updated, not duplicated')
state = await stateOf(env.routes)
assert.equal(state.qq.builtin.panel.published, true, 'the panel publish result is visible to the panel state')
console.log('PASS builtin QQ: settings saved, token/gateway/identify handshake, masked credentials, command panel')

// ── 2. Heartbeat ─────────────────────────────────────────────────────────
await wait(140)
assert.ok(ws.sent.some((payload) => payload.op === 1), 'heartbeat frames are sent')
console.log('PASS builtin QQ: heartbeat frames follow the HELLO interval')

// ── 3. Inbound text → model prompt → relay to QQ ─────────────────────────
const imported = await env.tools.get('vocab_import').execute({ words: 'abandon, benefit' }, { agent: { session: { id: 'session-test' } } })
assert.equal(imported.ok, true)
ws.dispatch('C2C_MESSAGE_CREATE', {
  id: 'msg-1',
  content: '你好',
  timestamp: '2026-01-01T00:00:00Z',
  author: { user_openid: 'OPENID_1' },
})
await wait(40)
assert.equal(env.prompts.length, 1, 'the QQ message became one session prompt')
const textPart = env.prompts[0].content.find((part) => part.type === 'text')
assert.equal(textPart.text, '[QQ] 你好', 'the answer keeps the QQ marker')
assert.equal(env.prompts[0].url, undefined)
assert.equal(sentMessages.length, 1, 'the model reply was relayed to QQ')
assert.equal(sentMessages[0].body.content, '好的')
assert.equal(sentMessages[0].body.msg_id, 'msg-1', 'reply is passive (uses the inbound msg_id)')
assert.ok(sentMessages[0].url.endsWith('/v2/users/OPENID_1/messages'), 'C2C message route used')
state = await stateOf(env.routes)
assert.equal(state.qq.builtin.target.scope, 'c2c', 'the chat target is remembered for pushes')
console.log('PASS builtin QQ: inbound text → session prompt → reply relayed as a passive message')

// ── 4. Inbound image → image content block ───────────────────────────────
ws.dispatch(
  'C2C_MESSAGE_CREATE',
  {
    id: 'msg-2',
    content: '',
    author: { user_openid: 'OPENID_1' },
    attachments: [{ content_type: 'image/jpeg', url: 'https://media.test/img.jpg', filename: 'sheet.jpg', size: 2048 }],
  },
  ws.sent.length + 2,
)
await wait(40)
assert.equal(env.prompts.length, 2, 'an image message reaches the model too')
const imagePart = env.prompts[1].content.find((part) => part.type === 'image')
assert.ok(imagePart, 'the image is a prompt content part')
assert.equal(imagePart.mediaType, 'image/jpeg')
assert.equal(Buffer.from(imagePart.data, 'base64').toString(), 'fake-jpeg-bytes')
assert.ok(env.prompts[1].content.some((part) => part.type === 'text' && part.text.includes('vocab_import_article')))
console.log('PASS builtin QQ: inbound image becomes an image block with import instructions')

// ── 4b. A QQ image import only stores words; review waits for a QQ command ─
const qqImport = await env.tools.get('vocab_import').execute(
  { words: 'gesture, glance' },
  { agent: { session: { id: 'session-test' } } },
)
assert.equal(qqImport.ok, true)
assert.equal(qqImport.qqPending, true, 'a QQ image import reports qqPending')
assert.ok(qqImport.message.includes('开始背单词'), 'the tool tells the model to wait for the QQ command')
assert.equal(qqImport.message.includes('Q: gesture'), false, 'no Q line is requested')
let afterImport = await stateOf(env.routes)
assert.equal(afterImport.loop, 'stopped', 'QQ image imports never auto-start the review loop')
assert.equal(afterImport.queue.includes('gesture'), true, 'the imported words wait in the queue')
assert.equal(
  sentMessages.filter((message) => /^Q: /u.test(message.body.content)).length,
  0,
  'nothing is pushed to QQ before the command',
)
console.log('PASS builtin QQ: a QQ image import stores words only, review waits for the QQ command')

// ── 5. Command: start review pushes the first question ───────────────────
await post(env.routes, 'stop', {})
const before = sentMessages.length
ws.dispatch('C2C_MESSAGE_CREATE', { id: 'msg-3', content: '开始背单词', author: { user_openid: 'OPENID_1' } })
await wait(40)
assert.equal(sentMessages.length, before + 1, 'start answered with the first question')
assert.match(sentMessages[sentMessages.length - 1].body.content, /^Q: (?:abandon|benefit|gesture|glance)$/u)
assert.equal(env.prompts.length, 2, 'commands are handled without a model turn')
state = await stateOf(env.routes)
assert.equal(state.loop, 'running')
console.log('PASS builtin QQ: 开始背单词 starts the loop and pushes Q: directly')

// ── 6. Grading round trip + next question pushed ──────────────────────────
const pendingWord = state.pendingWord
const beforeAnswer = sentMessages.length
ws.dispatch('C2C_MESSAGE_CREATE', { id: 'msg-4', content: '放弃', author: { user_openid: 'OPENID_1' } })
await wait(60)
assert.equal(env.prompts.length, 3, 'the answer was sent to the model for grading')
// Simulate the model's grade line through the same session event the plugin watches.
env.emit({ id: 'session-test' }, {
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text: `✅ ${pendingWord} = 放弃` }] } },
})
await wait(30)
const ledger = JSON.parse(await (await import('node:fs/promises')).readFile(join(dataDir, 'ledger.json'), 'utf8'))
assert.ok(ledger.words[pendingWord].correct >= 1, 'the graded answer is recorded from the same event stream')
await wait(1_800)
assert.ok(sentMessages.length > beforeAnswer, 'the next question is pushed to QQ after the turn')
console.log('PASS builtin QQ: QQ answer is graded through the session and the next question is pushed')

// ── 6b. Slash commands from the panel ────────────────────────────────────
ws.dispatch('C2C_MESSAGE_CREATE', { id: 'msg-5', content: '/stop', author: { user_openid: 'OPENID_1' } })
await wait(40)
assert.ok(sentMessages[sentMessages.length - 1].body.content.includes('已停止'), '/stop stops the loop')
assert.equal((await stateOf(env.routes)).loop, 'stopped')
ws.dispatch('C2C_MESSAGE_CREATE', { id: 'msg-6', content: '/stats', author: { user_openid: 'OPENID_1' } })
await wait(40)
assert.ok(sentMessages[sentMessages.length - 1].body.content.includes('到期'), '/stats answers with the counters')
ws.dispatch('C2C_MESSAGE_CREATE', { id: 'msg-7', content: '/help', author: { user_openid: 'OPENID_1' } })
await wait(40)
assert.ok(sentMessages[sentMessages.length - 1].body.content.includes('/start'), '/help lists the commands')
ws.dispatch('C2C_MESSAGE_CREATE', { id: 'msg-reset', content: '/reset', author: { user_openid: 'OPENID_1' } })
await wait(40)
assert.ok(sentMessages[sentMessages.length - 1].body.content.includes('已重置'), '/reset clears the schedule')
const afterReset = await stateOf(env.routes)
assert.equal(afterReset.loop, 'stopped')
assert.equal(afterReset.counters.errors, 0, 'the reset clears the wrong-answer counters')
assert.ok(afterReset.weakWords.length === 0, 'the weak-word book is empty after a reset')
ws.dispatch('C2C_MESSAGE_CREATE', { id: 'msg-8', content: '/start', author: { user_openid: 'OPENID_1' } })
await wait(40)
assert.match(sentMessages[sentMessages.length - 1].body.content, /^Q: /u, '/start pushes the next question')
assert.equal((await stateOf(env.routes)).loop, 'running')
console.log('PASS builtin QQ: /stop /stats /help /reset /start from the command panel are handled')

// ── 7. Dedupe + disconnect status ────────────────────────────────────────
const promptsBefore = env.prompts.length
ws.dispatch('C2C_MESSAGE_CREATE', { id: 'msg-1', content: '你好', author: { user_openid: 'OPENID_1' } })
await wait(20)
assert.equal(env.prompts.length, promptsBefore, 'a redelivered message id is ignored')
ws.close(1006)
await wait(20)
state = await stateOf(env.routes)
assert.equal(state.qq.builtin.state, 'reconnecting', 'a dropped gateway switches the status to reconnecting')
const disabled = await post(env.routes, 'qq/builtin/disable')
assert.equal(disabled.ok, true)
await wait(20)
state = await stateOf(env.routes)
assert.notEqual(state.qq.builtin.state, 'connected')
console.log('PASS builtin QQ: duplicate message ids are ignored, disconnect and disable are reflected')

// ── 8. msg_seq: one unique sequence per inbound message id ───────────────
const { QqClient } = await import('../qq/client.js')
const seqClient = new QqClient({
  appId: 'a',
  appSecret: 'b',
  apiBase: 'https://api.test',
  fetchImpl: fakeFetch,
  WebSocketImpl: FakeWs,
})
const seqTarget = { scope: 'c2c', id: 'OPENID_SEQ', msgId: 'msg-seq', msgSeq: 0 }
await seqClient.sendText(seqTarget, 'one')
// A caller that copies the target (the plugin does) must not reset the counter.
await seqClient.sendText({ ...seqTarget, msgSeq: 0 }, 'two')
await seqClient.sendText(seqTarget, 'three')
await seqClient.sendText(seqTarget, 'four')
const seqBodies = sentMessages.filter((message) => message.url.includes('OPENID_SEQ')).map((message) => message.body)
assert.deepEqual(
  seqBodies.map((body) => body.msg_seq),
  [1, 2, 3, 4],
  'each passive reply gets the next msg_seq (QQ dedupes repeats with 40054005)',
)
assert.ok(seqBodies.every((body) => body.msg_id === 'msg-seq'))
await seqClient.sendText(seqTarget, 'five')
const fifth = sentMessages.filter((message) => message.url.includes('OPENID_SEQ')).at(-1).body
assert.equal(fifth.msg_id, undefined, 'after the 4-reply budget it falls back to an active push')
assert.equal(fifth.msg_seq, 1)
console.log('PASS builtin QQ: msg_seq increments per inbound msg_id and falls back to a push after 4 replies')

// ── 9. QQ rate limit: park with a retry time instead of hammering /gateway ─
gatewayRateLimitUntil = Date.now() + 60_000
const rlClient = new QqClient({
  appId: 'a',
  appSecret: 'b',
  apiBase: 'https://api.test',
  fetchImpl: fakeFetch,
  WebSocketImpl: FakeWs,
})
const gatewayCallsBefore = httpCalls.gateway
const tokenCallsBefore = httpCalls.token
const rlStatus = await rlClient.start()
assert.equal(rlStatus.state, 'reconnecting')
assert.match(rlStatus.error, /频率限制/u, 'the raw QQ rate-limit answer becomes a readable message')
assert.ok(rlStatus.nextRetryAt > Date.now(), 'a retry is scheduled')
assert.equal(httpCalls.gateway, gatewayCallsBefore + 1, 'exactly one /gateway call before parking')
const secondStart = await rlClient.start()
assert.equal(httpCalls.gateway, gatewayCallsBefore + 1, 'a second start inside the cooldown does not call /gateway')
assert.equal(httpCalls.token, tokenCallsBefore + 1, 'and does not fetch another access token either')
assert.equal(secondStart.state, 'reconnecting')
await rlClient.close()
gatewayRateLimitUntil = 0
console.log('PASS builtin QQ: a rate-limit answer parks the client with a retry time instead of hammering the API')

// ── 10. Token + gateway URL are cached across reconnects ─────────────────
const cacheClient = new QqClient({
  appId: 'a',
  appSecret: 'b',
  apiBase: 'https://api.test',
  fetchImpl: fakeFetch,
  WebSocketImpl: FakeWs,
})
const tokenBefore = httpCalls.token
const gatewayBefore = httpCalls.gateway
const tokenA = await cacheClient.accessToken()
const tokenB = await cacheClient.accessToken()
assert.equal(httpCalls.token, tokenBefore + 1, 'the access token is reused until it expires')
const gatewayA = await cacheClient.gatewayUrl(tokenA)
const gatewayB = await cacheClient.gatewayUrl(tokenB)
assert.equal(httpCalls.gateway, gatewayBefore + 1, 'the gateway URL is reused for reconnects')
assert.equal(gatewayA, gatewayB)
console.log('PASS builtin QQ: a reconnect reuses the cached access token and gateway URL')

// ── 11. An invalid session drops the cached gateway URL ──────────────────
cacheClient.gatewayCache = 'wss://stale.test/websocket'
cacheClient.onSocketClose({ code: 4914 })
assert.equal(cacheClient.gatewayCache, null, 'close code 4914 invalidates the cached gateway URL')
assert.equal(cacheClient.state, 'reconnecting')
await cacheClient.close()
console.log('PASS builtin QQ: an invalid session drops the gateway cache so the next attempt refetches it')

rmSync(root, { recursive: true, force: true })
console.log('\nALL QQ CHECKS PASSED')
