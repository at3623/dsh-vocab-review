/**
 * dsh-vocab-review — Host half.
 *
 * The plugin owns the whole loop: it maintains the queue, issues each next
 * question by itself (never by counting timer ticks), records the committed
 * answer line, applies the spaced-repetition ladder, enforces the daily quota,
 * and fires at most N reminders per day. The model only asks the first word of
 * the injected QUEUE.
 *
 * Files (all under <dataDir>, default <DSH_HOME>/vocab-review):
 * - ledger.json   durable words, queue, loop state, dailyCounters
 * - settings.json editable limits + reminder bookkeeping
 *
 * Loop states: `idle` (no session to run), `running`, `stopped`.
 * Stop is loop-level: it issues no further question and never calls agent.cancel
 * or injects a fake transcript message. The queue is kept for resume.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = 'dsh-vocab-review'
const API_PREFIX = '/api/dsh-vocab-review'
const REMINDER_TICK_MS = 60_000
const REMINDER_MIN_GAP_MS = 3 * 60 * 60_000
// Bumping this makes a ledger from a newer plugin schema be set aside instead
// of being silently read with the wrong assumptions.
const SCHEMA_VERSION = 2

const DEFAULTS = {
  // Words held in the queue at once. `autoContinue` keeps the loop alive after
  // the queue drains, so this is a batch size, not a session length.
  queueSize: 5,
  autoContinue: true,
  wrongInject: 2,
  retryDelayMinutes: 5,
  // The plugin re-checks a model `✅` against the meaning it stored last time.
  // A mismatch is scheduled as wrong: the model alone must not decide that a
  // different meaning is an acceptable answer.
  verifyAnswers: true,
  ladderMinutes: [30, 180, 720, 2880, 10080, 43200], // 30m, 3h, 12h, 2d, 7d, 30d
  highMultiplier: 0.7,
  lowMultiplier: 1.6,
  maxRecentErrors: 5,
  startPrompt: '开始词汇复习',
  continuePrompt: '继续复习',
  dataDir: '',
  // Daily quota defaults; 0 means unlimited.
  dailyNewLimit: 20,
  dailyReviewLimit: 50,
  dailyTotalLimit: 0,
  dailyMinutesLimit: 0,
  reminderMaxPerDay: 1,
  // QQ channel (dsh-qq-bot): 'auto' delivers on QQ when the selected
  // conversation is the QQ-bound session; 'qq' forces it; 'session' never does.
  channel: 'auto',
  qqStatePath: '',
}

const SETTINGS_KEYS = ['dailyNewLimit', 'dailyReviewLimit', 'dailyTotalLimit', 'dailyMinutesLimit', 'reminderMaxPerDay']

/** Base forms that are unambiguously high frequency in everyday English. */
const HIGH_FREQUENCY = new Set((
  'a an the and or but if then than that this these those i you he she it we they me him her us them ' +
  'my your his its our their mine yours ours theirs be am is are was were been being have has had do does did ' +
  'done go goes went gone come comes came get gets got give gives gave take takes took make makes made know knows ' +
  'knew think thinks thought see sees saw look looks looked want wants wanted need needs needed use uses used ' +
  'find finds found tell tells told ask asks asked work works worked seem seems seemed feel feels felt try tries ' +
  'tried leave leaves left call calls called keep keeps kept let lets begin begins began help helps helped talk ' +
  'talks talked turn turns turned start starts started show shows showed hear hears heard play plays played run ' +
  'runs ran move moves moved live lives lived believe believes believed hold holds held bring brings brought ' +
  'happen happens happened write writes wrote provide provides provided sit sits sat stand stands stood lose ' +
  'loses lost pay pays paid meet meets met include includes included continue continues continued set sets learn ' +
  'learns learned change changes changed lead leads led understand understands understood watch watches watched ' +
  'follow follows followed stop stops stopped create creates created speak speaks spoke read reads eat eats ate ' +
  'drink drinks drank sleep sleeps slept walk walks walked open opens opened close closes closed add adds added ' +
  'spend spends spent grow grows grew win wins won offer offers offered remember remembers remembered love loves ' +
  'loved consider considers considered appear appears appeared buy buys bought wait waits waited serve serves ' +
  'served die dies died send sends sent expect expects expected build builds built stay stays stayed fall falls ' +
  'fell cut cuts reach reaches reached kill kills killed remain remains remained suggest suggests suggested ' +
  'raise raises raised pass passes passed sell sells sold require requires required report reports reported ' +
  'decide decides decided pull pulls pulled carry carries carried break breaks broke receive receives received ' +
  'agree agrees agreed support supports supported hit hits produce produces produced eat eats road sky tree ' +
  'book books word words study studies student students teacher school class learn learning question answer ' +
  'morning night day days week month year time people person man woman child water food house home city country ' +
  'world life hand eye eyes head face place point fact case way thing things part number group problem right ' +
  'apple banana orange bread milk coffee tea rice meat fish bird dog cat horse car bus train plane phone computer ' +
  'music film game sport hospital doctor office family friend mother father brother sister son daughter baby ' +
  'summer winter spring autumn weather rain snow sun moon star sea river mountain street room door table chair ' +
  'good bad big small long short high low new old young early late large little own same different important ' +
  'possible likely clear sure easy hard true false free full best better worse well much many more most less ' +
  'least very really quite too also just only even still already again always never often sometimes usually ' +
  'because so however although while before after during between through about above below under over into out ' +
  'up down off on in at by for with without from to of as like than then there here where when why how what ' +
  'who which whose whom not no yes can could will would shall should may might must'
).split(/\s+/))

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const ladder = Array.isArray(raw.ladderMinutes)
    ? raw.ladderMinutes.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : []
  const dshHome = process.env.DSH_HOME || process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh')
  return {
    queueSize: clampInt(raw.queueSize, 1, 20, DEFAULTS.queueSize),
    autoContinue: raw.autoContinue === false ? false : DEFAULTS.autoContinue,
    wrongInject: clampInt(raw.wrongInject, 0, 10, DEFAULTS.wrongInject),
    retryDelayMinutes: clampNum(raw.retryDelayMinutes, 0.1, 1440, DEFAULTS.retryDelayMinutes),
    verifyAnswers: raw.verifyAnswers === false ? false : DEFAULTS.verifyAnswers,
    ladderMinutes: ladder.length > 0 ? ladder : DEFAULTS.ladderMinutes.slice(),
    highMultiplier: clampNum(raw.highMultiplier, 0.1, 3, DEFAULTS.highMultiplier),
    lowMultiplier: clampNum(raw.lowMultiplier, 0.5, 5, DEFAULTS.lowMultiplier),
    maxRecentErrors: clampInt(raw.maxRecentErrors, 1, 20, DEFAULTS.maxRecentErrors),
    startPrompt: typeof raw.startPrompt === 'string' && raw.startPrompt.trim() ? raw.startPrompt.trim() : DEFAULTS.startPrompt,
    continuePrompt: typeof raw.continuePrompt === 'string' && raw.continuePrompt.trim() ? raw.continuePrompt.trim() : DEFAULTS.continuePrompt,
    dataDir: typeof raw.dataDir === 'string' && raw.dataDir.trim() ? raw.dataDir.trim() : join(dshHome, 'vocab-review'),
    dailyNewLimit: clampInt(raw.dailyNewLimit, 0, 10_000, DEFAULTS.dailyNewLimit),
    dailyReviewLimit: clampInt(raw.dailyReviewLimit, 0, 10_000, DEFAULTS.dailyReviewLimit),
    dailyTotalLimit: clampInt(raw.dailyTotalLimit, 0, 10_000, DEFAULTS.dailyTotalLimit),
    dailyMinutesLimit: clampInt(raw.dailyMinutesLimit, 0, 24 * 60, DEFAULTS.dailyMinutesLimit),
    reminderMaxPerDay: clampInt(raw.reminderMaxPerDay, 0, 10, DEFAULTS.reminderMaxPerDay),
    channel: raw.channel === 'qq' || raw.channel === 'session' ? raw.channel : DEFAULTS.channel,
    qqStatePath: typeof raw.qqStatePath === 'string' && raw.qqStatePath.trim()
      ? raw.qqStatePath.trim()
      : join(dshHome, 'integrations', 'dsh-qq-bot', 'state.json'),
  }
}

