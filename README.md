# dsh-vocab-review

Underlined-word vocabulary review for DeepSeek Harness.

## Install

Requires DeepSeek Harness 0.2.x, Node 22+, and no extra npm dependencies.

**From GitHub** (once this repository is pushed):

```powershell
dsh plugin --profile <profile> add github:at3623/dsh-vocab-review
```

**Local directory**: DSH → **Plugins** → **Add plugin** → select this directory, or call the Plugin Manager's `install_bundle` with the absolute path.

The bundle patch inserts the `vocab-review` row; the Client half is discovered from `dsh.client` and `./client`. After a client-side update, refresh the GUI page once (or restart DSH).

## Security & privacy

- **No network calls, no telemetry, no credentials.** The plugin runs entirely on the local Host.
- The worksheet image is **never read or stored by the plugin**; the chat model extracts the underlined words and calls `vocab_import` with plain text.
- The plugin writes only two files under `<DSH_HOME>/vocab-review/`: `ledger.json` (words/queue/counters) and `settings.json` (limits, selected conversation, reminder bookkeeping).
- The strong-pause Stop only touches the **selected** session: its Agent, its background jobs/terminals, and its child subagents — never other sessions.

## What it does

1. **Image ingestion** — the user uploads a worksheet image. The model reads it, extracts every **underlined English word** in base form, and calls `vocab_import` with a comma-separated list. The plugin normalizes the list, deduplicates it, and stores only the words; the image is never read or kept by the plugin.
2. **Q&A loop driven by the plugin** — each turn injects a compact queue:

   ```text
   QUEUE: abandon, benefit, cautious
   DUE: 3 due now · 1 wrong · 52 words
   ```

   The model asks exactly one word (`Q: {word}`). After the answer it emits exactly one line, `✅ {word} = {meaning}` or `❌ {word} = {meaning}`. The plugin watches the committed session event, records the result, and wakes the same chat with `继续复习` for the next word. The model never computes due words, quota, or scheduling.
3. **Wrong-word ledger** — every error increments `errors` and stamps `lastErrorAt` in `<DSH_HOME>/vocab-review/ledger.json`. A correct answer advances the spaced-repetition stage and schedules the next review; the error history stays.
4. **Spaced repetition** — fixed ladder `30m → 3h → 12h → 2d → 7d → 30d` (simplified SM-2 / fixed ladder). A wrong answer resets the word to stage 0 and re-queues it after `retryDelayMinutes`. The queue builder pulls due reviews first, then due new words, injects a configurable number of previously-wrong words at random, then fills the rest with higher-frequency words (high-frequency weighted up, low-frequency down and scheduled with a longer multiplier).
5. **Persistence** — `ledger.json` (words, queue, loop state, daily counters) and `settings.json` (limits + reminder bookkeeping) are written atomically (temp file + rename). Page reloads never touch Host state; a Host restart reloads the queue and keeps the loop **stopped** until Start is pressed.

## Loop-level Stop / Start (req. 9)

- The panel **Stop** button sets the loop from `running` to `stopped`. The plugin simply does **not issue the next question**. It never calls `agent.cancel` and never injects a "stopped" message, so the transcript stays clean. If a model reply is in flight, it finishes and is recorded; then the loop stops.
- Answered words are already persisted and the queue is kept. **Start** resumes from the queue head without recounting the question that was already counted.
- Loop states: `idle` (nothing queued / session done), `running`, `stopped`.

## Daily quota (req. 11)

`settings.json` / the panel's **Limits & reminder** section control:

| Key | Default | Meaning |
| --- | --- | --- |
| `dailyNewLimit` | `20` | New words asked per day (0 = unlimited). |
| `dailyReviewLimit` | `50` | Previously-answered words asked per day (0 = unlimited). |
| `dailyTotalLimit` | `0` | Total questions per day (0 = unlimited). |
| `dailyMinutesLimit` | `0` | Active review minutes per day (0 = unlimited). |

`dailyCounters: { date, new, review, total, minutes }` lives in `ledger.json`. Every quota check calls `ensureDay()`: a new local date resets all four counters to zero. Before each question the plugin picks the first eligible word (due reviews before new words); when no word is eligible it sets `stopped` and shows `今日已达上限 (<kind> <used>/<limit>)`. Unprocessed words stay in the queue / defer naturally through `dueAt`.

## Due reminder (req. 10)

