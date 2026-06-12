# claude-plugin-codex

**Consult Claude Code from inside Codex** — the gentle reverse of
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).
The same bridge, walked the other way — gently.

[![tests](https://github.com/xavierchoi/claude-plugin-codex/actions/workflows/test.yml/badge.svg)](https://github.com/xavierchoi/claude-plugin-codex/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

`codex-plugin-cc` gives Claude Code an *adversarial* Codex reviewer — its job
is to "break confidence in the change". This plugin completes the circle:
it gives **Codex** a **collaborative second agent**. Hand Claude a task in
plain language and it runs in the same repo — using your existing Claude
login — and reports back like a thoughtful colleague, not a prosecutor.

```text
you   ▸ have claude redesign the landing page and make sure it still builds

codex ▸ claude-code.consult(prompt=…, edit=true, background=true, verify="auto")
        Started background consult job job-a1b2c3 — watching it for you.

codex ▸ 🤝 Claude Code made changes in ~/projects/site (session 9f2c…).
        Redesigned src/app/page.tsx with a bolder hero and …
        Files Claude touched:
        - src/app/page.tsx
        🔍 Verification: `node --check 'src/app/page.tsx'` → ✅ exit 0
        ( 14 turns · 3m41s · ≈$0.42 of plan usage )
```

You never type flags — the bundled skill teaches Codex to infer
`edit` / `background` / `verify` / `resume` from what you say.

## Install

```bash
codex plugin marketplace add xavierchoi/claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

Then ask Codex: *"is Claude ready?"* — it will run the `setup` tool and tell
you if anything needs fixing (and how).

### Requirements

- **Claude Code** installed and logged in:
  `curl -fsSL https://claude.ai/install.sh | bash`, then run `claude` once to
  sign in. On macOS the login lives in the Keychain; if `setup` reports the
  state as unknown, confirm with `deep: true`.
- **Node.js 20+**, **Codex** with plugin support, Linux/macOS.
  (Windows is not fully supported: process-group cancellation and bash-based
  auto-verify are unavailable.)

### Does this cost money?

No separate bill. Claude runs through **your existing Claude login**, so
consults draw on your Claude plan's usage — results show an estimate like
`≈$0.42 of plan usage` for transparency. Only if you explicitly set
`ANTHROPIC_API_KEY` are calls API-billed (and labeled accordingly).

## What you get

One MCP server (`claude-code`, Node, zero dependencies) with five tools:

| Tool | What it does |
|---|---|
| `consult` | Hand Claude a task. Advisory (plan mode) by default; `edit: true` to let it change files; `background: true` for long work; `resume: true` to continue the last session in that directory; `verify` to check the result. |
| `consult_status` | Watch a background job — supports `wait_seconds` long-polling, so Codex waits efficiently instead of burning turns. |
| `consult_result` | Fetch the finished result (answer, touched files, verification, duration, usage). |
| `consult_cancel` | Stop a job — kills the whole process tree, never leaves an orphaned Claude burning usage. |
| `setup` | Check install + login and prescribe exact next steps. `deep: true` verifies with a tiny live call. |

Claude runs with **your installed Claude Code skills** — say
*"have Claude use the frontend-design skill on this page"* and it will.

## Things to try

- *"Get a second opinion from Claude on this change."* → advisory consult
- *"Have Claude clean up the data layer and check it still compiles."* → `edit` + `verify:"auto"`
- *"Ask Claude to redesign the dashboard — take its time."* → background job
- *"Have Claude continue where it left off and also fix the tests."* → `resume`

Every run writes a live progress log (`~/.cache/cc-plugin-codex/logs/latest.log`)
— `tail -f` it to watch Claude think in real time.

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

- `edit: false` → Claude runs in **plan mode** (read-only, advisory).
  `edit: true` → Claude may edit files (`acceptEdits`).
- Background jobs are **detached workers** with file-backed state: a 45-minute
  watchdog, a concurrency cap (4), stale-job reconciliation, and process-group
  cancellation. Foreground runs are likewise reaped on cancellation, on
  session end, and by a 28-minute cap — nothing ever outlives its request.
- Session ids are remembered per directory, so follow-ups continue the same
  Claude conversation.

### Verification (`verify`)

Headless Claude edits reliably but can't run approval-gated commands (tests,
compilers). The MCP server can — it runs **after** Claude finishes and appends
the exit code and output to the result:

- `verify: "auto"` — derives a syntax check from the files Claude touched
  (`.py` → `py_compile`, `.js/.mjs/.cjs` → `node --check`, `.sh` → `bash -n`).
- `verify: "npm test"` (or any explicit command; `{files}` expands to the
  touched files) — subject to the policy below.

**Security note.** The verify command is typically written by the model, and
the server runs outside Codex's sandbox — an unrestricted `verify` would hand
any prompt injection in the repo an unsandboxed shell. The default policy
**`safe`** allows `"auto"` plus plain invocations of well-known build/test
tools (npm, pytest, cargo, go, make, …) with **no shell operators**. Configure
in `~/.config/cc-plugin-codex/settings.json`:

```json
{ "verify": "auto-only" }   // strictest: only verify:"auto"
{ "verify": "safe" }        // default
{ "verify": "all" }         // any command — only if you trust the whole chain
```

### Why an MCP server (and not a slash command)

Codex has no file-based custom slash commands, and its skills/shell path is
model-mediated. An MCP tool is a typed, first-class boundary: Codex invokes it
directly, a failing call returns an error to the model rather than killing the
session, and it doesn't depend on the model transcribing a shell command.

## Updating

Git-installed marketplaces can be upgraded in place:

```bash
codex plugin marketplace upgrade claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

## Layout

```
.claude-plugin/marketplace.json      marketplace manifest
plugins/claude-code/
├── .codex-plugin/plugin.json        plugin manifest
├── .mcp.json                        registers the MCP server
├── scripts/
│   ├── claude-mcp-server.mjs        MCP server + background-job worker
│   └── lib/                         runner, jobs, verify, status, logs, …
└── skills/consult-claude/SKILL.md   teaches Codex when & how to consult Claude
tests/                               npm test — full E2E against a fake claude
                                     (zero cost); npm run test:live for real-
                                     claude smoke tests (opt-in)
```

State lives under `~/.cache/cc-plugin-codex/` and settings under
`~/.config/cc-plugin-codex/settings.json`.

## Status

**v0.9.0** — consult (foreground + background), long-poll status, server-side
verify with a safety policy, per-directory resume, live progress logs,
orphan-free cancellation, actionable error prescriptions. Next up: a gentle
`review` tool — same care, pointed at your diff.

## License

[MIT](./LICENSE)
