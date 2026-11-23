/**
 * Dependency-free QQ Bot (QQ 开放平台) client for dsh-vocab-review.
 *
 * Scope: just enough of the official protocol for this plugin — get an
 * app access token, open the WebSocket gateway, receive C2C / group @ messages,
 * download an inbound image, and send plain text back (passive reply when the
 * inbound msg_id is still usable, active push otherwise).
 *
 * No SDK, no npm dependencies: global `fetch` and the Node 22+ global
 * `WebSocket` are used. The client never exposes the AppSecret and logs only
 * redacted facts.
 */
const DEFAULT_API_BASE = 'https://api.sgroup.qq.com'
const DEFAULT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
// GROUP_AND_C2C intent (1 << 25): C2C_MESSAGE_CREATE + GROUP_AT_MESSAGE_CREATE.
const DEFAULT_INTENTS = 1 << 25
const MAX_CHUNKS = 4
const MAX_CHUNK_CHARS = 900
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 30_000
// Reconnect pacing. QQ's open-platform endpoints are rate limited (HTTP 400,
// code 100017 / err_code 40023001 "接口调用超过频率限制"), and a tight retry loop
// makes it worse: the first failure after a long gap already waits 5s, doubles
// to 5min, and a rate-limit answer parks the client for at least a minute.
const RECONNECT_BASE_MS = 5_000
const RECONNECT_MAX_MS = 300_000
const RATE_LIMIT_BASE_MS = 60_000
const RATE_LIMIT_MAX_MS = 900_000
// The gateway URL is stable for minutes; a socket drop must not refetch it
// (each refetch is another rate-limited API call). Reconnects inside this
// window reuse it, only a rejected session drops the cache.
const GATEWAY_TTL_MS = 5 * 60_000
// Shared by every client instance in this process: a restart (panel save,
// plugin reload) inside a rate-limit cooldown must not fire another request.
let sharedCooldownUntil = 0
// Close codes that mean "this gateway URL / session is no longer good".
const INVALID_SESSION_CODES = new Set([4004, 4006, 4007, 4008, 4909, 4914, 4915])

