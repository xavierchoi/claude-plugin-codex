import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// A live, tail-able progress log for a consult run. Every run gets its own
// file and a `latest.log` symlink always points at the most recent run, so a
// human (or another tool) can `tail -f` it while Claude works. Best-effort:
// any failure degrades to a silent no-op.
const LOG_DIR = path.join(os.homedir(), ".cache", "cc-plugin-codex", "logs");
const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function keyForCwd(cwd) {
  // cwd hash for human grouping + a random suffix so two concurrent runs in
  // the same directory never truncate each other's log.
  const hash = crypto.createHash("sha1").update(path.resolve(cwd || ".")).digest("hex").slice(0, 12);
  return `${hash}-${crypto.randomBytes(3).toString("hex")}`;
}

// Predict a log path without opening it (lets a background launch report the
// path before the worker has started writing).
export function progressLogPath(key) {
  return path.join(LOG_DIR, `consult-${key}.log`);
}

// Drop logs older than a week so the directory stays bounded. (Job-owned logs
// are also pruned with their jobs; this catches foreground-run logs.)
function pruneOldLogs() {
  try {
    const cutoff = Date.now() - LOG_MAX_AGE_MS;
    for (const name of fs.readdirSync(LOG_DIR)) {
      if (!name.startsWith("consult-") || !name.endsWith(".log")) {
        continue;
      }
      const full = path.join(LOG_DIR, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
        }
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
}

// `opts.key` pins a stable name (e.g. a job id for background runs); otherwise
// a fresh per-run name is derived from cwd. `latest.log` always tracks the
// newest run either way.
export function openProgressLog(cwd, opts = {}) {
  let fd = null;
  let file = null;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    pruneOldLogs();
    file = progressLogPath(opts.key || keyForCwd(cwd));
    fd = fs.openSync(file, "w"); // truncate at run start
    const latest = path.join(LOG_DIR, "latest.log");
    try {
      fs.rmSync(latest, { force: true });
      fs.symlinkSync(file, latest);
    } catch {
      // symlink is a convenience only; ignore failures
    }
  } catch {
    fd = null;
    file = null;
  }

  const write = (line) => {
    if (fd == null || !line) return;
    try {
      for (const l of String(line).split("\n")) {
        fs.writeSync(fd, `[${stamp()}] ${l}\n`);
      }
    } catch {
      // ignore write failures
    }
  };

  const close = (footer) => {
    if (footer) write(footer);
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      fd = null;
    }
  };

  return { file, write, close };
}

function short(value, n = 70) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function tail2(p) {
  return p ? String(p).split("/").slice(-2).join("/") : "";
}

// Map one stream-json event to a human-readable progress line (or null to skip).
export function progressLineForEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  switch (evt.type) {
    case "system":
      if (evt.subtype === "init") {
        return `▶ session ${evt.session_id ?? "?"} started${evt.model ? ` · ${evt.model}` : ""}`;
      }
      return null;
    case "assistant": {
      const out = [];
      for (const c of evt.message?.content ?? []) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "text" && c.text?.trim()) {
          out.push(`· ${short(c.text.trim().split("\n")[0], 88)}`);
        } else if (c.type === "tool_use") {
          const inp = c.input ?? {};
          switch (c.name) {
            case "Read":
              out.push(`  read ${tail2(inp.file_path)}`);
              break;
            case "Edit":
            case "Write":
            case "MultiEdit":
            case "NotebookEdit":
              out.push(`  edit ${tail2(inp.file_path ?? inp.notebook_path)}`);
              break;
            case "Bash":
              out.push(`  run  ${short(inp.command, 80)}`);
              break;
            case "Skill":
              out.push(`  skill ${inp.command ?? inp.name ?? ""}`);
              break;
            case "Grep":
            case "Glob":
              out.push(`  search (${c.name})`);
              break;
            case "Task":
              out.push(`  subagent ${short(inp.description ?? "", 40)}`);
              break;
            default:
              out.push(`  tool ${c.name}`);
          }
        }
      }
      return out.length ? out.join("\n") : null;
    }
    case "result": {
      const cost = typeof evt.total_cost_usd === "number" ? ` · $${evt.total_cost_usd.toFixed(4)}` : "";
      return `■ done · ${evt.subtype ?? ""} · ${evt.num_turns ?? "?"} turns${cost}`;
    }
    default:
      return null;
  }
}
