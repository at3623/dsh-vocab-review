/**
 * dsh-vocab-review — Client half.
 *
 * Minimal by design:
 * - one left-sidebar panel icon (with a due dot) opening a root `main` panel;
 * - a shared 8s state poll used by the icon, the collapsed-sidebar badge and
 *   the panel (no per-component polling);
 * - loop-level Start / Stop buttons (no turn cancellation), quota + reminder
 *   banners, and an editable settings block that saves without a restart;
 * - optional browser Notification on a new Host reminder event.
 */

// Client bundle revision marker: bumping this file makes the Host serve a new
// client-module revision so an already-open page can hot-reload the plugin.
window.__ModuleLoader__.load({
  id: 'dsh-vocab-review',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'vocabReview'
    const API = 'api/dsh-vocab-review'
    const NOTIFIED_KEY = 'dsh-vocab-review:reminder-version'

    const EN = {
      title: 'Vocabulary review',
      dueToday: 'due today',
      wrong: 'wrong',
      total: 'words',
      start: 'Start review',
      resume: 'Resume review',
      continueLoop: 'Continue',
      starting: 'Starting…',
      stop: 'Stop',
      stopping: 'Stopping…',
      pause: 'Pause loop',
      interrupted: 'Stopped the in-flight turn.',
      conversation: 'Conversation',
      selectPlaceholder: 'Select a conversation…',
      running: 'Loop running',
      stopped: 'Loop stopped',
      quotaReached: 'Daily quota reached',
      recentErrors: 'Recent errors',
      noErrors: 'No wrong words yet.',
      empty: 'Upload a worksheet image (underlined words) or an article image (exam high-frequency words) in chat, or paste a word list first.',
      queue: 'Queue',
      today: 'today',
      newLabel: 'new',
      reviewLabel: 'review',
      questions: 'questions',
      minutes: 'min',
      reminderDue: 'due now — open Review to start',
      settings: 'Limits & reminder',
      dailyNewLimit: 'New words / day',
      dailyReviewLimit: 'Review words / day',
      dailyTotalLimit: 'Total questions / day',
      dailyMinutesLimit: 'Minutes / day',
      reminderMaxPerDay: 'Reminders / day',
      unlimited: '0 = unlimited',
      save: 'Save',
      saved: 'Saved',
      saving: 'Saving…',
      hint: 'Review happens in the chat: one word per turn. Stop ends the loop after the current turn; the queue is kept.',
      noSession: 'Open or create a chat session first.',
      restartReview: 'Restart review',
      qqOn: 'QQ channel on',
      qqReady: 'QQ channel available',
      qqUnbound: 'QQ bot has no bound session',
      qqMissing: 'QQ bot plugin not detected',
      qqEnable: 'Review on QQ',
      qqDisable: 'Back to web chat',
      qqTest: 'Test push',
      qqTestSent: 'Test message sent to QQ',
      qqSending: 'Sending…',
      idleDone: 'All due words reviewed',
      nextDue: 'next due',
      autoContinue: 'The loop keeps asking while words are due; it stops only when every due word is done or a daily limit is hit.',
      weakWords: 'Weak words',
      weakHint: 'Words you failed or only half knew, hardest first.',
      noWeak: 'No weak words yet.',
      wrongTimes: 'wrong',
      fuzzyTimes: 'half',
      markMastered: 'Known',
      forgetWord: 'Ask again',
      removeWord: 'Remove',
      exportCsv: 'Export CSV',
      verifyNote: 'Every ✅ is re-checked against the stored meaning; a different meaning counts as wrong.',
      conflictLine: 'Plugin veto',
    }
    const ZH = {
      title: '单词复习',
      dueToday: '今日到期',
      wrong: '错词',
      total: '总词数',
      start: '开始复习',
      resume: '继续复习',
      continueLoop: '继续',
      starting: '正在开始…',
      stop: '停止',
      stopping: '正在停止…',
      pause: '暂停队列',
      interrupted: '已中止当前生成。',
      conversation: '复习对话',
      selectPlaceholder: '选择对话…',
      running: '复习进行中',
      stopped: '复习已停止',
      quotaReached: '今日已达上限',
      recentErrors: '最近错词',
      noErrors: '还没有错词。',
      empty: '请先在对话中上传单词表图片（导入划线词），或上传文章图片（导入考试高频词），也可以直接粘贴词表。',
      queue: '队列',
      today: '今日',
      newLabel: '新词',
      reviewLabel: '复习',
      questions: '题',
      minutes: '分钟',
      reminderDue: '个单词已到期，打开复习即可开始',
      settings: '限额与提醒',
      dailyNewLimit: '每日新词上限',
      dailyReviewLimit: '每日复习上限',
      dailyTotalLimit: '每日总题数上限',
      dailyMinutesLimit: '每日分钟上限',
      reminderMaxPerDay: '每日提醒次数',
      unlimited: '0 = 不限制',
      save: '保存',
      saved: '已保存',
      saving: '保存中…',
      hint: '复习在对话里进行：每轮只问一个单词。停止会在当前轮结束后生效，队列保留。',
      noSession: '请先打开或创建一个对话。',
      restartReview: '重新开始复习',
      qqOn: 'QQ 通道已开启',
      qqReady: 'QQ 通道可用',
      qqUnbound: 'QQ 机器人尚未绑定会话',
      qqMissing: '未检测到 QQ 机器人插件',
      qqEnable: '在 QQ 上复习',
      qqDisable: '回到网页复习',
      qqTest: '测试推送',
      qqTestSent: '已向 QQ 发送测试消息',
      qqSending: '发送中…',
      idleDone: '今天到期的单词都已复习完',
      nextDue: '下一个到期',
      autoContinue: '只要还有到期的单词就会自动继续；全部复习完或达到每日上限时才停。',
      weakWords: '薄弱词',
      weakHint: '答错过或只记得一半的词，按错次排序。',
      noWeak: '还没有薄弱词。',
      wrongTimes: '错',
      fuzzyTimes: '半',
      markMastered: '已掌握',
      forgetWord: '重问',
      removeWord: '删除',
      exportCsv: '导出 CSV',
      verifyNote: '每个 ✅ 都会用已存词义二次校验，词义不符按错处理。',
      conflictLine: '插件改判',
    }

    let clientCtx = null

    function api(path, init) {
      const url = new URL(`${API}/${path}`, document.baseURI).href
      return fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init }).then(async (response) => {
        let payload = null
        try {
          payload = await response.json()
        } catch {
          payload = null
        }
        if (!payload || payload.ok !== true) {
          const message = payload && payload.error && payload.error.message ? payload.error.message : `HTTP ${response.status}`
          const error = new Error(message)
          error.code = payload && payload.error && payload.error.code ? payload.error.code : 'http'
          error.value = payload && payload.value ? payload.value : null
          throw error
        }
        return payload.value
      })
    }

    // ── One shared poll for the icon, the badge and the panel ──────────────
    const store = {
      snapshot: null,
      listeners: new Set(),
      timer: null,
      notified: 0,
    }

    function notifySubscribers() {
      for (const listener of [...store.listeners]) listener()
    }

    function subscribe(listener) {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }

    function maybeNotify(snapshot) {
      if (!snapshot || !snapshot.reminder) return
      const version = Number(snapshot.reminder.version) || 0
      if (version <= store.notified) return
      store.notified = version
      try {
        localStorage.setItem(NOTIFIED_KEY, String(version))
      } catch {
        /* private mode / disabled storage */
      }
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      try {
        const count = snapshot.reminder.dueCount || snapshot.dueNow || 0
        const active = clientCtx && clientCtx.locale ? clientCtx.locale.getLocale().active : 'en'
        new Notification('单词复习 / Vocabulary review', {
          body: String(active).toLowerCase().startsWith('zh') ? `${count} 个单词已到期` : `${count} word(s) due`,
        })
      } catch {
        /* notification construction may be blocked */
      }
    }

    function publish(snapshot) {
      const changed = store.snapshot !== snapshot
      store.snapshot = snapshot
      if (!changed) return
      maybeNotify(snapshot)
      notifySubscribers()
    }

    function refresh() {
      return api('state')
        .then(publish)
        .catch(() => {})
    }

    function useSnapshot() {
      const [snapshot, setSnapshot] = React.useState(store.snapshot)
      React.useEffect(() => {
        setSnapshot(store.snapshot)
        return subscribe(() => setSnapshot(store.snapshot))
      }, [])
      return snapshot
    }

    function requestNotificationPermission() {
      try {
        if (typeof Notification === 'undefined') return
        if (Notification.permission === 'default') Notification.requestPermission().catch(() => {})
      } catch {
        /* ignore */
      }
    }

    function Icon(props) {
      const size = props && props.size ? props.size : 18
      const active = Boolean(props && props.active)
      const snapshot = useSnapshot()
      const due = snapshot ? snapshot.dueNow : 0
      return h(
        'span',
        { style: { position: 'relative', display: 'inline-flex' } },
        h(
          'svg',
          {
            viewBox: '0 0 36 36',
            width: size,
            height: size,
            fill: 'none',
            'aria-hidden': 'true',
            style: { display: 'block', pointerEvents: 'none' },
          },
          h('path', {
            d: 'M7 8.6c4.1-1.5 7.8-1.5 11 0v18.6c-3.2-1.5-6.9-1.5-11 0z',
            stroke: 'currentColor',
            strokeWidth: 2.2,
            strokeLinejoin: 'round',
            fill: active ? 'currentColor' : 'none',
            fillOpacity: active ? 0.14 : 0,
          }),
          h('path', {
            d: 'M18 8.6c3.2-1.5 6.9-1.5 11 0v18.6c-4.1-1.5-7.8-1.5-11 0z',
            stroke: 'currentColor',
            strokeWidth: 2.2,
            strokeLinejoin: 'round',
            fill: active ? 'currentColor' : 'none',
            fillOpacity: active ? 0.14 : 0,
          }),
          h('path', {
            d: 'M22.3 18.5l3.2 3.2 5.1-6.2',
            stroke: 'currentColor',
            strokeWidth: 2.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
        due > 0
          ? h('span', {
              style: {
                position: 'absolute',
                top: -1,
                right: -2,
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--dsw-alias-brand-primary)',
                boxShadow: '0 0 0 1px var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base))',
              },
              'aria-hidden': 'true',
            })
          : null,
      )
    }

    // NOTE: `sidebar.toggle.badge` is a single-occupant slot already owned by
    // the shell. Registering into it from a bundle plugin can reject the whole
    // Client activation, which removes every other slot this plugin owns.
    // The due indicator is rendered as a dot on the panel icon instead.

    const CSS = `
.vr-root { box-sizing: border-box; height: 100%; overflow: auto; padding: calc(28px + var(--dsh-frame-top-clearance, 0px)) 24px 48px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; }
.vr-wrap { max-width: 680px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.vr-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.vr-title { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: 0.01em; }
.vr-badge { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.vr-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.vr-stat { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; }
.vr-num { font-size: 24px; font-weight: 650; line-height: 1.1; font-variant-numeric: tabular-nums; }
.vr-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.vr-counters { font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.vr-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.vr-start { appearance: none; border: 1px solid var(--dsw-alias-brand-primary); background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-weight: 600; border-radius: 8px; padding: 8px 16px; cursor: pointer; }
.vr-start:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.vr-start:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.vr-start:disabled { opacity: 0.55; cursor: default; }
.vr-stop { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-weight: 600; border-radius: 8px; padding: 8px 16px; cursor: pointer; }
.vr-stop:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.vr-stop:disabled { opacity: 0.55; cursor: default; }
.vr-pause { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; padding: 6px 2px; }
.vr-pause:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.vr-pause:disabled { opacity: 0.55; cursor: default; }
.vr-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.vr-quota { color: var(--dsw-alias-state-error-primary); font-size: 13px; font-weight: 600; }
.vr-idle { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.vr-banner { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); padding: 8px 12px; font-size: 13px; display: flex; gap: 8px; align-items: center; }
.vr-banner-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-brand-primary); flex: none; }
.vr-section { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.vr-section-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
.vr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.vr-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 13px; }
.vr-word { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.vr-meaning { color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vr-count { color: var(--dsw-alias-state-error-primary); font-variant-numeric: tabular-nums; flex: none; }
.vr-empty { color: var(--dsw-alias-label-secondary); font-size: 13px; }
.vr-queue { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.vr-weak-tools { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.vr-weak-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; max-height: 260px; overflow: auto; }
.vr-weak-row { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
.vr-weak-word { font-weight: 600; flex: none; }
.vr-weak-meaning { color: var(--dsw-alias-label-secondary); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vr-weak-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; flex: none; font-variant-numeric: tabular-nums; }
.vr-weak-actions { display: flex; gap: 4px; flex: none; }
.vr-mini { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; border-radius: 5px; padding: 1px 6px; cursor: pointer; }
.vr-mini:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.vr-mini:disabled { opacity: 0.5; cursor: default; }
.vr-conflict { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.vr-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.vr-settings { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 14px; }
.vr-settings summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
.vr-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; margin-top: 12px; }
.vr-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.vr-field input { box-sizing: border-box; width: 100%; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 6px 8px; }
.vr-field input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.vr-save-row { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.vr-save { appearance: none; border: 1px solid var(--dsw-alias-brand-primary); background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 13px; font-weight: 600; border-radius: 8px; padding: 6px 14px; cursor: pointer; }
.vr-save:disabled { opacity: 0.55; cursor: default; }
.vr-unlimited { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vr-select-row { display: flex; align-items: center; gap: 10px; }
.vr-select-label { font-size: 12px; color: var(--dsw-alias-label-secondary); flex: none; }
.vr-select { box-sizing: border-box; flex: 1 1 auto; min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 6px 8px; }
.vr-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.vr-qq { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.vr-qq-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-border-l2); flex: none; }
.vr-qq-on .vr-qq-dot { background: var(--dsw-alias-brand-primary); }
.vr-qq-text { flex: 1 1 auto; }
.vr-qq-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.vr-qq-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.vr-qq-btn:disabled { opacity: 0.55; cursor: default; }
.vr-qq-note { font-size: 12px; color: var(--dsw-alias-label-secondary); }
@media (max-width: 520px) { .vr-root { padding: calc(20px + var(--dsh-frame-top-clearance, 0px)) 14px 40px; } .vr-grid { grid-template-columns: 1fr; } }
`

    function useLocaleRevision() {
      const [, setRevision] = React.useState(0)
      React.useEffect(() => {
        if (!clientCtx || !clientCtx.locale) return undefined
        return clientCtx.locale.subscribe(() => setRevision((value) => value + 1))
      }, [])
    }

    function clockText(ms) {
      const date = new Date(ms)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    function Panel() {
      const snapshot = useSnapshot()
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [actionError, setActionError] = React.useState('')
      const [settingsDraft, setSettingsDraft] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [saved, setSaved] = React.useState(false)
      const [qqBusy, setQqBusy] = React.useState(false)
      const [qqNote, setQqNote] = React.useState('')
      const [wordBusy, setWordBusy] = React.useState('')
      useLocaleRevision()
      const t = clientCtx && clientCtx.locale ? clientCtx.locale.bind(NS) : (key) => key

      React.useEffect(() => {
        if (!snapshot || !snapshot.settings || settingsDraft !== null) return
        setSettingsDraft({ ...snapshot.settings })
      }, [snapshot, settingsDraft])

      React.useEffect(() => {
        refresh()
      }, [])

      const start = () => {
        if (busy) return
        requestNotificationPermission()
        setBusy(true)
        setActionError('')
        setSaved(false)
        api('start', { method: 'POST' })
          .then((value) => {
            publish(value)
            // In QQ mode the review belongs to the QQ chat; do not navigate the
            // web UI into the bot's bound session.
            if (value && value.sessionId && (!value.qq || !value.qq.mode) && clientCtx && clientCtx.uiWorkspace) {
              clientCtx.uiWorkspace.openSession(value.sessionId)
            }
          })
          .catch((cause) => {
            const code = cause && cause.code
            if (cause && cause.value) publish(cause.value)
            setActionError(code === 'no-session' ? t('noSession') : code === 'no-words' ? t('empty') : String(cause && cause.message ? cause.message : cause))
          })
          .finally(() => setBusy(false))
      }

      const stop = () => {
        if (busy) return
        setBusy(true)
        setActionError('')
        api('stop', { method: 'POST' })
          .then(publish)
          .catch((cause) => setActionError(String(cause && cause.message ? cause.message : cause)))
          .finally(() => setBusy(false))
      }

      // Strong-pause: silent cancellation of the in-flight turn (req. 8).
      const interrupt = () => {
        if (busy || !snapshot || !snapshot.turnInFlight) return
        setBusy(true)
        setActionError('')
        api('interrupt', { method: 'POST' })
          .then((value) => {
            publish(value)
            setActionError('')
          })
          .catch((cause) => setActionError(String(cause && cause.message ? cause.message : cause)))
          .finally(() => setBusy(false))
      }

      const selectSession = (event) => {
        const sessionId = event.target.value
        if (!sessionId) return
        setBusy(true)
        setActionError('')
        api('select', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
          .then(publish)
          .catch((cause) => setActionError(String(cause && cause.message ? cause.message : cause)))
          .finally(() => setBusy(false))
      }

      const changeLimit = (key) => (event) => {
        const value = event.target.value
        setSettingsDraft((draft) => ({ ...(draft || {}), [key]: value }))
        setSaved(false)
      }

      const saveSettings = () => {
        if (!settingsDraft || saving) return
        setSaving(true)
        setActionError('')
        api('settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(settingsDraft),
        })
          .then((value) => {
            publish(value)
            setSettingsDraft({ ...value.settings })
            setSaved(true)
            setTimeout(() => setSaved(false), 2500)
          })
          .catch((cause) => setActionError(String(cause && cause.message ? cause.message : cause)))
          .finally(() => setSaving(false))
      }

      const qqCall = (path) => {
        if (qqBusy) return
        setQqBusy(true)
        setActionError('')
        setQqNote('')
        api(path, { method: 'POST' })
          .then((value) => {
            publish(value)
            if (path === 'qq/test') {
              const test = value && value.qqTest ? value.qqTest : null
              if (test && test.ok) setQqNote(t('qqTestSent'))
              else if (test && test.error) setActionError(test.error)
            }
          })
          .catch((cause) => setActionError(String(cause && cause.message ? cause.message : cause)))
          .finally(() => setQqBusy(false))
      }

      const toggleQq = () => qqCall(qq && qq.mode ? 'qq/disable' : 'qq/enable')
      const testQq = () => qqCall('qq/test')

      // Wrong-word book actions: master (known), forget (ask again now),
      // remove (out of the ledger). All of them return a fresh snapshot.
      const wordCall = (op, word) => {
        if (wordBusy) return
        setWordBusy(`${op}:${word}`)
        setActionError('')
        api(`words/${op}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ word }),
        })
          .then(publish)
          .catch((cause) => setActionError(String(cause && cause.message ? cause.message : cause)))
          .finally(() => setWordBusy(''))
      }

      const exportWords = () => {
        try {
          const url = new URL(`${API}/export.csv?scope=weak`, document.baseURI).href
          const link = document.createElement('a')
          link.href = url
          link.download = 'vocab-weak.csv'
          document.body.appendChild(link)
          link.click()
          link.remove()
        } catch (cause) {
          setActionError(String(cause && cause.message ? cause.message : cause))
        }
      }

      const due = snapshot ? snapshot.dueToday : 0
      const wrong = snapshot ? snapshot.wrongCount : 0
      const total = snapshot ? snapshot.total : 0
      const loop = snapshot ? snapshot.loop : 'idle'
      const running = loop === 'running'
      const turnInFlight = Boolean(snapshot && snapshot.turnInFlight)
      const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : []
      const selectedSessionId = snapshot && typeof snapshot.selectedSessionId === 'string' ? snapshot.selectedSessionId : ''
      const queue = snapshot && Array.isArray(snapshot.queue) ? snapshot.queue : []
      const weak = snapshot && Array.isArray(snapshot.weakWords) ? snapshot.weakWords : []
      const lastConflict = snapshot ? snapshot.lastConflict : null
      const counters = snapshot && snapshot.counters ? snapshot.counters : { new: 0, review: 0, total: 0, minutes: 0 }
      const quota = snapshot ? snapshot.quota : null
      const idleReason = snapshot ? snapshot.idleReason : null
      const reminder = snapshot ? snapshot.reminder : null
      const qq = snapshot ? snapshot.qq : null
      const showReminder = reminder && reminder.dueCount > 0 && snapshot.dueNow > 0 && !running

      return h(
        'div',
        { className: 'vr-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'vr-wrap' },
          h(
            'div',
            { className: 'vr-head' },
            h('h2', { className: 'vr-title' }, t('title')),
            h('div', { className: 'vr-badge' }, running ? t('running') : loop === 'stopped' ? t('stopped') : ''),
          ),
          h(
            'div',
            { className: 'vr-select-row' },
            h('label', { className: 'vr-select-label', htmlFor: 'vr-conversation' }, t('conversation')),
            h(
              'select',
              {
                id: 'vr-conversation',
                className: 'vr-select',
                value: selectedSessionId,
                onChange: selectSession,
                disabled: busy || sessions.length === 0,
                'aria-label': t('conversation'),
              },
              sessions.length === 0
                ? h('option', { value: '' }, t('selectPlaceholder'))
                : sessions.map((session) =>
                    h('option', { value: session.sessionId, key: session.sessionId }, session.title),
                  ),
            ),
          ),
          qq
            ? h(
                'div',
                { className: `vr-qq${qq.mode ? ' vr-qq-on' : ''}` },
                h('span', { className: 'vr-qq-dot', 'aria-hidden': 'true' }),
                h(
                  'span',
                  { className: 'vr-qq-text' },
                  qq.mode ? t('qqOn') : qq.available ? t('qqReady') : qq.bound ? t('qqUnbound') : t('qqMissing'),
                ),
                qq.available
                  ? h(
                      'button',
                      { className: 'vr-qq-btn', type: 'button', onClick: toggleQq, disabled: qqBusy },
                      qq.mode ? t('qqDisable') : t('qqEnable'),
                    )
                  : null,
                qq.available
                  ? h(
                      'button',
                      { className: 'vr-qq-btn', type: 'button', onClick: testQq, disabled: qqBusy },
                      qqBusy ? t('qqSending') : t('qqTest'),
                    )
                  : null,
              )
            : null,
          qq && qq.mode && qq.error ? h('div', { className: 'vr-error', role: 'alert' }, qq.error) : null,
          qqNote ? h('div', { className: 'vr-qq-note' }, qqNote) : null,
          h(
            'div',
            { className: 'vr-stats', 'aria-live': 'polite' },
            h('div', { className: 'vr-stat' }, h('span', { className: 'vr-num' }, String(due)), h('span', { className: 'vr-label' }, t('dueToday'))),
            h('div', { className: 'vr-stat' }, h('span', { className: 'vr-num' }, String(wrong)), h('span', { className: 'vr-label' }, t('wrong'))),
            h('div', { className: 'vr-stat' }, h('span', { className: 'vr-num' }, String(total)), h('span', { className: 'vr-label' }, t('total'))),
          ),
          h(
            'div',
            { className: 'vr-counters' },
            `${t('today')}: ${t('newLabel')} ${counters.new} · ${t('reviewLabel')} ${counters.review} · ${counters.total} ${t('questions')} · ${Math.round(counters.minutes)} ${t('minutes')}`,
          ),
          quota ? h('div', { className: 'vr-quota', role: 'status' }, quota.message) : null,
          !running && idleReason && idleReason.kind === 'no-due'
            ? h(
                'div',
                { className: 'vr-idle', role: 'status' },
                `${t('idleDone')}${Number.isFinite(idleReason.nextDueAt) ? ` · ${t('nextDue')} ${clockText(idleReason.nextDueAt)}` : ''}`,
              )
            : null,
          showReminder
            ? h(
                'div',
                { className: 'vr-banner', role: 'status' },
                h('span', { className: 'vr-banner-dot', 'aria-hidden': 'true' }),
                h('span', null, `${reminder.dueCount} ${t('reminderDue')}`),
              )
            : null,
          h(
            'div',
            { className: 'vr-actions' },
            h(
              'button',
              {
                className: 'vr-start',
                type: 'button',
                onClick: start,
                disabled: busy || total === 0 || turnInFlight,
              },
              busy && !turnInFlight
                ? t('starting')
                : running
                  ? t('continueLoop')
                  : queue.length > 0
                    ? t('resume')
                    : t('start'),
            ),
            h(
              'button',
              {
                className: 'vr-stop',
                type: 'button',
                onClick: interrupt,
                disabled: busy || !turnInFlight,
                title: turnInFlight ? t('stop') : t('hint'),
              },
              busy && turnInFlight ? t('stopping') : t('stop'),
            ),
            running && !turnInFlight
              ? h('button', { className: 'vr-pause', type: 'button', onClick: stop, disabled: busy }, t('pause'))
              : null,
          ),
          error || actionError ? h('div', { className: 'vr-error', role: 'alert' }, error || actionError) : null,
          !running ? h('div', { className: 'vr-hint' }, t('autoContinue')) : null,
          total === 0
            ? h('div', { className: 'vr-section' }, h('div', { className: 'vr-empty' }, t('empty')))
            : h(
                'div',
                { className: 'vr-section' },
                h(
                  'div',
                  { className: 'vr-weak-tools' },
                  h('div', { className: 'vr-section-title' }, `${t('weakWords')} · ${weak.length}`),
                  h(
                    'button',
                    { className: 'vr-mini', type: 'button', onClick: exportWords, disabled: weak.length === 0 },
                    t('exportCsv'),
                  ),
                ),
                h('div', { className: 'vr-idle' }, t('weakHint')),
                weak.length === 0
                  ? h('div', { className: 'vr-empty' }, t('noWeak'))
                  : h(
                      'ul',
                      { className: 'vr-weak-list' },
                      weak.map((item) =>
                        h(
                          'li',
                          { className: 'vr-weak-row', key: item.word },
                          h('span', { className: 'vr-weak-word' }, item.word),
                          h('span', { className: 'vr-weak-meaning' }, item.meaning || '—'),
                          h(
                            'span',
                            { className: 'vr-weak-meta' },
                            `${item.errors > 0 ? `${item.errors} ${t('wrongTimes')}` : ''}${item.errors > 0 && item.fuzzy > 0 ? ' · ' : ''}${item.fuzzy > 0 ? `${item.fuzzy} ${t('fuzzyTimes')}` : ''}`,
                          ),
                          h(
                            'span',
                            { className: 'vr-weak-actions' },
                            h(
                              'button',
                              { className: 'vr-mini', type: 'button', onClick: () => wordCall('master', item.word), disabled: Boolean(wordBusy) },
                              t('markMastered'),
                            ),
                            h(
                              'button',
                              { className: 'vr-mini', type: 'button', onClick: () => wordCall('forget', item.word), disabled: Boolean(wordBusy) },
                              t('forgetWord'),
                            ),
                            h(
                              'button',
                              { className: 'vr-mini', type: 'button', onClick: () => wordCall('remove', item.word), disabled: Boolean(wordBusy) },
                              t('removeWord'),
                            ),
                          ),
                        ),
                      ),
                    ),
                queue.length > 0 ? h('div', { className: 'vr-queue' }, `${t('queue')}: ${queue.join(', ')}`) : null,
                lastConflict
                  ? h(
                      'div',
                      { className: 'vr-conflict' },
                      `${t('conflictLine')}: ${lastConflict.word} · ${lastConflict.answer || '—'} → ${lastConflict.expected || '—'}`,
                    )
                  : null,
                h('div', { className: 'vr-hint' }, t('verifyNote')),
              ),
          h(
            'details',
            { className: 'vr-settings' },
            h('summary', null, t('settings')),
            h(
              'div',
              { className: 'vr-grid' },
              ...[
                ['dailyNewLimit', t('dailyNewLimit')],
                ['dailyReviewLimit', t('dailyReviewLimit')],
                ['dailyTotalLimit', t('dailyTotalLimit')],
                ['dailyMinutesLimit', t('dailyMinutesLimit')],
                ['reminderMaxPerDay', t('reminderMaxPerDay')],
              ].map(([key, label]) =>
                h(
                  'label',
                  { className: 'vr-field', key },
                  h('span', null, label),
                  h('input', {
                    type: 'number',
                    min: 0,
                    step: 1,
                    inputMode: 'numeric',
                    value: settingsDraft && settingsDraft[key] !== undefined ? settingsDraft[key] : '',
                    onChange: changeLimit(key),
                    disabled: saving,
                  }),
                ),
              ),
            ),
            h('div', { className: 'vr-unlimited' }, t('unlimited')),
            h(
              'div',
              { className: 'vr-save-row' },
              h('button', { className: 'vr-save', type: 'button', onClick: saveSettings, disabled: saving }, saving ? t('saving') : saved ? t('saved') : t('save')),
            ),
          ),
          h('div', { className: 'vr-hint' }, t('hint')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        clientCtx = ctx
        ctx.effect(() => {
          let disposeEn = () => {}
          let disposeZh = () => {}
          try {
            disposeEn = ctx.locale.register(NS, 'en', EN)
            disposeZh = ctx.locale.register(NS, 'zh', ZH)
          } catch (error) {
            // A client hot-reload can leave the namespace registered; missing
            // dictionaries must not abort the slot registration below.
            console.error('vocab-review: dictionary registration failed', error)
          }
          return () => {
            try {
              disposeZh()
              disposeEn()
            } catch {
              /* already disposed */
            }
          }
        }, 'vocab-review: dictionaries')

        ctx.effect(() => {
          try {
            const saved = Number(localStorage.getItem(NOTIFIED_KEY) || '0')
            if (Number.isFinite(saved)) store.notified = saved
          } catch {
            /* ignore */
          }
          refresh()
          store.timer = setInterval(refresh, 2000)
          return () => {
            if (store.timer !== null) clearInterval(store.timer)
            store.timer = null
          }
        }, 'vocab-review: state poll')

        const panelLabel = () => {
          const translate = clientCtx && clientCtx.locale ? clientCtx.locale.bind(NS) : (key) => key
          return translate('title')
        }
        // One failing slot must never abort the other registrations (a
        // single-occupant slot rejection used to blank the whole entry).
        const registerSlot = (slot, options, component) => {
          const attempt = () => {
            try {
              return ctx.slots.register(options, component)
            } catch (error) {
              console.error(`vocab-review: ${slot} registration failed`, error)
              return () => {}
            }
          }
          try {
            ctx.slots.inject(slot, attempt)
          } catch (error) {
            console.error(`vocab-review: ${slot} inject failed`, error)
          }
        }
        registerSlot('sidebar.panellist', { name: 'sidebar.panellist', id: 'vocab-review', order: 20, label: panelLabel }, Icon)
        registerSlot('main', { name: 'main', key: 'vocab-review' }, Panel)
      },
    }
  },
})