function normalizeWord(raw) {
  if (typeof raw !== 'string') return ''
  return raw
    .trim()
    .replace(/^[\s\d.)、•*\-–—]+/, '')
    .replace(/^[«"'“”‘’(（]+/, '')
    .replace(/[»"'“”‘’()）.。,，;；:：!！?？]+$/, '')
    .trim()
    .toLowerCase()
}

// ── Answer text comparison ────────────────────────────────────────────────
// Meanings arrive from the model as short Chinese (or English) glosses. They
// are compared loosely: case, spaces and punctuation are dropped, a gloss may
// list alternatives ("放弃；抛弃"), and a partial answer ("放弃吧") counts.
function squashText(raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .toLowerCase()
    .replace(/\[qq\]/gi, ' ')
    .replace(/[\s\u3000，,。.、；;：:！!？?“”"'‘’《》()（）[\]【】<>~\-—_/\\|]+/gu, '')
}

function meaningTokens(meaning) {
  return String(meaning === undefined || meaning === null ? '' : meaning)
    .split(/[\s\u3000,，、；;：:/|（）()【】[\]《》]+/u)
    .map((token) => squashText(token))
    .filter((token) => token.length >= 2)
}

/** The user hedged ("好像…", "不确定"), which means "recognised, not solid". */
const UNCERTAIN_ANSWER = /(不确定|不清楚|拿不准|记不清|记不太清|记不稳|有点模糊|模糊|好像|似乎|大概是|可能是|猜的|蒙的|maybe|not\s*sure|unsure|guess)/i
/** The user openly did not know: the model must not grade this as correct. */
const NOT_ANSWERED = /^(?:忘了|忘记了|忘了怎么说|不知道|不会|想不起来|不记得|没记住|no\s*idea|don'?t\s*know|idk)[\s!！。.]*$/i
/** Chat control phrases that are not answers to the pending word. */
const CONTROL_ANSWER = /^(?:开始|继续|停止|暂停|统计|状态|查看|导出|开始背单词|开始复习|继续复习|停止复习)[^\s]{0,12}$/i

// Short Chinese answers are often a different wording of the same gloss
// ("真的" for "真正的；真诚的"). Accept when every meaningful character of the
// answer already appears in the gloss; particles are ignored because they carry
// no meaning on their own.
const SHORT_ANSWER_IGNORE = new Set(['的', '地', '得', '了', '着', '儿', '吧', '呢', '啊', '是', '很', '个', '一'])

function shortAnswerSubset(answer, target) {
  if (answer.length > 4 || !/[\u4e00-\u9fff]/u.test(answer)) return false
  const chars = new Set([...target])
  for (const char of answer) {
    if (SHORT_ANSWER_IGNORE.has(char)) continue
    if (!chars.has(char)) return false
  }
  return true
}

function splitWords(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,;，、]+/)
  const seen = new Set()
  const words = []
  for (const item of list) {
    let text = String(item)
    let freq = ''
    const freqMatch = /[:=]\s*(high|normal|low)\s*$/i.exec(text)
    if (freqMatch) {
      freq = freqMatch[1].toLowerCase()
      text = text.slice(0, freqMatch.index)
    }
    const word = normalizeWord(text)
    if (!/^[a-z][a-z'-]*$/.test(word) || word.length > 40 || seen.has(word)) continue
    seen.add(word)
    words.push({ word, freq })
  }
  return words
}

function classifyFrequency(word, override) {
  if (override === 'high' || override === 'normal' || override === 'low') return override
  if (HIGH_FREQUENCY.has(word)) return 'high'
  if (word.length >= 9) return 'low'
  return 'normal'
}

function frequencyMultiplier(freq, cfg) {
  if (freq === 'high') return cfg.highMultiplier
  if (freq === 'low') return cfg.lowMultiplier
  return 1
}

function fillWeight(freq) {
  if (freq === 'high') return 4
  if (freq === 'low') return 1
  return 2
}

function shuffle(list) {
  const copy = list.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return copy
}

function shuffledWeighted(list, count) {
  const pool = list.slice()
  const out = []
  while (out.length < count && pool.length > 0) {
    const total = pool.reduce((sum, entry) => sum + fillWeight(entry.freq), 0)
    let ticket = Math.random() * total
    let index = pool.length - 1
    for (let i = 0; i < pool.length; i++) {
      ticket -= fillWeight(pool[i].freq)
      if (ticket <= 0) {
        index = i
        break
      }
    }
    out.push(pool.splice(index, 1)[0])
  }
  return out
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function todayKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function endOfToday() {
  const date = new Date()
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

// Optional services (workspace registry, jobs, subagents, terminals) are read
// with ctx.get() so this plugin still activates in profiles that mount only a
// subset of them.
export const inject = ['tools', 'systemPrompt', 'webServer', 'sessionController', 'agents', 'timer']

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const ledgerPath = join(cfg.dataDir, 'ledger.json')
  const settingsPath = join(cfg.dataDir, 'settings.json')

  let state = loadLedger()
  let settings = loadSettings()
  let continueToken = 0

  // ── Persistence ──────────────────────────────────────────────────────────
  function freshCounters() {
    return { date: todayKey(), new: 0, review: 0, total: 0, minutes: 0 }
  }

  function freshState() {
    return {
      version: 2,
      plugin: PLUGIN,
      updatedAt: Date.now(),
      loop: 'idle',
      idleReason: null,
      activeSessionId: null,
      queue: [],
      queueCreatedAt: null,
      pendingWord: null,
      pendingCounted: false,
      lastTickAt: null,
      dailyCounters: freshCounters(),
      quota: null,
      reminderVersion: 0,
      reminderAt: null,
      reminderDueCount: 0,
      qqLastSendAt: null,
      qqError: '',
      lastConflict: null,
      words: {},
    }
  }

  function sanitizeWord(key, value) {
    const stage = Number.isFinite(value.stage) ? Math.max(0, Math.trunc(value.stage)) : 0
    return {
      word: typeof value.word === 'string' && value.word ? value.word : key,
      display: typeof value.display === 'string' && value.display ? value.display : key,
      meaning: typeof value.meaning === 'string' ? value.meaning : '',
      meanings: Array.isArray(value.meanings)
        ? value.meanings.filter((item) => typeof item === 'string' && item).slice(-4)
        : [],
      freq: value.freq === 'high' || value.freq === 'low' || value.freq === 'normal' ? value.freq : 'normal',
      stage: Math.min(stage, cfg.ladderMinutes.length - 1),
      dueAt: Number.isFinite(value.dueAt) ? value.dueAt : Date.now(),
      createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
      lastAskedAt: Number.isFinite(value.lastAskedAt) ? value.lastAskedAt : null,
      lastResultAt: Number.isFinite(value.lastResultAt) ? value.lastResultAt : null,
      lastErrorAt: Number.isFinite(value.lastErrorAt) ? value.lastErrorAt : null,
      lastFuzzyAt: Number.isFinite(value.lastFuzzyAt) ? value.lastFuzzyAt : null,
      correct: Number.isFinite(value.correct) ? value.correct : 0,
      errors: Number.isFinite(value.errors) ? value.errors : 0,
      fuzzy: Number.isFinite(value.fuzzy) ? value.fuzzy : 0,
    }
  }

  function loadLedger() {
    try {
      if (!existsSync(ledgerPath)) return freshState()
      const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      const next = freshState()
      if (!parsed || typeof parsed !== 'object') return next
      if (Number.isFinite(parsed.version) && parsed.version > SCHEMA_VERSION) {
        // A newer plugin wrote this ledger. Keep the words safe by moving the
        // file aside; the running plugin starts from an empty but valid state
        // instead of dropping fields it does not understand.
        try {
          renameSync(ledgerPath, `${ledgerPath}.v${parsed.version}.bak`)
        } catch {
          /* rename may fail if another process holds the file */
        }
        ctx.logger?.warn?.(
          `${PLUGIN}: ledger schema v${parsed.version} is newer than v${SCHEMA_VERSION}; moved it aside and started empty`,
        )
        return next
      }
      if (typeof parsed.activeSessionId === 'string') next.activeSessionId = parsed.activeSessionId
      if (Array.isArray(parsed.queue)) next.queue = parsed.queue.filter((word) => typeof word === 'string')
      if (Number.isFinite(parsed.queueCreatedAt)) next.queueCreatedAt = parsed.queueCreatedAt
      if (parsed.words && typeof parsed.words === 'object') {
        for (const [key, value] of Object.entries(parsed.words)) {
          if (value && typeof value === 'object') next.words[key] = sanitizeWord(key, value)
        }
      }
      next.queue = next.queue.filter((word) => next.words[word] !== undefined)
      if (parsed.version === 2) {
        if (parsed.loop === 'running' || parsed.loop === 'stopped' || parsed.loop === 'idle') next.loop = parsed.loop
        if (typeof parsed.pendingWord === 'string') next.pendingWord = parsed.pendingWord
        if (parsed.pendingCounted === true) next.pendingCounted = true
        if (Number.isFinite(parsed.lastTickAt)) next.lastTickAt = parsed.lastTickAt
        if (parsed.dailyCounters && typeof parsed.dailyCounters === 'object') {
          next.dailyCounters = {
            date: typeof parsed.dailyCounters.date === 'string' ? parsed.dailyCounters.date : todayKey(),
            new: Number.isFinite(parsed.dailyCounters.new) ? parsed.dailyCounters.new : 0,
            review: Number.isFinite(parsed.dailyCounters.review) ? parsed.dailyCounters.review : 0,
            total: Number.isFinite(parsed.dailyCounters.total) ? parsed.dailyCounters.total : 0,
            minutes: Number.isFinite(parsed.dailyCounters.minutes) ? parsed.dailyCounters.minutes : 0,
          }
        }
        if (parsed.quota && typeof parsed.quota === 'object' && typeof parsed.quota.message === 'string') next.quota = parsed.quota
        if (parsed.idleReason && typeof parsed.idleReason === 'object' && typeof parsed.idleReason.kind === 'string') {
          next.idleReason = {
            kind: parsed.idleReason.kind,
            at: Number.isFinite(parsed.idleReason.at) ? parsed.idleReason.at : Date.now(),
            nextDueAt: Number.isFinite(parsed.idleReason.nextDueAt) ? parsed.idleReason.nextDueAt : null,
            count: Number.isFinite(parsed.idleReason.count) ? parsed.idleReason.count : null,
          }
        }
        if (Number.isFinite(parsed.reminderVersion)) next.reminderVersion = parsed.reminderVersion
        if (Number.isFinite(parsed.reminderAt)) next.reminderAt = parsed.reminderAt
        if (Number.isFinite(parsed.reminderDueCount)) next.reminderDueCount = parsed.reminderDueCount
        if (Number.isFinite(parsed.qqLastSendAt)) next.qqLastSendAt = parsed.qqLastSendAt
        if (typeof parsed.qqError === 'string') next.qqError = parsed.qqError
        if (parsed.lastConflict && typeof parsed.lastConflict === 'object' && typeof parsed.lastConflict.word === 'string') {
          next.lastConflict = {
            word: parsed.lastConflict.word,
            at: Number.isFinite(parsed.lastConflict.at) ? parsed.lastConflict.at : Date.now(),
            answer: typeof parsed.lastConflict.answer === 'string' ? parsed.lastConflict.answer : '',
            expected: typeof parsed.lastConflict.expected === 'string' ? parsed.lastConflict.expected : '',
          }
        }
      } else {
        // v1 upgrade: an old "mode: review" queue becomes a stopped loop so the
        // plugin never starts asking questions on its own after an upgrade.
        if (next.queue.length > 0) next.loop = 'stopped'
      }
      if (next.queue.length === 0 && next.loop !== 'stopped') next.loop = 'idle'
      // A fresh process never continues a loop by itself; the user presses
      // Start to resume exactly at the queue head.
      if (next.loop === 'running') next.loop = 'stopped'
      if (next.pendingWord && !next.queue.includes(next.pendingWord)) {
        next.pendingWord = null
        next.pendingCounted = false
      }
      return next
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN}: could not read ${ledgerPath}: ${String(error)}`)
      return freshState()
    }
  }

  function saveLedger() {
    try {
      mkdirSync(cfg.dataDir, { recursive: true })
      state.updatedAt = Date.now()
      const tmp = `${ledgerPath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      renameSync(tmp, ledgerPath)
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN}: could not write ${ledgerPath}: ${String(error)}`)
    }
  }

  function loadSettings() {
    const next = {
      dailyNewLimit: cfg.dailyNewLimit,
      dailyReviewLimit: cfg.dailyReviewLimit,
      dailyTotalLimit: cfg.dailyTotalLimit,
      dailyMinutesLimit: cfg.dailyMinutesLimit,
      reminderMaxPerDay: cfg.reminderMaxPerDay,
      lastRemindedDate: '',
      remindCountDate: '',
      remindCount: 0,
      lastRemindAt: null,
      selectedSessionId: '',
      previousSessionId: '',
      channel: cfg.channel,
    }
    try {
      if (!existsSync(settingsPath)) return next
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return next
      for (const key of SETTINGS_KEYS) {
        if (Number.isFinite(parsed[key])) next[key] = parsed[key]
      }
      if (typeof parsed.lastRemindedDate === 'string') next.lastRemindedDate = parsed.lastRemindedDate
      if (typeof parsed.remindCountDate === 'string') next.remindCountDate = parsed.remindCountDate
      if (Number.isFinite(parsed.remindCount)) next.remindCount = parsed.remindCount
      if (Number.isFinite(parsed.lastRemindAt)) next.lastRemindAt = parsed.lastRemindAt
      if (typeof parsed.selectedSessionId === 'string') next.selectedSessionId = parsed.selectedSessionId
      if (typeof parsed.previousSessionId === 'string') next.previousSessionId = parsed.previousSessionId
      if (parsed.channel === 'qq' || parsed.channel === 'session' || parsed.channel === 'auto') next.channel = parsed.channel
      return next
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN}: could not read ${settingsPath}: ${String(error)}`)
      return next
    }
  }

  function saveSettings() {
    try {
      mkdirSync(cfg.dataDir, { recursive: true })
      const tmp = `${settingsPath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      renameSync(tmp, settingsPath)
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN}: could not write ${settingsPath}: ${String(error)}`)
    }
  }

  // Persist defaults once so the sidebar settings are editable from a real file.
  saveSettings()

  // ── Selected conversation (req. 7) ──────────────────────────────────────
  // The selected session is the ONLY place vocabulary prompts are delivered
  // and the only session whose QUEUE/protocol is injected.
  let sessionCache = { at: 0, rows: [] }

  function selectedSessionId() {
    return typeof settings.selectedSessionId === 'string' && settings.selectedSessionId ? settings.selectedSessionId : ''
  }

  function rememberSelected(sessionId) {
    settings.selectedSessionId = typeof sessionId === 'string' ? sessionId : ''
    saveSettings()
  }

  async function listSessionOptions(force = false) {
    if (!force && Date.now() - sessionCache.at < 4_000) return sessionCache.rows
    let items = []
    try {
      const value = await ctx.sessionController.list({}, new AbortController().signal)
      items = value && Array.isArray(value.items) ? value.items : []
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN}: could not list sessions: ${String(error)}`)
      return sessionCache.rows
    }
    let archived = new Set()
    try {
      const registry = ctx.get('workspaceRegistry')
      archived = new Set((registry && registry.archivedSessionIds) || [])
    } catch {
      archived = new Set()
    }
    const rows = []
    for (const item of items) {
      if (!item || typeof item.sessionId !== 'string') continue
      if (item.origin === 'subagent' || item.parentSessionId) continue
      if (archived.has(item.sessionId)) continue
      const values = item.projections && item.projections.values ? item.projections.values : {}
      const title = typeof values.title === 'string' && values.title.trim()
        ? values.title.trim()
        : item.blank
          ? 'New session'
          : 'Untitled'
      rows.push({
        sessionId: item.sessionId,
        title,
        updatedAt: item.updatedAt,
        running: Boolean(item.running),
      })
    }
    sessionCache = { at: Date.now(), rows }
    return rows
  }

  async function ensureSelectedSession() {
    if (settings.channel === 'qq') {
      const binding = qqBinding()
      if (binding.available && binding.sessionId) return binding.sessionId
    }
    const rows = await listSessionOptions()
    const current = selectedSessionId()
    if (current) {
      if (rows.length === 0 || rows.some((row) => row.sessionId === current)) return current
      // The selected conversation was archived or deleted.
      rememberSelected('')
    }
    if (rows.length > 0) {
      rememberSelected(rows[0].sessionId)
      return rows[0].sessionId
    }
    return ''
  }

  function routedSessionId() {
    const binding = qqBinding()
    if (binding.available && binding.sessionId) {
      if (settings.channel === 'qq') return binding.sessionId
      if (settings.channel === 'auto' && selectedSessionId() === binding.sessionId) return binding.sessionId
    }
    return selectedSessionId() || state.activeSessionId || ''
  }

  // ── QQ channel (dsh-qq-bot bridge) ───────────────────────────────────────
  // The official QQ bot keeps its single session binding and its last chat
  // target in its own state file; this plugin only reads that file. Delivery
  // reuses the bot's `send_qq_message` tool, so no AppID/secret, socket, or
  // second bot connection is duplicated here. Answers typed in QQ reach the
  // bound DSH session through the bot's normal inbound path, and the plugin
  // grades them from the same session events it already watches.
  let qqCache = { at: 0, value: null }

  function qqBinding(force = false) {
    if (!force && qqCache.value !== null && Date.now() - qqCache.at < 2_000) return qqCache.value
    const value = {
      available: false,
      sessionId: '',
      target: null,
      ownerOpenId: '',
      path: cfg.qqStatePath,
      error: '',
    }
    try {
      if (existsSync(cfg.qqStatePath)) {
        const doc = JSON.parse(readFileSync(cfg.qqStatePath, 'utf8'))
        value.available = true
        if (typeof doc.sessionId === 'string') value.sessionId = doc.sessionId
        if (doc.target && typeof doc.target.targetId === 'string' && doc.target.targetId) value.target = doc.target
        if (typeof doc.ownerOpenId === 'string') value.ownerOpenId = doc.ownerOpenId
      }
    } catch (error) {
      value.error = String(error && error.message ? error.message : error)
    }
    qqCache = { at: Date.now(), value }
    return value
  }

  function qqTool() {
    try {
      const tools = ctx.get('tools')
      if (!tools || typeof tools.get !== 'function') return null
      const definition = tools.get('send_qq_message')
      return definition && typeof definition.execute === 'function' ? definition : null
    } catch {
      return null
    }
  }

  function qqSendText(text) {
    const body = String(text === undefined || text === null ? '' : text).trim()
    if (!body) return Promise.resolve({ ok: false, error: 'empty QQ message' })
    const definition = qqTool()
    if (!definition) {
      return Promise.resolve({ ok: false, error: 'send_qq_message 工具不可用：未安装或未启用 QQ 机器人插件' })
    }
    const args = { text: body }
    const execution = {
      callId: `vocab-review-qq-${randomUUID()}`,
      name: 'send_qq_message',
      arguments: args,
      signal: new AbortController().signal,
    }
    return Promise.resolve()
      .then(() => definition.execute(args, execution))
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }))
  }

  // Fire-and-forget push; the outcome is persisted so the panel can show it.
  function qqPushText(text) {
    const body = String(text === undefined || text === null ? '' : text).trim()
    if (!body) return
    void qqSendText(body).then((result) => {
      state.qqLastSendAt = Date.now()
      state.qqError = result.ok ? '' : result.error
      if (!result.ok) ctx.logger?.warn?.(`${PLUGIN}: QQ delivery failed: ${result.error}`)
      saveLedger()
    })
  }

  function qqMode() {
    const binding = qqBinding()
    if (!binding.available || !binding.sessionId) return false
    if (settings.channel === 'session') return false
    if (settings.channel === 'qq') return true
    return selectedSessionId() === binding.sessionId
  }

  function questionLine(word) {
    return `Q: ${word && typeof word.word === 'string' ? word.word : ''}`
  }

  // A pushed question must not overtake the graded answer the QQ bot is still
  // delivering for the turn that produced it: wait for that turn to end, then
  // give the bot's own send a short head start.
  const QQ_NEXT_DELAY_MS = 1_500
  const QQ_NEXT_FALLBACK_MS = 8_000
  let qqNextPush = null
  let qqNextToken = 0

  function queueQqPush(text) {
    cancelQqPush()
    const token = ++qqNextToken
    const timer = setTimeout(() => {
      if (token !== qqNextToken) return
      qqNextPush = null
      qqPushText(text)
    }, QQ_NEXT_FALLBACK_MS)
    timer.unref?.()
    qqNextPush = { text: String(text), sessionId: routedSessionId(), timer }
  }

  function armQqPush(sessionId) {
    const pending = qqNextPush
    if (!pending || !sessionId || pending.sessionId !== sessionId) return
    qqNextPush = null
    if (pending.timer) clearTimeout(pending.timer)
    const token = ++qqNextToken
    const timer = setTimeout(() => {
      if (token !== qqNextToken) return
      qqPushText(pending.text)
    }, QQ_NEXT_DELAY_MS)
    timer.unref?.()
  }

  function cancelQqPush() {
    qqNextToken += 1
    if (!qqNextPush) return
    if (qqNextPush.timer) clearTimeout(qqNextPush.timer)
    qqNextPush = null
  }

  // ── Date rollover + quota ────────────────────────────────────────────────
  function ensureDay() {
    const today = todayKey()
    if (state.dailyCounters.date === today) return false
    state.dailyCounters = freshCounters()
    state.quota = null
    state.lastTickAt = Date.now()
    saveLedger()
    return true
  }

  function isNewWord(word) {
    return word.lastResultAt === null
  }

  function blockFor(word) {
    const counters = state.dailyCounters
    if (settings.dailyTotalLimit > 0 && counters.total >= settings.dailyTotalLimit) {
      return { kind: 'total', used: counters.total, limit: settings.dailyTotalLimit }
    }
    if (isNewWord(word)) {
      if (settings.dailyNewLimit > 0 && counters.new >= settings.dailyNewLimit) {
        return { kind: 'new', used: counters.new, limit: settings.dailyNewLimit }
      }
    } else if (settings.dailyReviewLimit > 0 && counters.review >= settings.dailyReviewLimit) {
      return { kind: 'review', used: counters.review, limit: settings.dailyReviewLimit }
    }
    if (settings.dailyMinutesLimit > 0 && counters.minutes >= settings.dailyMinutesLimit) {
      return { kind: 'minutes', used: Math.round(counters.minutes), limit: settings.dailyMinutesLimit }
    }
    return null
  }

  function quotaMessage(block) {
    return `今日已达上限 (${block.kind} ${block.used}/${block.limit})`
  }

  function markTick() {
    const now = Date.now()
    ensureDay()
    if (state.lastTickAt !== null && now > state.lastTickAt) {
      const minutes = Math.min((now - state.lastTickAt) / 60_000, 5)
      state.dailyCounters.minutes = Math.round((state.dailyCounters.minutes + minutes) * 100) / 100
    }
    state.lastTickAt = now
  }

  function countQuestion(word) {
    ensureDay()
    if (isNewWord(word)) state.dailyCounters.new += 1
    else state.dailyCounters.review += 1
    state.dailyCounters.total += 1
    word.lastAskedAt = Date.now()
    state.pendingWord = word.word
    state.pendingCounted = true
    state.lastTickAt = Date.now()
    saveLedger()
  }

  function setQuotaStopped(block) {
    cancelQqPush()
    state.loop = 'stopped'
    state.quota = { ...block, message: quotaMessage(block), at: Date.now() }
    state.lastTickAt = Date.now()
    saveLedger()
    return state.quota
  }

  function clockText(ms) {
    const date = new Date(ms)
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }

  // The loop stops by itself only when there is nothing left to ask. Say why
  // out loud instead of going quiet: the panel reads `idleReason` and the QQ
  // channel gets one short message.
  function goIdle(reason, options = {}) {
    cancelQqPush()
    const meta = reason && typeof reason === 'object' ? reason : {}
    state.loop = 'idle'
    state.pendingWord = null
    state.pendingCounted = false
    state.idleReason = {
      kind: typeof meta.kind === 'string' ? meta.kind : 'empty',
      at: Date.now(),
      nextDueAt: Number.isFinite(meta.nextDueAt) ? meta.nextDueAt : nextDueAt(),
      count: Number.isFinite(meta.count) ? meta.count : null,
    }
    markTick()
    saveLedger()
    if (options.silent !== true) notifyIdle(state.idleReason)
    return state.idleReason
  }

  function notifyIdle(reason) {
    if (!qqMode()) return
    const done = state.dailyCounters.total
    let text = ''
    if (reason.kind === 'no-due') {
      const next = Number.isFinite(reason.nextDueAt) ? `，下一个 ${clockText(reason.nextDueAt)} 到期` : ''
      text = `✅ 今天到期的单词都复习完了（今日 ${done} 个${next}）。想继续就回「开始背单词」。`
    } else if (reason.kind === 'empty') {
      text = '复习已结束：词库里还没有单词。先导入单词表，再回「开始背单词」。'
    }
    if (text) qqPushText(text)
  }

  function clearQuotaIfDateChanged() {
    ensureDay()
  }

  // ── Scheduling (all arithmetic stays here, never in the model) ───────────
  function entries() {
    return Object.values(state.words)
  }

  function dueNowList(now = Date.now()) {
    return entries().filter((word) => word.dueAt <= now)
  }

  function nextDueAt(now = Date.now()) {
    let best = null
    for (const word of entries()) {
      if (word.dueAt <= now) continue
      if (best === null || word.dueAt < best) best = word.dueAt
    }
    return best
  }

  function intervalOf(word) {
    const stage = Math.min(word.stage, cfg.ladderMinutes.length - 1)
    const minutes = cfg.ladderMinutes[stage] * frequencyMultiplier(word.freq, cfg)
    return Math.max(60_000, Math.round(minutes * 60_000))
  }

  // "Fuzzy" is a half step: the word stays where it is on the ladder but comes
  // back at half the current interval (never sooner than the wrong-answer
  // retry delay, never later than the interval itself).
  function fuzzyIntervalOf(word) {
    const half = Math.round(intervalOf(word) / 2)
    const floor = Math.round(cfg.retryDelayMinutes * 60_000)
    return Math.min(Math.max(floor, half), intervalOf(word))
  }

  // `dueOnly` is the continuous mode: it only ever takes words that are due
  // right now, so an auto-continued loop stops instead of asking a word far
  // ahead of its schedule.
  function buildQueue(now = Date.now(), options = {}) {
    const dueOnly = options.dueOnly === true
    const picked = []
    const seen = new Set()
    const take = (word) => {
      if (picked.length >= cfg.queueSize) return
      if (seen.has(word.word)) return
      seen.add(word.word)
      picked.push(word.word)
    }

    // 1. Due items first; due reviews before due new words.
    const due = dueNowList(now).sort((a, b) => {
      const aNew = isNewWord(a) ? 1 : 0
      const bNew = isNewWord(b) ? 1 : 0
      if (aNew !== bNew) return aNew - bNew
      return a.dueAt - b.dueAt
    })
    for (const word of due) take(word)
    if (dueOnly) return picked

    // 2. Randomly inject previously-wrong items.
    const wrongPool = shuffle(entries().filter((word) => word.errors > 0 && !seen.has(word.word)))
    for (const word of wrongPool.slice(0, cfg.wrongInject)) take(word)

    // 3. Fill remaining slots: already-reviewed words first, new words after.
    const rest = entries().filter((word) => !seen.has(word.word))
    const reviewed = rest.filter((word) => !isNewWord(word))
    const fresh = rest.filter((word) => isNewWord(word))
    for (const word of shuffledWeighted(reviewed, cfg.queueSize - picked.length)) take(word)
    for (const word of shuffledWeighted(fresh, cfg.queueSize - picked.length)) take(word)

    return picked
  }

  // Pick the next word inside the queue; due reviews are preferred over new
  // words, and a word whose type limit is exhausted is skipped when another
  // eligible word remains.
  function pickEligible() {
    const reviews = []
    const newWords = []
    for (const key of state.queue) {
      const word = state.words[key]
      if (!word) continue
      if (isNewWord(word)) newWords.push(word)
      else reviews.push(word)
    }
    for (const word of reviews) if (!blockFor(word)) return word
    for (const word of newWords) if (!blockFor(word)) return word
    return null
  }

  function beginQuestion() {
    if (state.loop !== 'running') return { ok: false, reason: 'not-running' }
    ensureDay()
    if (state.queue.length === 0 && cfg.autoContinue) {
      // Continuous review: refill with words that are due now and keep asking.
      // This is what makes a session run past one queueSize batch.
      const refilled = buildQueue(Date.now(), { dueOnly: true })
      if (refilled.length > 0) {
        state.queue = refilled
        state.queueCreatedAt = Date.now()
        markTick()
      }
    }
    if (state.queue.length === 0) {
      goIdle({ kind: entries().length === 0 ? 'empty' : 'no-due', count: 0 })
      return { ok: false, reason: 'empty' }
    }
    const headKey = state.queue[0]
    const head = state.words[headKey]
    // Resuming the exact question that was already counted (e.g. Stop then
    // Start) must not count it twice or reorder the queue.
    if (head && state.pendingWord === headKey && state.pendingCounted && head.lastResultAt === null) {
      markTick()
      saveLedger()
      return { ok: true, word: head, resumed: true }
    }
    const picked = pickEligible()
    if (!picked) {
      const block = (head && blockFor(head)) || blockFor(head || entries()[0] || { lastResultAt: null })
      if (block) setQuotaStopped(block)
      return { ok: false, reason: 'quota', quota: state.quota }
    }
    if (picked.word !== state.queue[0]) {
      state.queue = [picked.word, ...state.queue.filter((key) => key !== picked.word)]
    }
    markTick()
    countQuestion(picked)
    return { ok: true, word: picked, resumed: false }
  }

  function issueContinue(sessionId) {
    const target = routedSessionId() || sessionId
    if (!target) return
    if (qqMode()) {
      const head = state.words[state.queue[0]]
      if (head) qqPushText(questionLine(head))
      return
    }
    const token = ++continueToken
    void Promise.resolve()
      .then(() => {
        if (token !== continueToken) return
        return ctx.sessionController.prompt(
          {
            requestId: `vocab-review-${randomUUID()}`,
            sessionId: target,
            mode: 'queue',
            content: [{ type: 'text', text: cfg.continuePrompt }],
          },
          new AbortController().signal,
        )
      })
      .catch((error) => {
        ctx.logger?.warn?.(`${PLUGIN}: could not queue the next question: ${String(error && error.message ? error.message : error)}`)
      })
  }

  function advanceAfterAnswer(sessionId, modelAsked = '') {
    if (state.loop !== 'running') {
      saveLedger()
      return
    }
    // beginQuestion refills the queue from due words (autoContinue) and goes
    // idle with a reason when nothing is left to ask.
    const next = beginQuestion()
    if (!next.ok) {
      saveLedger()
      return
    }
    if (qqMode()) {
      // If the model (against protocol) already printed the next Q line, the
      // bot delivered that line; pushing again would ask the same word twice.
      if (modelAsked && next.word && modelAsked === next.word.word) return
      queueQqPush(questionLine(next.word))
      return
    }
    issueContinue(sessionId)
  }

  function startLoop(sessionId) {
    const target = sessionId || selectedSessionId()
    if (target && selectedSessionId() !== target) rememberSelected(target)
    ensureDay()
    if (state.queue.length === 0) {
      state.queue = buildQueue()
      state.queueCreatedAt = Date.now()
      if (state.queue.length === 0) {
        goIdle({ kind: 'empty', nextDueAt: null }, { silent: true })
        return { ok: false, error: 'no-words' }
      }
    }
    if (state.pendingWord && !state.queue.includes(state.pendingWord)) {
      state.pendingWord = null
      state.pendingCounted = false
    }
    state.loop = 'running'
    state.quota = null
    state.idleReason = null
    if (typeof target === 'string' && target) state.activeSessionId = target
    const question = beginQuestion()
    if (!question.ok) {
      return { ok: false, error: question.reason === 'quota' ? 'quota' : 'no-words', quota: state.quota, queue: state.queue.slice() }
    }
    return { ok: true, word: question.word, resumed: question.resumed, queue: state.queue.slice() }
  }

  function stopLoop() {
    cancelQqPush()
    markTick()
    state.loop = 'stopped'
    saveLedger()
  }

  // ── The user's own answer, kept for the plugin-side verdict check ────────
  // The model prints the grade line, but it does not get the last word: the
  // pending word's stored meaning is compared with what the user actually
  // typed. The last user message is kept in memory only; a fresh process has
  // no answer to re-check.
  let lastUserMessage = { text: '', at: 0, sessionId: '' }

  function rememberUserText(text, sessionId) {
    lastUserMessage = {
      text: typeof text === 'string' ? text : '',
      at: Date.now(),
      sessionId: typeof sessionId === 'string' ? sessionId : '',
    }
  }

  function takeUserAnswer(sessionId) {
    if (!lastUserMessage.text) return null
    if (Date.now() - lastUserMessage.at > 5 * 60_000) return null
    if (sessionId && lastUserMessage.sessionId && sessionId !== lastUserMessage.sessionId) return null
    const text = lastUserMessage.text.replace(/^\s*\[qq\]\s*/i, '').trim()
    if (!text) return null
    if (text === cfg.startPrompt || text === cfg.continuePrompt) return null
    if (STOP_WORDS.test(text) || CONTROL_ANSWER.test(text)) return null
    return text
  }

  // A stored meaning is a short gloss, possibly listing alternatives. Compare
  // loosely: punctuation/case dropped, any gloss accepted, partial answer ok.
  function answerMatchesStored(answerText, word) {
    const bank = [word.meaning, ...(Array.isArray(word.meanings) ? word.meanings : [])].filter(Boolean)
    if (bank.length === 0) return true // no reference yet: the first answer defines it
    const answer = squashText(answerText)
    if (answer.length < 2) return true // too short to judge ("嗯", "嗯…")
    for (const meaning of bank) {
      const target = squashText(meaning)
      if (!target) continue
      if (target === answer || target.includes(answer) || answer.includes(target)) return true
      for (const token of meaningTokens(meaning)) {
        if (answer.includes(token) || token.includes(answer)) return true
      }
      if (shortAnswerSubset(answer, target)) return true
    }
    return false
  }

  // Three outcomes: correct / fuzzy (recognised, not solid) / wrong. The model
  // proposes one; the plugin may only downgrade it, never upgrade an explicit
  // ❌ into a ✅.
  function gradeAnswer(key, modelVerdict, meaning, sessionId) {
    const word = state.words[key]
    if (!word) return false
    const answerText = takeUserAnswer(sessionId) || ''
    let verdict = modelVerdict
    if (verdict === 'correct' && answerText) {
      if (NOT_ANSWERED.test(answerText.trim())) {
        verdict = 'wrong'
      } else if (cfg.verifyAnswers && !answerMatchesStored(answerText, word)) {
        verdict = 'wrong'
        state.lastConflict = {
          word: key,
          at: Date.now(),
          answer: answerText.slice(0, 80),
          expected: [word.meaning, ...(word.meanings || [])].filter(Boolean).join(' / ').slice(0, 80),
        }
      } else if (UNCERTAIN_ANSWER.test(answerText)) {
        verdict = 'fuzzy'
      }
    }
    return recordAnswer(key, verdict, meaning, sessionId)
  }

  function recordAnswer(key, verdict, meaning, sessionId) {
    const word = state.words[key]
    if (!word) return false
    const now = Date.now()
    if (word.lastResultAt !== null && now - word.lastResultAt < 1500) return false
    const cleanMeaning = typeof meaning === 'string' ? meaning.trim().replace(/^[=:：\-–—\s]+/, '').slice(0, 120) : ''
    if (cleanMeaning) {
      // Keep the previous gloss as an accepted alternative ("放弃" / "抛弃").
      if (word.meaning && word.meaning !== cleanMeaning) {
        const bank = Array.isArray(word.meanings) ? word.meanings.filter((item) => item !== cleanMeaning) : []
        word.meanings = [...bank, word.meaning].slice(-4)
      }
      word.meaning = cleanMeaning
    }
    word.lastResultAt = now
    if (verdict === 'fuzzy') {
      // Same stage, half the interval: it returns soon without being thrown
      // back to step one like a real mistake.
      word.fuzzy += 1
      word.lastFuzzyAt = now
      word.dueAt = now + fuzzyIntervalOf(word)
    } else if (verdict === 'correct') {
      word.correct += 1
      word.stage = Math.min(word.stage + 1, cfg.ladderMinutes.length - 1)
      word.dueAt = now + intervalOf(word)
    } else {
      word.errors += 1
      word.lastErrorAt = now
      word.stage = 0
      word.dueAt = now + Math.round(cfg.retryDelayMinutes * 60_000)
    }
    const queued = state.queue.indexOf(key)
    if (queued >= 0) state.queue.splice(queued, 1)
    if (state.pendingWord === key) {
      state.pendingWord = null
      state.pendingCounted = false
    }
    if (typeof sessionId === 'string' && sessionId) state.activeSessionId = sessionId
    markTick()
    saveLedger()
    return true
  }

  // ── Image ingestion (the model reads the image; the plugin keeps words) ──
  function importWords(raw, sessionId) {
    const parsed = splitWords(raw)
    if (parsed.length === 0) return { ok: false, error: 'no-words', words: [], queue: [] }
    const now = Date.now()
    for (const item of parsed) {
      const existing = state.words[item.word]
      if (existing) {
        existing.freq = classifyFrequency(item.word, item.freq || existing.freq)
        existing.display = item.word
        continue
      }
      state.words[item.word] = {
        word: item.word,
        display: item.word,
        meaning: '',
        meanings: [],
        freq: classifyFrequency(item.word, item.freq),
        stage: 0,
        dueAt: now,
        createdAt: now,
        lastAskedAt: null,
        lastResultAt: null,
        lastErrorAt: null,
        lastFuzzyAt: null,
        correct: 0,
        errors: 0,
        fuzzy: 0,
      }
    }
    const keys = []
    for (const item of parsed) if (!keys.includes(item.word)) keys.push(item.word)
    if (typeof sessionId === 'string' && sessionId) state.activeSessionId = sessionId
    // Route the review to the selected conversation. When the words were
    // imported from a different session, the queue waits for Start there.
    if (!selectedSessionId() && typeof sessionId === 'string' && sessionId) rememberSelected(sessionId)
    const routed = selectedSessionId()
    state.queue = keys.slice(0, cfg.queueSize)
    state.queueCreatedAt = now
    state.pendingWord = null
    state.pendingCounted = false
    state.quota = null
    state.idleReason = null
    const sameSession = Boolean(sessionId) && routed === sessionId
    if (!sameSession) {
      state.loop = 'stopped'
      saveLedger()
      return { ok: true, blocked: false, deferred: true, words: keys, queue: state.queue.slice(), routed }
    }
    state.loop = 'running'
    ensureDay()
    const question = beginQuestion()
    if (!question.ok) {
      return { ok: true, blocked: true, words: keys, queue: state.queue.slice(), quota: state.quota }
    }
    return { ok: true, blocked: false, words: keys, queue: state.queue.slice(), first: question.word.word }
  }

  // ── Per-agent prompt injection ───────────────────────────────────────────
  const IMPORT_SECTION = [
    '[Vocabulary review plugin]',
    'When the user uploads an English worksheet/word-list image, read the image, extract every underlined English word (base form only), and call vocab_import once with the words comma-separated. Never repeat or store the image; the plugin keeps only the word list.',
    'When the user asks to start/continue vocabulary review, call vocab_start instead of inventing words.',
  ].join('\n')

  const REVIEW_PROTOCOL = [
    '[Vocabulary review is ACTIVE]',
    'Output protocol — follow it strictly, with no explanations, encouragement, tables, or extra lines:',
    '1. The injected context lists QUEUE (its first word is the current question) and DUE. Ask one word per turn, exactly one line: `Q: {word}`. Always use the FIRST word of QUEUE.',
    '2. When the user replies to your `Q:` line with an answer, judge it and reply with exactly one line, choosing exactly one of three gradings: `✅ {word} = {meaning}` (correct), `🤔 {word} = {meaning}` (right, but the user hedged/asked back/only gave part of the meaning), `❌ {word} = {meaning}` (wrong, "不知道", or no answer). Keep the meaning short (Chinese is fine). Never add anything after that line.',
    '2a. The plugin re-checks every ✅ against the meaning it stored; a different meaning is scheduled as wrong even if you accepted it. Grade strictly, do not be encouraging.',
    '3. The plugin then sends the continuation "继续复习" automatically. On that continuation your next message must be the next question `Q: {word}` — it is not an answer to grade.',
    '4. The plugin records and schedules everything. Never calculate due words, error counts, quota, or scheduling yourself; use only the injected QUEUE.',
    '5. If the user asks to stop, call vocab_stop. Stop is handled by the plugin, not by you.',
  ].join('\n')

  // QQ variant: the plugin pushes each question itself, so the model must not
  // repeat it. A [QQ] message is the answer the model has to grade.
  const QQ_REVIEW_PROTOCOL = [
    '[Vocabulary review is ACTIVE — QQ channel]',
    'The plugin sends every `Q: {word}` line to QQ directly. Follow this strictly:',
    '1. Never print a `Q:` line on your own — except when a tool result explicitly says "Ask only the first word now: Q: {word}". In that single case reply with exactly that one line.',
    '2. A user message that starts with `[QQ]` is the user answering the pending word — the injected PENDING/QUEUE-first word. Judge it and reply with exactly one line, choosing exactly one of three gradings: `✅ {word} = {meaning}` (correct), `🤔 {word} = {meaning}` (right, but the user hedged/asked back/only gave part of the meaning), `❌ {word} = {meaning}` (wrong, "不知道", or no answer). Keep the meaning short (Chinese is fine). The QQ bot relays this line to the user — add nothing else.',
    '2a. The plugin re-checks every ✅ against the meaning it stored; a different meaning is scheduled as wrong even if you accepted it. Grade strictly, do not be encouraging.',
    '3. If that message is clearly not an answer (e.g. 开始/继续/停止/统计 or a pasted word list), use the matching tool instead: vocab_start, vocab_stop, vocab_stats, vocab_import.',
    '4. The plugin records answers and schedules the next question; never calculate due words, quota, or timing yourself. The next `Q:` line arrives from the plugin.',
    '5. Keep replies to QQ short: one line unless a tool result asks otherwise.',
  ].join('\n')

  // QQ idle: the loop is not running, but this chat still speaks vocabulary.
  const QQ_IDLE_PROTOCOL = [
    '[Vocabulary review on QQ]',
    'This QQ conversation can run the vocabulary review. When the user asks to start or continue reviewing, call vocab_start (never invent words). To stop, call vocab_stop; for a summary, call vocab_stats; when the user pastes or lists English words, call vocab_import with them.',
  ].join('\n')

  function reviewActiveFor(agentId) {
    return state.loop === 'running'
      && state.queue.length > 0
      && typeof agentId === 'string'
      && agentId === routedSessionId()
  }

  function protocolText(agentId) {
    const active = reviewActiveFor(agentId)
    const onQq = typeof agentId === 'string' && agentId !== '' && agentId === qqBinding().sessionId
    if (active) return `${IMPORT_SECTION}\n\n${onQq ? QQ_REVIEW_PROTOCOL : REVIEW_PROTOCOL}`
    if (onQq) return `${IMPORT_SECTION}\n\n${QQ_IDLE_PROTOCOL}`
    return ''
  }

  function queueText(agentId) {
    if (!reviewActiveFor(agentId)) return ''
    const now = Date.now()
    const due = dueNowList(now).length
    const wrong = entries().filter((word) => word.errors > 0).length
    const lines = [`QUEUE: ${state.queue.join(', ')}`, `DUE: ${due} due now · ${wrong} wrong · ${entries().length} words`]
    if (qqMode()) {
      const head = state.words[state.queue[0]]
      lines.push(`PENDING: ${head ? head.word : ''}`)
    }
    return lines.join('\n')
  }

  const agentScopes = new Map()

  function installAgent(agent) {
    if (!agent || typeof agent.id !== 'string' || agentScopes.has(agent.id)) return
    const scoped = agent.ctx
    if (!scoped || typeof scoped.effect !== 'function') return
    const systemPrompt = typeof scoped.get === 'function' ? scoped.get('systemPrompt') : scoped.systemPrompt
    if (!systemPrompt) return
    const dispose = scoped.effect(() => {
      const disposeSection = systemPrompt.section({
        name: 'vocab-review-protocol',
        order: 900,
        text: () => protocolText(agent.id),
      })
      const disposeContext = systemPrompt.context({
        name: 'vocab-review-queue',
        order: 900,
        required: false,
        text: () => queueText(agent.id),
      })
      return () => {
        disposeContext()
        disposeSection()
      }
    })
    agentScopes.set(agent.id, dispose)
  }

  function removeAgent(agentId) {
    const dispose = agentScopes.get(agentId)
    if (!dispose) return
    agentScopes.delete(agentId)
    try {
      dispose()
    } catch {
      /* the agent context may already be torn down */
    }
  }

  for (const liveAgent of ctx.agents.list()) installAgent(liveAgent)
  ctx.on('agent/created', (payload) => installAgent(payload && payload.agent))
  ctx.on('agent/disposed', (payload) => removeAgent(payload && payload.agent && payload.agent.id))
  ctx.effect(() => () => {
    for (const agentId of [...agentScopes.keys()]) removeAgent(agentId)
  }, `${PLUGIN}: agent prompt scopes`)

  // ── Observe the committed answer lines ───────────────────────────────────
  function sessionIdOfAgent(agent) {
    return agent && agent.session && typeof agent.session.id === 'string' ? agent.session.id : undefined
  }

  function parseGradeLine(line) {
    const trimmed = String(line || '').trim()
    if (!trimmed) return null
    const mark = /^(✅|✔️?|☑️?|🤔|❔|❓|⁉️?|❌|✖️?|✗)\s*/u.exec(trimmed)
    if (!mark) return null
    const pair = /^(.+?)\s*=\s*(.+)$/u.exec(trimmed.slice(mark[0].length))
    if (!pair) return null
    const symbol = mark[1]
    const verdict = symbol.startsWith('🤔') || symbol.startsWith('❔') || symbol.startsWith('❓') || symbol.startsWith('⁉')
      ? 'fuzzy'
      : symbol.startsWith('❌') || symbol.startsWith('✖') || symbol.startsWith('✗')
        ? 'wrong'
        : 'correct'
    return { verdict, word: pair[1], meaning: pair[2] }
  }

  function handleAssistantText(text, session) {
    if (!text) return
    const sessionId = session && typeof session.id === 'string' ? session.id : undefined
    const routed = routedSessionId()
    if (routed && sessionId && sessionId !== routed) return
    let recorded = false
    for (const line of text.split(/\r?\n/)) {
      const grade = parseGradeLine(line)
      if (!grade) continue
      const key = normalizeWord(grade.word)
      if (!state.words[key]) continue
      if (gradeAnswer(key, grade.verdict, grade.meaning, sessionId)) recorded = true
    }
    if (!recorded) return
    // The next `Q:` line usually comes from the plugin, but a model replying
    // with both the grade and the next question must not make the plugin ask it
    // a second time.
    const asked = /(?:^|\n)\s*Q:\s*([A-Za-z][A-Za-z'-]*)/u.exec(text)
    advanceAfterAnswer(sessionId, asked ? normalizeWord(asked[1]) : '')
  }

  function textOfEvent(event) {
    if (!event || !event.data) return ''
    if (event.type === 'assistant/message') return messageText(event.data.message)
    if (event.type === 'user/message') return messageText(event.data)
    return ''
  }

  const STOP_WORDS = /^(?:stop|quit|pause|结束|停止|暂停|不练了|不学了)[\s!！。.]*$/i

  ctx.on('session/event', (session, event) => {
    if (!event || typeof event.type !== 'string') return
    if (event.type === 'turn/end') {
      // Deliver the queued next question only after the graded answer's own
      // turn finished, so the bot's reply is not overtaken by the next Q line.
      const endedId = session && typeof session.id === 'string' ? session.id : ''
      if (endedId) armQqPush(endedId)
      return
    }
    if (event.type === 'assistant/message') {
      handleAssistantText(textOfEvent(event), session)
      return
    }
    if (event.type === 'user/message') {
      const text = textOfEvent(event).trim()
      if (!text) return
      const sessionId = session && typeof session.id === 'string' ? session.id : ''
      rememberUserText(text, sessionId)
      if (STOP_WORDS.test(text)) stopLoop()
    }
  })

  // ── Agent tools ──────────────────────────────────────────────────────────
  const toolOutput = {
    schema: { type: 'object' },
    render(_args, value) {
      const text = value && typeof value.message === 'string' ? value.message : 'ok'
      return [{ type: 'text', text }]
    },
  }

  ctx.effect(
    () => ctx.tools.register({
      name: 'vocab_import',
      description:
        'Import the underlined English words from the worksheet image the user just uploaded, or a word list they typed. Pass base-form words only, comma-separated. The plugin stores only the clean word list, never the image. Starts a review session and returns the queue (or the daily-quota stop message).',
      parameters: {
        type: 'object',
        properties: {
          words: {
            type: 'string',
            description: 'Comma-separated English words in base form, e.g. "abandon, benefit, cautious".',
          },
          frequency: {
            type: 'string',
            description: 'Optional frequency hints: "high", "low", "normal", or comma-separated word:high pairs.',
          },
        },
        required: ['words'],
        additionalProperties: false,
      },
      output: toolOutput,
      async execute(args, exec) {
        const raw = [args && args.words ? args.words : '', args && args.frequency ? args.frequency : ''].filter(Boolean).join(',')
        const result = importWords(raw, sessionIdOfAgent(exec && exec.agent))
        if (!result.ok) {
          return { ok: false, message: 'No valid English words were found. Ask the user for a clearer worksheet image.', words: [], queue: [] }
        }
        if (result.blocked) {
          return {
            ok: true,
            blocked: true,
            message: `${result.quota && result.quota.message ? result.quota.message : '今日已达上限'}. Imported ${result.words.length} words; the queue is kept for the next review day.`,
            words: result.words,
            queue: result.queue,
          }
        }
        if (result.deferred) {
          return {
            ok: true,
            deferred: true,
            message: `Imported ${result.words.length} words. The review routes to the selected conversation; open the Vocabulary review panel and press Start (or call vocab_start there) to ask the first question.`,
            words: result.words,
            queue: result.queue,
          }
        }
        return {
          ok: true,
          message: `Imported ${result.words.length} words. QUEUE: ${result.queue.join(', ')}. Ask only the first word now: Q: ${result.first}`,
          words: result.words,
          queue: result.queue,
        }
      },
    }),
    `${PLUGIN}: vocab_import tool`,
  )

  ctx.effect(
    () => ctx.tools.register({
      name: 'vocab_start',
      description: 'Start or resume a vocabulary review session from the saved queue. Use when the user asks to start/continue reviewing vocabulary.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: toolOutput,
      async execute(_args, exec) {
        const callerId = sessionIdOfAgent(exec && exec.agent)
        const result = startLoop(callerId)
        if (!result.ok) {
          if (result.error === 'quota') {
            return { ok: false, message: `${result.quota && result.quota.message ? result.quota.message : '今日已达上限'}. Queue kept: ${result.queue.join(', ')}` }
          }
          return { ok: false, message: 'There are no words in the review ledger yet. Upload a worksheet image first and call vocab_import.' }
        }
        const routed = routedSessionId()
        if (routed && callerId && routed !== callerId) {
          issueContinue(routed)
          return {
            ok: true,
            message: `Review running in the selected conversation (${routed}). Queue: ${result.queue.join(', ')}.`,
            queue: result.queue,
          }
        }
        return {
          ok: true,
          message: `Review running. QUEUE: ${result.queue.join(', ')}. Ask only the first word now: Q: ${result.word.word}`,
          queue: result.queue,
        }
      },
    }),
    `${PLUGIN}: vocab_start tool`,
  )

  ctx.effect(
    () => ctx.tools.register({
      name: 'vocab_stop',
      description: 'Stop the active vocabulary review loop. Keeps the ledger and the queue; no further question is issued and no message is added to the transcript. Use only when the user asks to stop.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: toolOutput,
      async execute() {
        stopLoop()
        return { ok: true, message: 'Review loop stopped. The queue is kept; press Start in the panel (or call vocab_start) to resume.' }
      },
    }),
    `${PLUGIN}: vocab_stop tool`,
  )

  ctx.effect(
    () => ctx.tools.register({
      name: 'vocab_stats',
      description: 'Read a compact vocabulary review summary: due count, wrong-word count, fuzzy-word count, total words, current queue, loop state, and daily quota counters.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: toolOutput,
      async execute() {
        const summary = publicState()
        const next = summary.idleReason && Number.isFinite(summary.idleReason.nextDueAt)
          ? ` · next due ${clockText(summary.idleReason.nextDueAt)}`
          : summary.nextDueAt
            ? ` · next due ${clockText(summary.nextDueAt)}`
            : ''
        return {
          ok: true,
          message: `DUE: ${summary.dueNow} due now · ${summary.wrongCount} wrong · ${summary.fuzzyCount} fuzzy · ${summary.total} words · loop ${summary.loop}${next} · today ${summary.counters.total} questions. QUEUE: ${summary.queue.join(', ') || '(empty)'}`,
          ...summary,
        }
      },
    }),
    `${PLUGIN}: vocab_stats tool`,
  )

  // ── Reminders (timestamp comparison, at most N per day) ──────────────────
  function checkReminder() {
    if (settings.reminderMaxPerDay <= 0) return
    const today = todayKey()
    if (settings.remindCountDate !== today) {
      settings.remindCountDate = today
      settings.remindCount = 0
      saveSettings()
    }
    if (settings.lastRemindedDate === today && settings.remindCount >= settings.reminderMaxPerDay) return
    const all = entries()
    if (all.length === 0) return
    const earliest = all.reduce((min, word) => Math.min(min, word.dueAt), Number.POSITIVE_INFINITY)
    const now = Date.now()
    if (now < earliest) return
    if (settings.remindCount > 0 && settings.lastRemindAt !== null && now - settings.lastRemindAt < REMINDER_MIN_GAP_MS) return
    settings.remindCount += 1
    settings.remindCountDate = today
    settings.lastRemindedDate = today
    settings.lastRemindAt = now
    saveSettings()
    state.reminderVersion += 1
    state.reminderAt = now
    state.reminderDueCount = dueNowList(now).length
    saveLedger()
    ctx.logger?.info?.(`${PLUGIN}: reminder #${settings.remindCount} today for ${state.reminderDueCount} due words`)
    if (state.loop !== 'running') {
      const binding = qqBinding()
      if (qqMode() && binding.target) {
        qqPushText(`⏰ 词汇复习提醒：今天有 ${state.reminderDueCount} 个单词到期。回复「开始背单词」继续复习。`)
      }
    }
  }

  ctx.effect(() => ctx.timer.interval(checkReminder, REMINDER_TICK_MS), `${PLUGIN}: reminder timer`)
  ctx.effect(() => ctx.timer.timeout(checkReminder, 2_000), `${PLUGIN}: reminder startup check`)

  // ── Strong-pause Stop (req. 8) ───────────────────────────────────────────
  // Same cancellation sequence as dsh-interrupt-button: cancel the selected
  // session's turn, kill its background jobs and terminals, interrupt its
  // child agents. Silent: no prompt, no steer, no transcript row.
  async function strongPause() {
    const sessionId = routedSessionId()
    const report = { sessionId: sessionId || null, accepted: false, agentCancelled: false, jobs: 0, terminals: 0, subagents: 0 }
    if (!sessionId) return report
    const agent = ctx.agents.get(sessionId)
    const caller = agent ? agent.id : sessionId
    if (agent && agent.status === 'running') {
      try {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
        report.agentCancelled = true
        report.accepted = true
      } catch (error) {
        ctx.logger?.warn?.(`${PLUGIN}: agent.cancel failed: ${String(error)}`)
      }
    }
    const jobs = ctx.get('jobs')
    if (jobs) {
      try {
        for (const job of jobs.list(caller)) {
          if (job.status !== 'running' && job.status !== 'stopping') continue
          try {
            jobs.kill(job.id, caller, 'vocabulary review stop')
            report.jobs += 1
            report.accepted = true
          } catch {
            /* foreign or already settled */
          }
        }
      } catch (error) {
        ctx.logger?.warn?.(`${PLUGIN}: jobs.list failed: ${String(error)}`)
      }
    }
    const terminals = ctx.get('terminals')
    if (agent && terminals) {
      try {
        for (const term of terminals.list(agent)) {
          try {
            await terminals.kill(agent, term.id, 'vocabulary review stop')
            report.terminals += 1
            report.accepted = true
          } catch {
            /* already closed */
          }
        }
      } catch (error) {
        ctx.logger?.warn?.(`${PLUGIN}: terminals.list failed: ${String(error)}`)
      }
    }
    const subagents = ctx.get('subagents')
    if (subagents) {
      try {
        const children = await subagents.listDescendants(sessionId)
        for (const child of children || []) {
          if (!child || child.kind !== 'child') continue
          try {
            subagents.interrupt(child.id, agent ? { kind: 'ancestor', agent } : { kind: 'user' })
            report.subagents += 1
            report.accepted = true
          } catch {
            /* not owned / already done */
          }
        }
      } catch (error) {
        ctx.logger?.warn?.(`${PLUGIN}: subagent interrupt failed: ${String(error)}`)
      }
    }
    try {
      const goals = ctx.get('goals')
      if (goals && agent && typeof goals.get === 'function') {
        const goal = goals.get(agent)
        if (goal && goal.phase === 'active' && goal.activation === 'armed' && typeof goals.disarm === 'function') goals.disarm(agent)
      }
    } catch {
      /* the goals service is optional */
    }
    state.interruptAt = Date.now()
    saveLedger()
    return report
  }

  function turnInFlightFor(sessionId) {
    const agent = sessionId ? ctx.agents.get(sessionId) : undefined
    return Boolean(agent && agent.status === 'running')
  }

  // Diagnostics: is the browser half registered in this Host's client module
  // graph? A null clientPath means a page reload cannot load the sidebar entry.
  let clientDiagCache = { at: 0, value: null }
  function clientDiagnostics() {
    if (clientDiagCache.value !== null && Date.now() - clientDiagCache.at < 5_000) return clientDiagCache.value
    let clientPath = null
    try {
      const modules = ctx.get('clientModules')
      if (modules && typeof modules.clientPath === 'function') clientPath = modules.clientPath('dsh-vocab-review') || null
    } catch (error) {
      clientPath = `error: ${String(error)}`
    }
    const value = { clientPath, registered: typeof clientPath === 'string' && !clientPath.startsWith('error:') }
    clientDiagCache = { at: Date.now(), value }
    return value
  }

  // ── Compact state for the sidebar panel and the local API ────────────────
  function qqStatus() {
    const binding = qqBinding()
    const definition = qqTool()
    const rows = sessionCache.rows || []
    const bound = rows.find((row) => row.sessionId === binding.sessionId)
    const owner = binding.ownerOpenId || ''
    return {
      installed: Boolean(binding.available || definition),
      available: Boolean(binding.available && binding.sessionId && binding.target),
      bound: Boolean(binding.available && binding.sessionId),
      tool: Boolean(definition),
      channel: settings.channel,
      mode: qqMode(),
      sessionId: binding.sessionId || '',
      sessionTitle: bound ? bound.title : '',
      owner: owner ? `${owner.slice(0, 4)}…` : '',
      statePath: binding.path,
      lastSendAt: Number.isFinite(state.qqLastSendAt) ? state.qqLastSendAt : null,
      error: state.qqError || binding.error || (definition ? '' : 'send_qq_message 工具不可用：未安装或未启用 QQ 机器人插件'),
    }
  }

  function publicState() {
    ensureDay()
    const now = Date.now()
    const end = endOfToday()
    const all = entries()
    const wrong = all.filter((word) => word.errors > 0)
    const recentErrors = wrong
      .slice()
      .sort((a, b) => (b.lastErrorAt || 0) - (a.lastErrorAt || 0))
      .slice(0, cfg.maxRecentErrors)
      .map((word) => ({
        word: word.word,
        meaning: word.meaning,
        errors: word.errors,
        lastErrorAt: word.lastErrorAt,
      }))
    // The wrong-word book: every word that ever failed or was only half
    // recognised, hardest first. Capped so the 2s panel poll stays small.
    const weakWords = all
      .filter((word) => word.errors > 0 || word.fuzzy > 0)
      .sort((a, b) => (b.errors - a.errors) || (b.fuzzy - a.fuzzy) || ((b.lastErrorAt || 0) - (a.lastErrorAt || 0)))
      .slice(0, 60)
      .map((word) => ({
        word: word.word,
        meaning: word.meaning,
        errors: word.errors,
        fuzzy: word.fuzzy,
        stage: word.stage,
        dueAt: word.dueAt,
      }))
    return {
      loop: state.loop,
      idleReason: state.idleReason,
      nextDueAt: nextDueAt(now),
      queue: state.queue.slice(),
      pendingWord: state.pendingWord,
      activeSessionId: state.activeSessionId,
      selectedSessionId: selectedSessionId(),
      turnInFlight: turnInFlightFor(routedSessionId()),
      qq: qqStatus(),
      client: clientDiagnostics(),
      interruptAt: Number.isFinite(state.interruptAt) ? state.interruptAt : null,
      dueNow: all.filter((word) => word.dueAt <= now).length,
      dueToday: all.filter((word) => word.dueAt <= end).length,
      wrongCount: wrong.length,
      fuzzyCount: all.filter((word) => word.fuzzy > 0).length,
      total: all.length,
      recentErrors,
      weakWords,
      verifyAnswers: cfg.verifyAnswers,
      lastConflict: state.lastConflict || null,
      counters: { ...state.dailyCounters },
      quota: state.quota,
      settings: {
        dailyNewLimit: settings.dailyNewLimit,
        dailyReviewLimit: settings.dailyReviewLimit,
        dailyTotalLimit: settings.dailyTotalLimit,
        dailyMinutesLimit: settings.dailyMinutesLimit,
        reminderMaxPerDay: settings.reminderMaxPerDay,
        channel: settings.channel,
      },
      reminder: {
        version: state.reminderVersion,
        at: state.reminderAt,
        dueCount: state.reminderDueCount,
        remindedToday: settings.lastRemindedDate === todayKey() && settings.remindCount > 0,
        countToday: settings.remindCountDate === todayKey() ? settings.remindCount : 0,
        maxPerDay: settings.reminderMaxPerDay,
      },
      updatedAt: state.updatedAt,
    }
  }

  async function stateWithSessions(extra = {}) {
    const selected = await ensureSelectedSession()
    const sessions = await listSessionOptions()
    return { ...publicState(), selectedSessionId: selected || '', sessions, ...extra }
  }

  // ── Host HTTP route used by the sidebar panel (same-origin) ──────────────
  function trusted(req) {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      const url = new URL(origin)
      if (url.protocol === 'dsh-app:' || url.protocol === 'file:') return true
      return url.host === req.headers.host
    } catch {
      return false
    }
  }

  function writeJson(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  function writeText(res, status, contentType, body, headers = {}) {
    res.writeHead(status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      ...headers,
    })
    res.end(body)
  }

  // ── Wrong-word book actions + CSV export ─────────────────────────────────
  function wordAction(op, raw) {
    const key = normalizeWord(String(raw || ''))
    const word = key ? state.words[key] : null
    if (!word) return { ok: false, code: 'unknown-word' }
    const wasPending = state.pendingWord === word.word
    const now = Date.now()
    if (op === 'remove') {
      delete state.words[word.word]
      state.queue = state.queue.filter((item) => item !== word.word)
    } else if (op === 'master') {
      // Out of the wrong book: marked known, scheduled at the top of the ladder.
      word.errors = 0
      word.fuzzy = 0
      word.lastErrorAt = null
      word.lastFuzzyAt = null
      word.stage = cfg.ladderMinutes.length - 1
      word.dueAt = now + intervalOf(word)
      state.queue = state.queue.filter((item) => item !== word.word)
    } else if (op === 'forget') {
      // Ask it again right now, from the bottom of the ladder.
      word.stage = 0
      word.dueAt = now
    } else {
      return { ok: false, code: 'unknown-op' }
    }
    if (wasPending && op !== 'forget') {
      state.pendingWord = null
      state.pendingCounted = false
    }
    markTick()
    saveLedger()
    // Removing/mastering the word being asked right now would otherwise leave
    // the loop running with no pending question; ask the next one immediately.
    if (wasPending && op !== 'forget' && state.loop === 'running') {
      advanceAfterAnswer(state.activeSessionId || routedSessionId() || '', '')
    }
    return { ok: true, word: word.word, op }
  }

  function csvCell(value) {
    const text = String(value === undefined || value === null ? '' : value)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  function stampText(ms) {
    if (!Number.isFinite(ms)) return ''
    const date = new Date(ms)
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function exportCsv(scope) {
    const rows = [['word', 'meaning', 'errors', 'fuzzy', 'stage', 'correct', 'due_at', 'last_result_at']]
    const list = entries()
      .filter((word) => (scope === 'all' ? true : word.errors > 0 || word.fuzzy > 0))
      .sort((a, b) => (b.errors - a.errors) || (b.fuzzy - a.fuzzy) || a.word.localeCompare(b.word))
    for (const word of list) {
      rows.push([
        word.word,
        word.meaning,
        word.errors,
        word.fuzzy,
        word.stage,
        word.correct,
        stampText(word.dueAt),
        stampText(word.lastResultAt),
      ])
    }
    // BOM so Excel opens the Chinese meanings as UTF-8 instead of mojibake.
    return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 256 * 1024) throw new Error('body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  async function recentSessionId() {
    let items = []
    try {
      const value = await ctx.sessionController.list({}, new AbortController().signal)
      items = value && Array.isArray(value.items) ? value.items : []
    } catch {
      items = []
    }
    const ordinary = items.filter((item) => !item.origin && !item.parentSessionId)
    if (state.activeSessionId && ordinary.some((item) => item.sessionId === state.activeSessionId)) return state.activeSessionId
    if (state.activeSessionId && ctx.agents.get(state.activeSessionId) !== undefined) return state.activeSessionId
    return ordinary.length > 0 ? ordinary[0].sessionId : undefined
  }

  function applySettingsPatch(body) {
    const next = { ...settings }
    if (body && (body.channel === 'auto' || body.channel === 'qq' || body.channel === 'session')) {
      next.channel = body.channel
    }
    for (const key of SETTINGS_KEYS) {
      if (body[key] === undefined) continue
      const n = Number(body[key])
      if (!Number.isFinite(n)) continue
      if (key === 'dailyMinutesLimit') next[key] = clampInt(n, 0, 24 * 60, settings[key])
      else if (key === 'reminderMaxPerDay') next[key] = clampInt(n, 0, 10, settings[key])
      else next[key] = clampInt(n, 0, 10_000, settings[key])
    }
    settings = next
    saveSettings()
    return settings
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        if (!trusted(req)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        const url = new URL(req.url || '/', 'http://dsh.internal')
        const action = url.pathname.startsWith(`${API_PREFIX}/`) ? url.pathname.slice(API_PREFIX.length + 1) : ''
        try {
          if (req.method === 'GET' && (action === 'state' || action === 'state/')) {
            writeJson(res, 200, { ok: true, value: await stateWithSessions() })
            return
          }
          if (req.method === 'POST' && action === 'start') {
            const onQq = qqMode()
            const sessionId = onQq ? qqBinding().sessionId : await ensureSelectedSession()
            if (!sessionId) {
              writeJson(res, 200, { ok: false, error: { code: 'no-session', message: 'Select a conversation in the panel first.' } })
              return
            }
            const result = startLoop(sessionId)
            if (!result.ok) {
              if (result.error === 'quota') {
                writeJson(res, 200, {
                  ok: false,
                  error: { code: 'quota', message: result.quota && result.quota.message ? result.quota.message : '今日已达上限' },
                  value: await stateWithSessions(),
                })
                return
              }
              writeJson(res, 200, {
                ok: false,
                error: { code: result.error, message: 'Upload a worksheet image first so the ledger has words.' },
              })
              return
            }
            if (onQq) {
              // QQ delivery: the plugin pushes the question itself; no agent
              // turn is needed to carry it into the chat.
              const head = state.words[state.queue[0]]
              if (head) qqPushText(questionLine(head))
            } else {
              try {
                await ctx.sessionController.prompt(
                  {
                    requestId: `vocab-review-${randomUUID()}`,
                    sessionId,
                    mode: 'queue',
                    content: [{ type: 'text', text: cfg.startPrompt }],
                  },
                  new AbortController().signal,
                )
              } catch (error) {
                stopLoop()
                throw error
              }
            }
            writeJson(res, 200, { ok: true, value: { ...(await stateWithSessions()), sessionId } })
            return
          }
          if (req.method === 'POST' && action === 'refresh-client') {
            let revision = null
            try {
              const modules = ctx.get('clientModules')
              if (modules && typeof modules.rebuilt === 'function') revision = modules.rebuilt('dsh-vocab-review')
            } catch (error) {
              ctx.logger?.warn?.(`${PLUGIN}: client rebuild failed: ${String(error)}`)
            }
            writeJson(res, 200, { ok: true, value: { ...(await stateWithSessions()), clientRevision: revision } })
            return
          }
          if (req.method === 'POST' && action === 'select') {
            const body = await readJsonBody(req)
            const wanted = body && typeof body.sessionId === 'string' ? body.sessionId : ''
            const rows = await listSessionOptions(true)
            if (!wanted || !rows.some((row) => row.sessionId === wanted)) {
              writeJson(res, 200, { ok: false, error: { code: 'unknown-session', message: 'That conversation is not available.' } })
              return
            }
            rememberSelected(wanted)
            // Picking a conversation explicitly overrides a forced QQ channel;
            // picking the QQ-bound one again re-enters QQ mode automatically.
            if (settings.channel === 'qq') {
              settings.channel = 'auto'
              saveSettings()
            }
            writeJson(res, 200, { ok: true, value: await stateWithSessions() })
            return
          }
          if (req.method === 'POST' && action === 'qq/enable') {
            const binding = qqBinding(true)
            if (!binding.available || !binding.sessionId) {
              writeJson(res, 200, {
                ok: false,
                error: { code: 'qq-unbound', message: 'QQ 机器人尚未绑定会话：先在 QQ 里给机器人发一条消息，或在会话菜单里绑定。' },
                value: await stateWithSessions(),
              })
              return
            }
            const current = selectedSessionId()
            if (current && current !== binding.sessionId) settings.previousSessionId = current
            settings.channel = 'qq'
            rememberSelected(binding.sessionId)
            saveSettings()
            writeJson(res, 200, { ok: true, value: await stateWithSessions() })
            return
          }
          if (req.method === 'POST' && action === 'qq/disable') {
            const binding = qqBinding(true)
            settings.channel = 'auto'
            saveSettings()
            const rows = await listSessionOptions(true)
            const previous = typeof settings.previousSessionId === 'string' ? settings.previousSessionId : ''
            const fallback = rows.find((row) => row.sessionId !== binding.sessionId)
            const wanted = rows.some((row) => row.sessionId === previous) && previous !== binding.sessionId
              ? previous
              : fallback
                ? fallback.sessionId
                : ''
            if (wanted) rememberSelected(wanted)
            writeJson(res, 200, { ok: true, value: await stateWithSessions() })
            return
          }
          if (req.method === 'POST' && action === 'qq/test') {
            const result = await qqSendText('【词汇复习】QQ 通道测试：看到这条说明复习题目可以直接推送到 QQ。')
            state.qqLastSendAt = Date.now()
            state.qqError = result.ok ? '' : result.error
            saveLedger()
            writeJson(res, 200, {
              ok: result.ok,
              error: result.ok ? undefined : { code: 'qq-send-failed', message: result.error },
              value: { ...(await stateWithSessions()), qqTest: { ok: result.ok, error: result.error || '' } },
            })
            return
          }
          if (req.method === 'POST' && action === 'interrupt') {
            const report = await strongPause()
            writeJson(res, 200, { ok: true, value: await stateWithSessions({ interrupt: report }) })
            return
          }
          if (req.method === 'POST' && action === 'stop') {
            stopLoop()
            writeJson(res, 200, { ok: true, value: await stateWithSessions() })
            return
          }
          if (req.method === 'POST' && action === 'settings') {
            const body = await readJsonBody(req)
            applySettingsPatch(body)
            writeJson(res, 200, { ok: true, value: await stateWithSessions() })
            return
          }
          if (req.method === 'POST' && action === 'import') {
            const body = await readJsonBody(req)
            const raw = [body && body.words !== undefined ? body.words : '', body && body.frequency ? body.frequency : '']
              .filter(Boolean)
              .join(',')
            const result = importWords(raw, body && typeof body.sessionId === 'string' ? body.sessionId : undefined)
            writeJson(res, 200, {
              ok: result.ok,
              value: {
                ...(await stateWithSessions()),
                imported: result.words,
                queue: result.queue,
                blocked: Boolean(result.blocked),
                deferred: Boolean(result.deferred),
                quota: result.quota || null,
              },
            })
            return
          }
          if (req.method === 'POST' && (action === 'words/master' || action === 'words/forget' || action === 'words/remove')) {
            const body = await readJsonBody(req)
            const result = wordAction(action.slice('words/'.length), body && body.word)
            if (!result.ok) {
              writeJson(res, 200, { ok: false, error: { code: result.code, message: 'That word is not in the ledger.' } })
              return
            }
            writeJson(res, 200, { ok: true, value: { ...(await stateWithSessions()), wordAction: result } })
            return
          }
          if (req.method === 'GET' && action === 'export.csv') {
            const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'weak'
            writeText(res, 200, 'text/csv; charset=utf-8', exportCsv(scope), {
              'content-disposition': `attachment; filename="vocab-${scope}.csv"`,
            })
            return
          }
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown action ${action || '(empty)'}` } })
        } catch (error) {
          ctx.logger?.warn?.(`${PLUGIN}: API ${action} failed: ${String(error)}`)
          writeJson(res, 500, { ok: false, error: { code: 'internal', message: String(error && error.message ? error.message : error) } })
        }
      },
    }),
    `${PLUGIN}: /api/dsh-vocab-review`,
  )

  ctx.logger?.info?.(`${PLUGIN}: loaded, ledger at ${ledgerPath}, ${entries().length} words, loop=${state.loop}`)
}
