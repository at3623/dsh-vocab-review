# dsh-vocab-review v1.2.0

英语单词复习插件：从单词表图片导入划线单词，在 DSH 里逐词问答，错词进入间隔复习队列。

Vocabulary review for DeepSeek Harness: import underlined words from a worksheet image, quiz one word at a time in chat, and schedule wrong words with spaced repetition.

## 功能 / Features

- **Image ingestion** — the model extracts only underlined base-form English words and calls `vocab_import`; the plugin never stores the image.
- **One-word-per-turn loop** — `Q: {word}` then exactly `✅ {word} = {meaning}` or `❌ {word} = {meaning}`; the plugin records the committed line and wakes the next question automatically.
- **Persistent ledger** — `<DSH_HOME>/vocab-review/ledger.json` (words, queue, loop state, daily counters) + `settings.json` (limits, selected conversation, reminder bookkeeping), atomic temp+rename writes.
- **Spaced repetition** — 30m → 3h → 12h → 2d → 7d → 30d ladder, wrong-word re-asks, frequency weighting.
- **Loop Pause / Resume** — Pause stops issuing questions without a transcript message; Start resumes from the queue head without double counting.
- **Conversation selector** — lists existing non-archived sessions (title only), persists the selection in `settings.json`, and routes every Q/A prompt to that session via `sessionController.prompt`.
- **Strong-pause Stop** — enabled only while a turn is in flight; `agent.cancel({kind:'user'},{keepInbox:true})` + jobs/terminals/subagent cleanup, silent, then the loop can continue.
- **Daily quota** — `dailyNewLimit` / `dailyReviewLimit` / `dailyTotalLimit` / `dailyMinutesLimit`, with the `今日已达上限 (review 12/12)` stop message and automatic day rollover.
- **Due reminder** — timestamp comparison (not tick counting), at most `reminderMaxPerDay` per day (default 1); icon dot + panel banner + optional browser Notification.
- **Sidebar panel** — left-sidebar `vocabulary review` entry, due/wrong/total, today's counters, queue, recent errors, Start/Stop/Pause, and runtime-editable limits.

## 安装 / Install

```powershell
dsh plugin --profile <profile> add github:<github-user>/dsh-vocab-review
```

Or DSH → **Plugins** → **Add plugin** → select this directory.

Requires DSH 0.2.x and Node 22+. No npm dependencies.

## 隐私 / Privacy

No network calls, no telemetry. The image is never stored. Only `ledger.json` and `settings.json` under `<DSH_HOME>/vocab-review/` are written.

## 验证 / Verification

```powershell
npm test
```

Runs the Host harness, the conversation/strong-pause harness, and the Client-half apply simulation.