- Every word already carries a `dueAt` timestamp. A Host `ctx.timer` tick (60 s) compares `now >= min(dueAt)` — a timestamp comparison, not a tick count, so background throttling cannot skew it.
- `settings.json` stores `lastRemindedDate`, `remindCountDate`, `remindCount`, `lastRemindAt`, plus `reminderMaxPerDay` (default 1). At most that many reminders per day; a 3-hour minimum gap applies when the cap is above 1.
- Trigger delivery: a badge dot on the sidebar icon (plus the panel banner) and an optional browser `Notification` (only when permission is already granted). The collapsed-sidebar `sidebar.toggle.badge` slot is a single-occupant shell slot, so it is deliberately not registered — a rejected registration there used to blank the whole client entry.
- No words / nothing due ⇒ no reminder.

DSH reuse note: the shipped `schedule` service delivers **prompts into a Session**, which would create transcript rows; it is not used. The reusable parts are the Host `ctx.timer`, the `sidebar.toggle.badge` / `sidebar.panellist` slots, and the browser Notification API.

## Sidebar

The plugin registers a left-sidebar icon (`sidebar.panellist`, id `vocab-review`) and a root-scoped `main` panel keyed `vocab-review`:

- today's due count, wrong count, total words;
- today's counters (new / review / questions / minutes);
- the quota stop message `今日已达上限 (…)`;
- a due-reminder banner;
- Start / Resume / Stop;
- the recent error words with meanings and counts;
- the current queue;
- editable limits + reminder cap with **Save** — applied in memory and written to `settings.json` immediately, no restart.

## Tools

| Tool | Purpose |
| --- | --- |
| `vocab_import` | Import underlined words (or a typed list), start a session, respect quota. |
| `vocab_start` | Start/Resume from the saved queue (does not rebuild a kept queue). |
| `vocab_stop` | Stop the loop; keeps ledger + queue, no transcript message. |
| `vocab_stats` | Compact due/wrong/queue/loop/counter summary. |

## Conversation selector (req. 7)

The panel has a dropdown listing the user's existing DSH conversations (title only). The Host builds it from `sessionController.list()` and reads each row's `projections.values.title`, filters `origin: 'subagent'` / `parentSessionId` rows, and drops every id in `workspaceRegistry.archivedSessionIds`. Selecting a conversation:

- writes `selectedSessionId` to `settings.json` (survives page reload and Host restart);
- routes every vocabulary prompt (`开始词汇复习`, `继续复习`) through `sessionController.prompt({ sessionId })` to that conversation — never to the main conversation;
- limits the QUEUE/protocol prompt injection and the answer-line parser to that session's Agent.

If the selected conversation is archived or deleted, the panel falls back to the first live conversation. Importing words from a different conversation stores the queue and waits for Start in the selected one (the import result says so).

## Stop (strong pause, req. 8)

The Stop button sits next to Start/Resume and is enabled only while `turnInFlight` is true (the selected session's Agent has `status === 'running'`, polled every 2 s). It calls the same strong-pause sequence as `dsh-interrupt-button`:

1. `agent.cancel({ kind: 'user' }, { keepInbox: true })`
2. `jobs.list(agent.id)` → `jobs.kill(id, caller, reason)` for running jobs
3. `terminals.list(agent)` → `terminals.kill(agent, id, reason)`
4. `subagents.listDescendants(sessionId)` → `subagents.interrupt(childId, { kind: 'ancestor', agent })`
5. optional `goals.disarm(agent)` when an armed goal exists

It is silent: no prompt, no `steer`, no fake transcript message. Afterwards the Host returns `turnInFlight: false` and the loop stays `running` with its queue intact, so Continue/Start can issue the next question. The old loop-level pause remains as the small **Pause loop** action.

## Verification

- `npm test` — runs the three offline harnesses below.
- `node test/harness.mjs` — Host harness: 3-word import, ✅/❌ ledger updates, compact injection, loop Pause (no prompt, queue kept), Start resume without double-counting, `dailyTotalLimit=5`, live settings edits, once-per-day reminder, date rollover, reload persistence.
- `node test/sessions-stop.mjs` — conversation list (titles, archived/subagent excluded), selection persisted in `settings.json` + reload, Start routed to the selected session, strong-pause Stop (cancel + jobs/terminals/subagents, silent, `turnInFlight` false), idle Stop no-op, archived-selection fallback.
- `node test/client-load-check.mjs` — evaluates the Client bundle with a mocked module loader and asserts the sidebar/main registrations.
- `test/make_test_image.py` — regenerates the 3-underlined-word fixture (`pip install pillow`).
- `node test/restart-check.mjs` (not in CI) — loads the profile-installed package with the real ledger/settings; requires a local DSH profile.

## Limits

- Word extraction relies on the chat model's image reading; the plugin does not run OCR.
- Review runs inside a chat session; with no session, Start asks you to open one.
- The continuation prompt (`继续复习`) is a visible user-role message by design — it is the wake-up for the next question.
- Browser notifications require the user to grant permission; the sidebar badge and panel banner always work without it.
