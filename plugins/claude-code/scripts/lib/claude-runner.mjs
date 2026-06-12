import { spawn } from "node:child_process";

import { progressLineForEvent } from "./progress-log.mjs";
import { terminateProcessTree, killProcessTreeHard } from "./process.mjs";

// Tools whose use means Claude touched a file on disk.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Injected as a system-prompt addendum so Claude knows it runs non-interactively
// and should not burn turns retrying approval-gated commands (ssh, compile,
// tests, …). It edits what it can and reports the command the caller should run.
const HEADLESS_GUARDRAIL =
  "You are running non-interactively (headless) via an automated bridge, so shell/tool commands that need interactive approval cannot be approved here — they hang or get denied. Never retry a command that was blocked or left pending approval; retrying only wastes turns. Make the file edits you can, and if a verification or shell step is blocked, state the exact command the caller should run and continue. Do not loop on a blocked action.";

// How long SIGTERM gets before the group is SIGKILLed.
const KILL_ESCALATION_MS = 5000;

/**
 * Build the argv for a headless `claude -p` run. The prompt itself is piped
 * via stdin (not argv) so it is never visible in `ps` output and never hits
 * the argv length limit.
 *
 * Gentle by default: without `edit`, Claude runs in plan mode (read-only,
 * advisory). With `edit`, it may accept its own file edits.
 */
export function buildClaudeArgs({ edit, resumeId, model, effort, fallbackModel }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  args.push("--permission-mode", edit ? "acceptEdits" : "plan");
  args.push("--append-system-prompt", HEADLESS_GUARDRAIL);
  if (resumeId) {
    args.push("--resume", resumeId);
  }
  if (model) {
    args.push("--model", model);
  }
  if (fallbackModel) {
    // claude -p falls back automatically when the model is overloaded or not
    // available (e.g. a plan without access to the newest model).
    args.push("--fallback-model", fallbackModel);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  return args;
}

/**
 * Run Claude Code headlessly and capture its result by parsing the
 * newline-delimited stream-json events. Never rejects; resolves a result
 * object describing what happened.
 *
 * Options beyond the prompt parameters:
 * - `onChild(child)` — called with the spawned child so the caller can track
 *   and cancel the run.
 * - `ownProcessGroup` — make claude its own process-group leader so it can be
 *   group-killed independently of the caller. Foreground runs want this; a
 *   background WORKER must NOT set it, because cancelling a worker kills the
 *   worker's process group and claude has to be in it.
 * - `maxRuntimeMs` — hard cap; past it the process (group) is terminated and
 *   the result carries `maxRuntimeExceeded: true`.
 *
 * @returns {Promise<{
 *   ok: boolean, error?: string, exitCode?: number|null, sessionId?: string|null,
 *   result?: string, isError?: boolean, subtype?: string|null, numTurns?: number|null,
 *   costUsd?: number|null, touchedFiles?: string[], stderr?: string,
 *   maxRuntimeExceeded?: boolean
 * }>}
 */
export function runClaude({
  cwd,
  prompt,
  edit = false,
  resumeId = null,
  model = null,
  effort = null,
  fallbackModel = null,
  onEvent,
  progress,
  onChild,
  ownProcessGroup = false,
  maxRuntimeMs = 0
} = {}) {
  return new Promise((resolve) => {
    const args = buildClaudeArgs({ edit, resumeId, model, effort, fallbackModel });

    let child;
    try {
      child = spawn("claude", args, {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: ownProcessGroup && process.platform !== "win32"
      });
    } catch (err) {
      resolve({ ok: false, error: `failed to launch claude: ${err.message}` });
      return;
    }
    onChild?.(child);

    // The prompt goes through stdin: not visible in `ps`, no argv size limit.
    child.stdin.on("error", () => {});
    try {
      child.stdin.write(String(prompt ?? ""));
      child.stdin.end();
    } catch {
      // launch failure surfaces via the error/close events below
    }

    const state = {
      sessionId: null,
      model: null,
      resultText: "",
      isError: false,
      subtype: null,
      numTurns: null,
      costUsd: null,
      touchedFiles: new Set(),
      stderr: "",
      launchError: null,
      maxRuntimeExceeded: false
    };
    let buffer = "";

    let runtimeTimer = null;
    let escalateTimer = null;
    if (Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0) {
      runtimeTimer = setTimeout(() => {
        state.maxRuntimeExceeded = true;
        progress?.write(`■ max runtime exceeded (${Math.round(maxRuntimeMs / 1000)}s) — terminating claude`);
        terminateProcessTree(child.pid);
        escalateTimer = setTimeout(() => killProcessTreeHard(child.pid), KILL_ESCALATION_MS);
      }, maxRuntimeMs);
    }

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return;
      }
      onEvent?.(evt);
      if (progress) {
        progress.write(progressLineForEvent(evt));
      }

      switch (evt.type) {
        case "system":
          if (evt.session_id) {
            state.sessionId = evt.session_id;
          }
          if (evt.model) {
            // the model that actually serves the run (visible fallback)
            state.model = evt.model;
          }
          break;
        case "assistant": {
          const content = evt.message?.content ?? [];
          for (const block of content) {
            if (block?.type === "tool_use" && EDIT_TOOLS.has(block.name)) {
              const filePath = block.input?.file_path ?? block.input?.notebook_path;
              if (filePath) {
                state.touchedFiles.add(filePath);
              }
            }
          }
          break;
        }
        case "result":
          if (evt.session_id) {
            state.sessionId = evt.session_id;
          }
          if (typeof evt.result === "string") {
            state.resultText = evt.result;
          }
          state.subtype = evt.subtype ?? null;
          state.isError = Boolean(evt.is_error) || (evt.subtype != null && evt.subtype !== "success");
          state.numTurns = evt.num_turns ?? null;
          state.costUsd = evt.total_cost_usd ?? null;
          break;
        default:
          break;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      state.stderr += chunk;
    });

    child.on("error", (err) => {
      state.launchError = err.message;
    });

    child.on("close", (code) => {
      clearTimeout(runtimeTimer);
      clearTimeout(escalateTimer);
      if (buffer.trim()) {
        handleLine(buffer);
      }
      if (state.launchError) {
        resolve({ ok: false, error: `failed to launch claude: ${state.launchError}` });
        return;
      }
      resolve({
        ok: code === 0 && !state.isError && !state.maxRuntimeExceeded,
        exitCode: code,
        sessionId: state.sessionId,
        model: state.model,
        result: state.resultText,
        isError: state.isError || state.maxRuntimeExceeded,
        subtype: state.maxRuntimeExceeded ? "max_runtime_exceeded" : state.subtype,
        numTurns: state.numTurns,
        costUsd: state.costUsd,
        touchedFiles: [...state.touchedFiles],
        stderr: state.stderr.trim(),
        maxRuntimeExceeded: state.maxRuntimeExceeded
      });
    });
  });
}
