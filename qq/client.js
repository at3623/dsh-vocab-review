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
    this.closed = false
    this.helloDone = false
    this.state = 'idle'
    this.error = ''
    this.connectedAt = null
    this.lastMessageAt = null
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      appId: this.appId,
      connectedAt: this.connectedAt,
      lastMessageAt: this.lastMessageAt,
      apiBase: this.apiBase,
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
    await this.open()
    return this.status()
  }

  async open() {
    this.setStatus('connecting')
    try {
      const token = await this.accessToken(true)
      const gateway = await this.gatewayUrl(token)
      this.connectSocket(gateway, token)
    } catch (error) {
      this.fail(error)
    }
  }

  fail(error) {
    const message = String((error && error.message) || error)
    this.logger?.warn?.(`dsh-vocab-review: [qq] ${message}`)
    this.setStatus('failed', message)
  }

  scheduleReconnect() {
    if (this.closed) return
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.attempt, 5))
    this.attempt += 1
    this.setStatus('reconnecting')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.open()
    }, delay)
    this.reconnectTimer.unref?.()
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
    if (!data || typeof data !== 'object') return
    if (type === 'C2C_MESSAGE_CREATE') {
      this.onMessage?.(normalizeMessage('c2c', data))
      return
    }
    if (type === 'GROUP_AT_MESSAGE_CREATE') {
      this.onMessage?.(normalizeMessage('group', data))
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
    if (!response.ok) throw new Error(`获取 QQ access_token 失败：HTTP ${response.status} ${text.slice(0, 160)}`)
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

  async gatewayUrl(token) {
    const response = await this.fetchImpl(`${this.apiBase}/gateway`, {
      headers: { authorization: `QQBot ${token}`, 'user-agent': this.userAgent },
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`获取 QQ 网关地址失败：HTTP ${response.status} ${text.slice(0, 160)}`)
    let value = null
    try {
      value = JSON.parse(text)
    } catch {
      value = null
    }
    if (!value || typeof value.url !== 'string' || !value.url) throw new Error('获取 QQ 网关地址失败：响应缺少 url')
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
    if (!response.ok) throw new Error(`QQ API ${path} 失败：HTTP ${response.status} ${text.slice(0, 200)}`)
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      return {}
    }
  }

  /**
   * Send text to one chat. `target` = { scope, id, msgId?, msgSeq? }.
   * A passive reply (msg_id) is preferred; after the platform's 4-reply budget
   * for one inbound message the client falls back to an active push.
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
      if (target.msgId) {
        target.msgSeq = (Number(target.msgSeq) || 0) + 1
      }
      const passive = Boolean(target.msgId) && target.msgSeq <= 4
      const payload = { content: chunk, msg_type: 0, msg_seq: passive ? target.msgSeq : 1 }
      if (passive) payload.msg_id = target.msgId
      await this.api('POST', route, payload)
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
