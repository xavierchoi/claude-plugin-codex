# cc-plugin-codex

Consult **Claude Code** from inside **Codex** — the gentle reverse of
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).

Where the Codex plugin gives Claude Code an *adversarial* reviewer ("break
confidence in the change"), this gives Codex a **gentle, collaborative** second
agent: hand Claude a task and it runs in the same repo — using your existing
Claude login — and reports back.

## What you get

A Codex plugin that registers a `claude-code` MCP server exposing five tools:

- **`consult`** — hand a task to Claude Code. By default Claude only
  investigates and advises (plan mode, no edits). Options:
  - `edit: true` — let Claude modify files (`acceptEdits`).
  - `background: true` — return a job id immediately; poll with the job tools.
    Recommended for anything beyond a quick task (foreground runs are capped at
    28 minutes).
  - `verify` — a command the server runs after Claude's edits (see below).
  - `resume: true` — continue the last Claude session for that directory.
  - `model` — optional model override.

  Claude runs with the user's **installed Claude Code skills** (e.g.
  `frontend-design`), so you can name a skill in the prompt to have Claude use it.
- **`consult_status` / `consult_result` / `consult_cancel`** — watch, fetch,
  and stop background jobs. Each job has a live, tail-able progress log.
- **`setup`** — the gentle mirror of `/codex:setup`: checks that `claude` is
  installed and signed in (reusing your existing login) and reports any next
  steps. Pass `deep: true` to verify the login with a quick live call.

## Requirements

- **Claude Code** installed and logged in (`claude` on your `PATH`). The plugin
  reuses your existing Claude login — no extra API key needed. On macOS the
  login lives in the Keychain; if `setup` reports the login state as unknown,
  confirm it with `deep: true`.
- **Node.js 18.18+**
- **Codex** with plugin support.
- Linux/macOS. Windows is not fully supported (process-group cancellation and
  bash-based auto-verify are unavailable).

## How it works

```
Codex ──(MCP tools/call: consult)──▶ claude-code MCP server (Node, zero deps)
                                          │
                                          ├─▶ claude -p --output-format stream-json [--resume …]
                                          │       runs in your repo, reuses your login
                                          │       (prompt piped via stdin; plan mode unless edit=true)
                                          ├─▶ optional verify command after the edits
                                          └─▶ parsed result ──▶ back to Codex
```

- The MCP server drives Claude Code's headless mode and folds its event stream
  into one tidy result (final answer, touched files, turns, cost).
- `edit: false` → Claude runs in **plan mode** (read-only, advisory).
  `edit: true` → Claude may edit files (`acceptEdits`).
- Background jobs are **detached workers** with file-backed state: a 45-minute
  watchdog, a concurrency cap (4), stale-job reconciliation, and process-group
  cancellation, so a job can always be cancelled and never leaves an orphaned
  Claude process burning usage. Foreground runs are likewise reaped on
  cancellation (`notifications/cancelled`), on session end, and by a 28-minute
  cap.
- Session ids are remembered per directory, so `resume: true` continues the
  last conversation.
- Each run writes a live progress log under `~/.cache/cc-plugin-codex/logs/`
  (`latest.log` points at the newest run — `tail -f` it to watch Claude work).

### Verification (`verify`)

Headless Claude edits reliably but can't run approval-gated commands (tests,
compilers). The MCP server can — it runs **after** Claude finishes and appends
the exit code and output to the result:

- `verify: "auto"` — the server derives a syntax check from the files Claude
  touched (`.py` → `py_compile`, `.js/.mjs/.cjs` → `node --check`,
  `.sh` → `bash -n`). Recommended for edit tasks.
- `verify: "npm test"` (or any explicit command, `{files}` expands to the
  touched files) — subject to the **verify policy** below.

**Security note / verify policy.** The verify command is typically written by
the model, and the server runs outside Codex's sandbox — an unrestricted
`verify` would hand any prompt injection in the repo an unsandboxed shell. The
default policy **`safe`** therefore allows `"auto"` plus plain invocations of
well-known build/test tools (npm, pytest, cargo, go, make, …) with **no shell
operators**. Configure it in `~/.config/cc-plugin-codex/settings.json`:

```json
{ "verify": "safe" }
```

- `"auto-only"` — only `verify: "auto"` may run.
- `"safe"` (default) — auto + plain allowlisted tool invocations.
- `"all"` — any command (you trust everything that can reach the consult tool).

### Why an MCP server (and not a slash command)

Codex has no file-based custom slash commands, and its skills/shell path is
model-mediated. An MCP tool is a typed, first-class boundary: Codex invokes it
directly, a failing call returns an error to the model rather than killing the
session (`required` defaults to `false`), and it doesn't depend on the model
transcribing a shell command. That makes it the most stable entry point.

## Install (local marketplace)

```bash
codex plugin marketplace add /path/to/cc-plugin-codex
codex plugin add claude-code@cc-plugin-codex
```

Then ask Codex something like *"get a gentle second opinion from Claude on this
change"* and it will call the `consult` tool. You don't need to mention flags —
the bundled skill teaches Codex to infer `edit` / `background` / `verify` from
your intent.

## Layout

```
.claude-plugin/marketplace.json      local marketplace manifest
plugins/claude-code/
├── .codex-plugin/plugin.json        plugin manifest
├── .mcp.json                        registers the MCP server (cwd "." → plugin root)
├── scripts/
│   ├── claude-mcp-server.mjs        MCP server + background-job worker
│   └── lib/
│       ├── claude-runner.mjs        drives `claude -p`, parses stream-json
│       ├── claude-status.mjs        readiness checks for `setup`
│       ├── jobs.mjs                 file-backed job state (+ stale reconcile, pruning)
│       ├── process.mjs              process-group termination helpers
│       ├── progress-log.mjs         live, tail-able progress logs
│       ├── session-store.mjs        last session id per directory
│       └── verify.mjs               server-side verification (+ safety policy)
└── skills/consult-claude/SKILL.md   tells Codex when & how to consult Claude
```

State lives under `~/.cache/cc-plugin-codex/` (`jobs/`, `logs/`,
`sessions.json`) and settings under `~/.config/cc-plugin-codex/settings.json`.

## Status

**v0.8.0** — `consult` (foreground + background jobs), server-side `verify`
with a safety policy, `setup`, per-directory resume, live progress logs,
orphan-free cancellation. A gentle `review` tool may follow, kept just as
collaborative.
