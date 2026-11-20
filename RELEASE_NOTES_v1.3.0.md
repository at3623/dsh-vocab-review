# dsh-vocab-review v1.3.0 — QQ channel

Combine the vocabulary review with **@hualiong/dsh-qq-bot** so the same ledger
and spaced-repetition schedule can be reviewed from QQ.

## Added

- **QQ channel.** When the QQ bot has bound a session, the panel's new QQ row
  switches review to that chat: the plugin pushes each `Q: {word}` itself
  through the bot's `send_qq_message` tool, and grades the answers typed in QQ
  from the bound session's event stream.
- **Channel modes** in `settings.json`: `auto` (default — the QQ-bound
  conversation is selected ⇒ deliver on QQ), `qq` (forced by the panel button),
  `session` (never).
- **Reminder push.** A due reminder is also pushed to the bound QQ chat, still
  capped by `reminderMaxPerDay`.
- **Diagnostics.** `qq` state (installed / bound / available / mode / last send
  / error) is part of the panel snapshot; delivery failures persist as
  `qqError` in `ledger.json`.
- `qqStatePath` plugin config to override the bot state file location.

## Behavior notes

- The next question is pushed only after the graded answer's turn ends, with a
  1.5 s head start, so the bot's evaluation line is never overtaken.
- The QQ bot's inbound path is text-only; worksheet images are still imported in
  the Web chat (or as a pasted word list on QQ). Both share the same ledger.
- The plugin never reads the bot's AppID/AppSecret and never opens its own QQ
  connection; it only reads the bot's `state.json` and calls its send tool.

## Verification

Offline harnesses (`npm test`) still pass 10/10 + 6/6; the new QQ paths are
covered by manual end-to-end checks against a live `dsh-qq-bot` binding.
