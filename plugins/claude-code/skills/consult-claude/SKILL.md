---
name: consult-claude
description: Hand a task to Claude Code for a gentle, thorough second pass. Use when you'd like a collaborative second agent to investigate, review, or implement something in the current repo — for example "ask Claude to look at this", "get a second opinion from Claude", or "have Claude take a pass at this". Claude runs in the same repository via the `claude-code` MCP server's `consult` tool.
metadata:
  short-description: Consult Claude Code as a gentle collaborator
---

# Consult Claude Code

This plugin lets you hand work to Claude Code as a collaborative second agent.
Claude runs locally in the same repository (reusing the user's existing Claude
login) and reports back.

Keep the spirit gentle and collaborative: Claude is a peer offering a careful
second perspective, not a last resort or an adversary.

## First-time setup

If consulting fails, or the user asks whether the plugin is ready, call the
`setup` tool first. It checks that `claude` is installed and signed in and
returns any next steps (it reuses the user's existing Claude login — no extra
API key needed). Pass `deep: true` to verify the login with a quick live call.

## How to call it

Use the `consult` tool from the `claude-code` MCP server. Arguments:

- `prompt` — what you'd like Claude to look at, investigate, or do. Be specific
  about the goal and what "done" looks like.
- `cwd` — **always pass the absolute path of the repository you are working in.**
  The tool cannot infer it.
- `edit` — `true` lets Claude modify files; `false` (default) is advisory only.
- `background` — `true` returns a job id immediately and runs in the background;
  poll with `consult_status`, fetch with `consult_result`, stop with `consult_cancel`.
- `verify` — a command the server runs after the edits (e.g. `"auto"` or
  `"npm test"`); see below.
- `resume` — continue the most recent Claude session for this directory.
- `model` — optional model override.

## Choosing the parameters — infer them, don't ask

**The user should not have to mention these flags.** Translate their plain
request into the right call yourself:

- **edit** → `true` when they want Claude to *change / fix / improve / redesign /
  implement / clean up* something. `false` only for a *review, opinion,
  explanation, or investigation*.
- **background** → `true` for anything beyond a quick change — redesigns,
  multi-file work, "improve the whole X", or anything likely to take more than a
  minute. Tell the user you've started it with the job id, then check
  `consult_status` and report the `consult_result` when it finishes. Use the
  foreground (omit `background`) only for quick read-only questions.
- **verify** → for any **edit** task, pass `verify: "auto"` — the server runs a
  syntax check on whatever files Claude touched (you don't need to know the
  command). Use an explicit command only when the user names a check ("make sure
  the tests pass" → `"npm test"`). Explicit commands are subject to a safety
  policy: plain invocations of common build/test tools, no shell operators
  (`&&`, `|`, redirects…). If a command is blocked, fall back to `"auto"` and
  tell the user the exact command to run themselves (the policy lives in
  `~/.config/cc-plugin-codex/settings.json`, `"verify": "auto-only" | "safe" | "all"`).

So *"have Claude make this dashboard cleaner and check it still works"* becomes a
single call — `consult(cwd, prompt="Use the frontend-design skill to …",
edit=true, background=true, verify="auto")` — and the user just described the goal.

## Using Claude's installed skills

Claude Code runs with the user's own installed skills and plugins, so you can
ask it to use a specific one. Name the skill in the `prompt`, and pair it with
`edit: true` when the skill produces code.

- Frontend / UI work → the `frontend-design` skill. Example prompt:
  *"Use the frontend-design skill to redesign the landing page in
  src/app/page.tsx — production-grade and distinctive; keep the existing
  routing and data."*
- Want several distinct design directions before committing → ask for the
  `vs-design-diverge` skill.
- Deep multi-source research → ask for the `deep-research` skill.

If you're unsure which skills are installed, first consult read-only
(`edit: false`) and ask Claude to list the relevant skills it can use.

## When to reach for it

- You want a thorough, independent second opinion on a change or design.
- A task plays to Claude's strengths: broad multi-file investigation,
  large-context reading, or careful implementation.
- The user explicitly asks to involve Claude.

## When not to

- Small, clearly bounded edits you can finish yourself.
- Anything the user wants kept inside Codex.

## Presenting Claude's results

- Pass Claude's findings back faithfully; keep its structure and file references.
- Default to advisory: do not start editing on Claude's behalf unless the user
  asked for changes.
- If Claude only advised (`edit` was false), share the advice and let the user
  decide the next step.
