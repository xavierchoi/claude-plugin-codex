# claude-plugin-codex

Consult Claude Code from inside Codex.

**English** | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md)

[![tests](https://github.com/xavierchoi/claude-plugin-codex/actions/workflows/test.yml/badge.svg)](https://github.com/xavierchoi/claude-plugin-codex/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

This plugin is for Codex users who want an easy way to consult Claude Code
from the workflow they already have. Describe a task in plain language and
Claude runs in the same repository — with the Claude login you already have —
and reports back with a careful second pass.

It is a companion to [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc),
which connects the same two tools in the other direction. If you work with
both agents, the two plugins complete the circle.

```text
you   ▸ have claude redesign the landing page and make sure it still builds

codex ▸ claude-code.consult(prompt=…, edit=true, background=true, verify="auto")
        Started background consult job job-a1b2c3.

codex ▸ 🤝 Claude Code made changes in ~/projects/site.
        Redesigned src/app/page.tsx with a bolder hero and …
        Files Claude touched:
        - src/app/page.tsx
        🔍 Verification: `node --check 'src/app/page.tsx'` → ✅ exit 0
        ( 14 turns · 3m41s · ≈$0.42 of plan usage )
```

## What You Get

A `claude-code` MCP server (Node, zero dependencies) with six tools:

- `consult` — hand a task to Claude Code, advisory by default
- `review` — a careful, read-only review of your uncommitted changes or branch
- `consult_status` / `consult_result` / `consult_cancel` — manage background jobs
- `setup` — check that Claude Code is installed and signed in

You don't call these directly. The bundled skill teaches Codex to pick the
right tool and options (`edit`, `background`, `verify`, `resume`) from what
you say.

## Requirements

- **Claude Code**, installed and signed in:

  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  claude   # run once to sign in
  ```

  Consults run through your existing Claude login, so usage draws on your
  Claude plan — there is no separate bill. Results include an estimate such as
  `≈$0.42 of plan usage` for transparency. (Only if you set
  `ANTHROPIC_API_KEY` are calls API-billed, and labeled accordingly.)

- **Node.js 20+**
- **Codex** with plugin support, on Linux or macOS.

## Install

```bash
codex plugin marketplace add xavierchoi/claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

Then ask Codex: *“Is Claude ready?”* — it runs the `setup` tool and reports
anything that needs fixing, with the exact commands to fix it.

## Usage

### Ask for a second opinion

```text
Get a second opinion from Claude on this change.
Ask Claude why this query is slow.
```

By default Claude runs in plan mode: it investigates and advises without
touching files.

### Ask for a review

```text
Have Claude review my changes.
Have Claude review this branch against main — focus on the retry logic.
```

The server collects the git diff itself — your uncommitted changes, or
everything since a base branch — and Claude reviews it read-only: a short
summary, what works well, findings by severity with file:line references,
and an honest verdict.

### Let Claude make changes

```text
Have Claude clean up the data layer and check it still compiles.
```

When you ask for changes, Codex sets `edit: true` and, for code edits,
`verify: "auto"` — after Claude finishes, the server runs a quick syntax
check on the touched files and appends the outcome to the result.

### Longer tasks

```text
Have Claude redesign the dashboard — take its time.
```

Work beyond a quick pass runs as a background job. Codex reports the job id,
waits efficiently (`consult_status` supports long-polling), and presents the
result when it's done. You can ask for the status or cancel at any time, and
every run writes a live log you can follow:

```bash
tail -f ~/.cache/cc-plugin-codex/logs/latest.log
```

> [!NOTE]
> Foreground consults show no progress in the UI and are capped at 28
> minutes. For anything substantial, background is the comfortable path —
> the skill steers Codex there on its own.

### Continue where Claude left off

```text
Have Claude refine that, and also fix the tests.
```

Session ids are remembered per directory, so follow-ups continue the same
Claude conversation.

### Use your Claude Code skills

Claude runs with the skills you have installed in Claude Code:

```text
Have Claude use the frontend-design skill to redesign this page.
```

### Choose model and effort

```text
Have Claude take a quick, cheap look at this.        → effort: low
Ask Claude to think hard about this race condition.  → effort: high
Have opus review this design.                        → model: opus
```

Mention it and Codex passes it through (`--model` accepts aliases like
`sonnet`/`opus`/`fable` or full names; `--effort` is `low`…`max`). When you
don't, the default model is **`fable`** — the newest Claude — falling back
automatically to `opus`, then `sonnet`, when a plan can't serve it. The
result's meta line shows which model actually answered. To change the default, add to
`~/.config/cc-plugin-codex/settings.json`:

```json
{ "model": "opus", "effort": "medium" }
```

Set `"model": "inherit"` to defer to your own Claude configuration instead.

## Verification policy

The `verify` command runs from the MCP server without an approval gate, so
it is policy-gated for safety. The default policy `safe` allows `"auto"` and
plain invocations of well-known build/test tools (npm, pytest, cargo, go,
make, …) with no shell operators. Configure in
`~/.config/cc-plugin-codex/settings.json`:

```json
{ "verify": "safe" }
```

- `"auto-only"` — only `verify: "auto"` may run
- `"safe"` — the default, described above
- `"all"` — any command; use only if you trust everything that can reach the tool

## Updating

```bash
codex plugin marketplace upgrade claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

Then start a fresh Codex session: sessions that were already open keep the
old server process, and upgrading underneath them can close their bridge
(tool calls would fail with "Transport closed").

## How It Works

```
Codex ──(MCP: consult)──▶ claude-code MCP server (Node, zero deps)
                               │
                               ├─▶ claude -p  (headless, in your repo,
                               │              your login, plan mode unless edit)
                               ├─▶ optional verify command after the edits
                               └─▶ parsed result ──▶ back to Codex
```

Background jobs are detached workers with file-backed state: a 45-minute
watchdog, a concurrency cap, stale-job reconciliation, and process-group
cancellation — a cancelled or abandoned consult never leaves a Claude
process running.

## Development

```bash
npm test        # full suite against a fake claude binary — fast, no usage
npm run test:live   # opt-in smoke tests against the real claude
```

## License

[MIT](./LICENSE)