function parseJson(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** Detail of a rate-limit answer, or null when this response is something else. */
function rateLimitOf(response, text) {
  const body = parseJson(text) || {}
  const code = Number(body.code) || 0
  const errCode = Number(body.err_code !== undefined ? body.err_code : body.errCode) || 0
  const message = String(body.message || '')
  const limited =
    response.status === 429 ||
    code === 100017 ||
    errCode === 40023001 ||
    /频率限制|rate.?limit|too many requests/i.test(message)
  if (!limited) return null
  let retryAfterMs = 0
  try {
    const header = response.headers && typeof response.headers.get === 'function' ? response.headers.get('retry-after') : null
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = seconds * 1000
  } catch {
    retryAfterMs = 0
  }
  return { retryAfterMs, code, errCode, message }
}

/** An HTTP failure with the fields the reconnect logic needs. */
function httpError(prefix, response, text) {
  const limited = rateLimitOf(response, text)
  const body = parseJson(text) || {}
  const detail = limited
    ? `接口调用超过频率限制${limited.message ? `：${limited.message}` : ''}`
    : `${response.status} ${text.slice(0, 160)}`.trim()
  const error = new Error(`${prefix}：HTTP ${detail}`)
  error.status = response.status
  error.code = limited ? limited.code : Number(body.code) || 0
  error.errCode = limited ? limited.errCode : Number(body.err_code) || 0
  error.rateLimited = Boolean(limited)
  error.retryAfterMs = limited ? limited.retryAfterMs : 0
  error.auth = !limited && (response.status === 401 || response.status === 403)
  return error
}

// QQ 快捷指令面板 (the list the QQ client shows when the user types "/").
// Platform limits: at most 5 items, and a CJK character counts as two of the
// documented name/description characters.
const PANEL_REMARK = 'dsh-vocab-review'
const PANEL_ITEMS = Object.freeze([
  { type: 'command', name: 'start', desc: '开始背单词复习' },
  { type: 'command', name: 'stats', desc: '查看到期与错词' },
  { type: 'command', name: 'stop', desc: '停止复习，队列保留' },
  { type: 'command', name: 'reset', desc: '重置复习进度（保留词义）' },
  { type: 'command', name: 'help', desc: '查看可用命令' },
])

function splitText(text, size, maxChunks) {
  const parts = []
  let rest = String(text)
  while (rest.length > size && parts.length < maxChunks - 1) {
    const cut = rest.lastIndexOf('\n', size)
    const at = cut > 0 ? cut + 1 : size
    parts.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest) parts.push(rest.slice(0, size))
  return parts.filter((part) => part.trim())
}

export class QqClient {
  constructor(options = {}) {
    this.appId = String(options.appId || '').trim()
    this.appSecret = String(options.appSecret || '').trim()
    this.apiBase = String(options.apiBase || DEFAULT_API_BASE).replace(/\/+$/u, '')
    this.tokenUrl = String(options.tokenUrl || DEFAULT_TOKEN_URL)
    this.intents = Number.isFinite(options.intents) ? options.intents : DEFAULT_INTENTS
    this.logger = options.logger || null
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket
    this.userAgent = String(options.userAgent || 'dsh-vocab-review')
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : null
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : null

    this.token = ''
    this.tokenExpiresAt = 0
    this.ws = null
    this.lastSeq = null
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.handshakeTimer = null
    this.attempt = 0
    this.rateLimitedCount = 0
    this.closed = false
    this.helloDone = false
    this.gatewayCache = null
    this.gatewayCachedAt = 0
    this.cooldownUntil = 0
    this.nextRetryAt = null
    this.state = 'idle'
    this.error = ''
    this.connectedAt = null
    this.lastMessageAt = null
    this.panel = { published: false, at: null, error: '' }
    // msg_seq bookkeeping: QQ dedupes (msg_id, msg_seq), so every passive reply
    // for one inbound message needs the next sequence number. A Map survives the
    // callers that copy the target object around.
    this.msgSeqByMessage = new Map()
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      appId: this.appId,
      connectedAt: this.connectedAt,
      lastMessageAt: this.lastMessageAt,
      apiBase: this.apiBase,
      attempt: this.attempt,
      nextRetryAt: this.nextRetryAt,
      rateLimitedUntil: this.cooldownUntil > Date.now() ? this.cooldownUntil : null,
      panel: { ...this.panel },
    }
  }

  setStatus(state, error) {
    this.state = state
    this.error = error || ''
    if (state === 'connected') this.connectedAt = Date.now()
    try {
      this.onStatus?.(this.status())
    } catch {
      /* status listeners must not break the connection */
    }
  }

  async start() {
    if (this.state === 'connected' || this.state === 'connecting') return this.status()
    if (!this.appId || !this.appSecret) {
      this.setStatus('failed', '缺少 AppID / AppSecret')
      return this.status()
    }
    if (typeof this.WebSocketImpl !== 'function') {
      this.setStatus('failed', '当前运行时没有 WebSocket（需要 Node 22+）')
      return this.status()
    }
    this.closed = false
    this.attempt = 0
    const wait = this.cooldownRemaining()
    if (wait > 0) {
      this.parkRateLimited(wait)
      return this.status()
    }
    await this.open()
    return this.status()
  }

  /** Milliseconds left before a rate-limit cooldown allows the next request. */
  cooldownRemaining() {
    return Math.max(0, sharedCooldownUntil - Date.now())
  }

  /** Wait out a rate limit without touching the network. */
  parkRateLimited(waitMs) {
    const seconds = Math.max(1, Math.round(waitMs / 1000))
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + waitMs)
    this.setStatus('reconnecting', `QQ 接口调用超过频率限制，已暂停请求，${seconds} 秒后自动重试。`)
    this.scheduleRetry(waitMs)
  }

  async open() {
    if (this.closed) return
    const wait = this.cooldownRemaining()
    if (wait > 0) {
      this.parkRateLimited(wait)
      return
    }
    this.setStatus('connecting')
    try {
      // Cached token + cached gateway on purpose: each of those HTTP calls is
      // rate-limited, so a reconnect must not repeat them.
      const token = await this.accessToken()
      const gateway = await this.gatewayUrl(token)
      this.connectSocket(gateway, token)
    } catch (error) {
      this.fail(error)
    }
  }

  fail(error) {
    const raw = String((error && error.message) || error)
    this.logger?.warn?.(`dsh-vocab-review: [qq] ${raw}`)
    if (error && error.rateLimited) {
      const wait = Math.min(
        RATE_LIMIT_MAX_MS,
        Math.max(RATE_LIMIT_BASE_MS, error.retryAfterMs || 0, RATE_LIMIT_BASE_MS * 2 ** Math.min(this.rateLimitedCount, 4)),
      )
      this.rateLimitedCount += 1
      sharedCooldownUntil = Date.now() + wait
      this.parkRateLimited(wait)
      return
    }
    if (error && error.auth) {
      // Bad credentials cannot be fixed by retrying: stop and say so.
      this.setStatus('failed', raw)
      return
    }
    this.setStatus('reconnecting', raw)
    this.scheduleReconnect()
  }

  /** A retry whose delay is already decided. */
  scheduleRetry(delay) {
    if (this.closed) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.nextRetryAt = Date.now() + delay
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.nextRetryAt = null
      void this.open()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  scheduleReconnect() {
    if (this.closed) return
    const wait = this.cooldownRemaining()
    if (wait > 0) {
      this.parkRateLimited(wait)
      return
    }
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.attempt, 6))
    this.attempt += 1
    this.setStatus('reconnecting', this.error)
    this.scheduleRetry(backoff + Math.floor(Math.random() * 500))
  }

  connectSocket(url, token) {
    this.closeSocket()
    this.helloDone = false
    this.token = token
    const ws = new this.WebSocketImpl(url)
    this.ws = ws
    ws.addEventListener('message', (event) => this.onPayload(event && event.data))
    ws.addEventListener('close', (event) => this.onSocketClose(event))
    ws.addEventListener('error', () => {
      /* close follows and owns reconnection */
    })
    this.handshakeTimer = setTimeout(() => {
      if (this.helloDone || this.ws !== ws) return
      try {
        ws.close(4000, 'handshake timeout')
      } catch {
        /* ignore */
      }
    }, HANDSHAKE_TIMEOUT_MS)
    this.handshakeTimer.unref?.()
  }

  closeSocket() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.heartbeatTimer = null
    this.handshakeTimer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.close(1000, 'client closing')
      } catch {
        /* ignore */
      }
    }
  }

  async close() {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.closeSocket()
    this.setStatus('closed')
  }

  onSocketClose(event) {
    if (this.ws === null && this.closed) return
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.ws = null
    this.helloDone = false
    if (this.closed) {
      this.setStatus('closed')
      return
    }
    const code = event && typeof event.code === 'number' ? event.code : 0
    this.logger?.info?.(`dsh-vocab-review: [qq] gateway closed (${code})`)
    if (INVALID_SESSION_CODES.has(code)) this.gatewayCache = null
    this.scheduleReconnect()
  }

  onPayload(raw) {
    let payload = null
    try {
      payload = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (!payload || typeof payload !== 'object') return
    if (Number.isFinite(payload.s) && payload.s > 0) this.lastSeq = payload.s
    switch (payload.op) {
      case 10: {
        // HELLO: identify (or resume) and start the heartbeat.
        this.helloDone = true
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
        const interval = Number(payload.d && payload.d.heartbeat_interval)
        const every = Number.isFinite(interval) ? Math.max(40, interval) : 41_250
        this.identify()
        this.heartbeatTimer = setInterval(() => this.heartbeat(), every)
        this.heartbeatTimer.unref?.()
        this.attempt = 0
        this.rateLimitedCount = 0
        this.cooldownUntil = 0
        sharedCooldownUntil = 0
        this.setStatus('connected')
        break
      }
      case 0: {
        this.dispatch(payload.t, payload.d)
        break
      }
      case 7: {
        // Server asks for a reconnect.
        this.closeSocket()
        this.scheduleReconnect()
        break
      }
      case 9: {
        // Invalid session: drop the resume cursor and reconnect.
        this.lastSeq = null
        this.closeSocket()
        this.scheduleReconnect()
        break
      }
      default:
        break
    }
  }

  identify() {
    const ws = this.ws
    if (!ws) return
    ws.send(
      JSON.stringify({
        op: 2,
        d: { token: `QQBot ${this.token}`, intents: this.intents, shard: [0, 1] },
      }),
    )
  }

  heartbeat() {
    const ws = this.ws
    if (!ws) return
    try {
      ws.send(JSON.stringify({ op: 1, d: this.lastSeq }))
    } catch {
      /* the socket is closing; close handler reconnects */
    }
  }

  dispatch(type, data) {
    if (type === 'READY') {
      // Publish the slash-command panel once the gateway is up. Missing panel
      // permission is not fatal: commands still work when typed.
      void this.publishPanel().catch((error) => {
        this.logger?.warn?.(
          `dsh-vocab-review: [qq] command panel skipped: ${String(error && error.message ? error.message : error)}`,
        )
      })
      return
    }
    if (!data || typeof data !== 'object') return
    if (type === 'C2C_MESSAGE_CREATE') {
      this.onMessage?.(normalizeMessage('c2c', data))
      return
    }
    if (type === 'GROUP_AT_MESSAGE_CREATE') {
      this.onMessage?.(normalizeMessage('group', data))
    }
  }

  /**
   * Keep one QQ command panel for this bot (the "/" shortcut list): create it
   * on the first connection, update it in place afterwards so a restart does
   * not add duplicates.
   */
  async publishPanel() {
    try {
      const listed = await this.api('GET', '/v2/panels?scope=c2c&limit=50')
      const records = listed && Array.isArray(listed.records) ? listed.records : []
      const existing = records.find(
        (record) =>
          record &&
          record.scope === 'c2c' &&
          record.target_type === 'all' &&
          record.panel &&
          record.panel.remark === PANEL_REMARK,
      )
      const panel = { items: PANEL_ITEMS.map((item) => ({ ...item })), remark: PANEL_REMARK }
      if (existing && existing.panel_id) {
        await this.api('PUT', `/v2/panels/${encodeURIComponent(existing.panel_id)}`, { panel })
      } else {
        await this.api('POST', '/v2/panels', { scope: 'c2c', target_type: 'all', panel })
      }
      this.panel = { published: true, at: Date.now(), error: '' }
      this.logger?.info?.('dsh-vocab-review: [qq] command panel published')
    } catch (error) {
      this.panel = {
        published: false,
        at: Date.now(),
        error: String(error && error.message ? error.message : error),
      }
      throw error
    }
  }

  async accessToken(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token
    const response = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': this.userAgent },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    })
    const text = await response.text()
    if (!response.ok) throw httpError('获取 QQ access_token 失败', response, text)
    let value = null
    try {
      value = JSON.parse(text)
    } catch {
      value = null
    }
    if (!value || !value.access_token) throw new Error('获取 QQ access_token 失败：响应缺少 access_token')
    this.token = String(value.access_token)
    this.tokenExpiresAt = Date.now() + (Number(value.expires_in) || 7200) * 1000
    return this.token
  }

  async gatewayUrl(token, retried = false) {
    // Reconnects reuse the URL: every /gateway call counts against the
    // platform's rate limit, which is exactly what a drop-and-retry loop hits.
    if (!retried && this.gatewayCache && Date.now() - this.gatewayCachedAt < GATEWAY_TTL_MS) {
      return this.gatewayCache
    }
    const response = await this.fetchImpl(`${this.apiBase}/gateway`, {
      headers: { authorization: `QQBot ${token}`, 'user-agent': this.userAgent },
    })
    const text = await response.text()
    if (!response.ok) {
      const error = httpError('获取 QQ 网关地址失败', response, text)
      if (error.auth && !retried) {
        // The cached token was rejected early: refresh it once and retry.
        this.token = ''
        this.tokenExpiresAt = 0
        this.gatewayCache = null
        const fresh = await this.accessToken(true)
        return this.gatewayUrl(fresh, true)
      }
      throw error
    }
    const value = parseJson(text)
    if (!value || typeof value.url !== 'string' || !value.url) throw new Error('获取 QQ 网关地址失败：响应缺少 url')
    this.gatewayCache = value.url
    this.gatewayCachedAt = Date.now()
    return value.url
  }

  async api(method, path, body, retried = false) {
    const token = await this.accessToken()
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `QQBot ${token}`,
        'content-type': 'application/json',
        'user-agent': this.userAgent,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (response.status === 401 && !retried) {
      this.token = ''
      return this.api(method, path, body, true)
    }
    if (!response.ok) throw httpError(`QQ API ${path} 失败`, response, text)
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      return {}
    }
  }

  /**
   * Send text to one chat. `target` = { scope, id, msgId?, msgSeq? }.
   * A passive reply (msg_id) is preferred; every reply for the same msg_id gets
   * the next msg_seq (QQ dedupes repeats with 40054005), and after the
   * platform's 4-reply budget the client falls back to an active push.
   */
  async sendText(target, text) {
    const body = String(text == null ? '' : text).trim()
    if (!body) return { ok: true, parts: 0 }
    const scope = target && target.scope === 'group' ? 'group' : 'c2c'
    const id = target && typeof target.id === 'string' ? target.id : ''
    if (!id) throw new Error('缺少 QQ 会话 id')
    const route = `/v2/${scope === 'group' ? 'groups' : 'users'}/${encodeURIComponent(id)}/messages`
    const chunks = splitText(body, MAX_CHUNK_CHARS, MAX_CHUNKS)
    for (const chunk of chunks) {
      const msgId = target && target.msgId ? String(target.msgId) : ''
      let seq = 1
      let passive = false
      if (msgId) {
        const known = Math.max(
          Number(this.msgSeqByMessage.get(msgId)) || 0,
          Number(target.msgSeq) || 0,
        )
        seq = known + 1
        passive = seq <= 4
        if (passive) this.msgSeqByMessage.set(msgId, seq)
      }
      const payload = { content: chunk, msg_type: 0, msg_seq: passive ? seq : 1 }
      if (passive) payload.msg_id = msgId
      await this.api('POST', route, payload)
      if (target) target.msgSeq = passive ? seq : 0
    }
    if (this.msgSeqByMessage.size > 200) {
      const oldest = this.msgSeqByMessage.keys().next().value
      if (oldest !== undefined) this.msgSeqByMessage.delete(oldest)
    }
    return { ok: true, parts: chunks.length }
  }

  /** Download an inbound image into { mediaType, data(base64), name, bytes }. */
  async downloadImage(url) {
    const headers = { 'user-agent': this.userAgent }
    let token = ''
    try {
      token = await this.accessToken()
    } catch {
      token = ''
    }
    if (token) headers.authorization = `QQBot ${token}`
    const response = await this.fetchImpl(url, { headers })
    if (!response.ok) throw new Error(`下载 QQ 图片失败：HTTP ${response.status}`)
    const mediaType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0) throw new Error('下载 QQ 图片失败：内容为空')
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('QQ 图片超过 10MB，请压缩后再发')
    return { mediaType, data: bytes.toString('base64'), bytes: bytes.length }
  }
}

function normalizeMessage(scope, event) {
  const author = event.author && typeof event.author === 'object' ? event.author : {}
  const targetId =
    scope === 'c2c'
      ? typeof author.user_openid === 'string' ? author.user_openid : ''
      : typeof event.group_openid === 'string' ? event.group_openid : ''
  const senderId =
    scope === 'c2c'
      ? typeof author.user_openid === 'string' ? author.user_openid : ''
      : typeof author.member_openid === 'string' ? author.member_openid : ''
  const attachments = Array.isArray(event.attachments)
    ? event.attachments
        .filter((item) => item && typeof item === 'object' && typeof item.url === 'string')
        .map((item) => ({
          url: item.url,
          contentType: typeof item.content_type === 'string' ? item.content_type : '',
          filename: typeof item.filename === 'string' ? item.filename : '',
          size: Number(item.size) || 0,
        }))
    : []
  return {
    scope,
    targetId,
    senderId,
    messageId: typeof event.id === 'string' ? event.id : '',
    content: typeof event.content === 'string' ? event.content : '',
    timestamp: event.timestamp || null,
    attachments,
  }
}

export { splitText, normalizeMessage }
