import { spawn } from "node:child_process";

import { terminateProcessTree, killProcessTreeHard } from "./process.mjs";
import { SETTINGS_FILE, loadSettings } from "./settings.mjs";

// Run a caller-supplied verification command AFTER Claude finishes, from the
// MCP server (which has no approval gate). This closes the headless gap where
// Claude itself can't reliably run `py_compile`, tests, lint, etc. Output is
// bounded and the command's whole process group is killed past a timeout, so
// a stuck verify can't hang the consult or leave grandchildren behind.
const MAX_OUTPUT = 8000;
const DEFAULT_TIMEOUT_MS = 180000;
const KILL_ESCALATION_MS = 5000;

// --- verify command policy -------------------------------------------------
//
// The verify command is written by the MODEL, not the user, and the server is
// outside Codex's sandbox — so an unrestricted `verify` would hand any prompt
// injection in the repo an unsandboxed shell. Default policy "safe" allows
// `"auto"` plus plain invocations of well-known dev tools (no shell
// operators). Users can relax or tighten this in the settings file.
const VERIFY_POLICIES = new Set(["auto-only", "safe", "all"]);

// Plain dev tools considered safe to invoke directly (no shell metacharacters
// allowed around them, so no chaining/redirection/substitution).
const SAFE_VERIFY_TOOLS = new Set([
  "python3", "python", "pytest", "ruff", "mypy",
  "node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "tsc", "eslint", "prettier", "jest", "vitest",
  "go", "gofmt", "cargo", "rustc", "make", "cmake",
  "mvn", "gradle", "rake", "bundle", "mix", "dotnet", "swift", "javac"
]);

function loadVerifyPolicy() {
  const settings = loadSettings();
  return VERIFY_POLICIES.has(settings?.verify) ? settings.verify : "safe";
}

// Decide whether an EXPLICIT verify command (anything but "auto") may run.
// Returns { allowed: true } or { allowed: false, reason }.
export function checkVerifyCommandAllowed(rawCommand) {
  const policy = loadVerifyPolicy();
  if (policy === "all") {
    return { allowed: true };
  }
  if (policy === "auto-only") {
    return {
      allowed: false,
      reason: `the verify policy is "auto-only" — only verify:"auto" may run. (Change "verify" in ${SETTINGS_FILE} to "safe" or "all" to allow commands.)`
    };
  }
  // policy "safe": one plain command, no shell operators, known tool.
  const probe = String(rawCommand).replaceAll("{files}", "FILES");
  if (/[;&|<>$`\\(){}[\]*?~#"'\n\r]/.test(probe)) {
    return {
      allowed: false,
      reason: `the command contains shell operators, which the default "safe" verify policy blocks. Use verify:"auto", a plain command like 'npm test', or set "verify": "all" in ${SETTINGS_FILE}.`
    };
  }
  const tokens = probe.trim().split(/\s+/);
  const tool = (tokens[0] || "").split("/").pop().toLowerCase();
  if ((tool === "bash" || tool === "sh") && tokens[1] === "-n") {
    return { allowed: true }; // syntax-check form only
  }
  if (SAFE_VERIFY_TOOLS.has(tool)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `\`${tool}\` is not in the safe verify allowlist (common build/test tools). Use verify:"auto" or set "verify": "all" in ${SETTINGS_FILE} to allow it.`
  };
}

function quote(file) {
  return `'${String(file).replace(/'/g, "'\\''")}'`;
}

// Derive a cheap, reliable syntax check for the files Claude touched, so callers
// can pass verify:"auto" instead of naming a command. Covers the common quick
// checks; anything heavier/config-dependent (tsc, cargo, go build) should be an
// explicit verify command.
function resolveAutoVerify(touchedFiles) {
  const files = (touchedFiles || []).filter(Boolean);
  const pick = (exts) => files.filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)));
  const parts = [];
  const py = pick([".py"]);
  if (py.length) {
    parts.push(`python3 -m py_compile ${py.map(quote).join(" ")}`);
  }
  for (const f of pick([".js", ".mjs", ".cjs"])) {
    parts.push(`node --check ${quote(f)}`);
  }
  for (const f of pick([".sh", ".bash"])) {
    parts.push(`bash -n ${quote(f)}`);
  }
  return parts.length ? parts.join(" && ") : null;
}

export function runVerify(cwd, command, touchedFiles = [], { timeoutMs = DEFAULT_TIMEOUT_MS, onChild } = {}) {
  return new Promise((resolve) => {
    const raw = String(command || "").trim();
    if (!raw) {
      resolve(null);
      return;
    }

    let cmd = raw;
    if (raw.toLowerCase() === "auto") {
      const auto = resolveAutoVerify(touchedFiles);
      if (!auto) {
        resolve({
          command: "auto",
          skipped: true,
          output: "no auto-checkable files were touched (auto-verify covers .py, .js/.mjs/.cjs, .sh — pass an explicit verify command for anything else)."
        });
        return;
      }
      cmd = auto;
    } else {
      const gate = checkVerifyCommandAllowed(raw);
      if (!gate.allowed) {
        resolve({ command: raw, blocked: true, output: gate.reason });
        return;
      }
      if (cmd.includes("{files}")) {
        const files = (touchedFiles || []).filter(Boolean);
        if (files.length === 0) {
          resolve({ command: raw, skipped: true, output: "Claude touched no files, so {files} is empty — verification skipped." });
          return;
        }
        cmd = cmd.replaceAll("{files}", files.map(quote).join(" "));
      }
    }

    let child;
    try {
      // detached → own process group so a timeout can kill the whole tree
      // (shell AND whatever it spawned), not just the shell.
      child = spawn(cmd, {
        cwd,
        env: process.env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32"
      });
    } catch (err) {
      resolve({ command: cmd, ok: false, exitCode: null, output: `failed to launch: ${err.message}` });
      return;
    }
    onChild?.(child);

    let out = "";
    const capture = (chunk) => {
      out += chunk;
      if (out.length > MAX_OUTPUT) {
        out = out.slice(-MAX_OUTPUT);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", capture);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", capture);

    let timedOut = false;
    let escalateTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid);
      escalateTimer = setTimeout(() => killProcessTreeHard(child.pid), KILL_ESCALATION_MS);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      clearTimeout(escalateTimer);
      resolve({ command: cmd, ok: false, exitCode: null, output: `error: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(escalateTimer);
      resolve({
        command: cmd,
        ok: code === 0,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        output: out.trim()
      });
    });
  });
}

export function renderVerify(v) {
  if (!v) {
    return "";
  }
  if (v.blocked) {
    return `\n\n🚫 Verification not run: ${v.output}`;
  }
  if (v.skipped) {
    return `\n\n🔍 Verification skipped: ${v.output}`;
  }
  let status;
  if (v.timedOut) {
    status = "⏳ timed out";
  } else if (v.ok) {
    status = "✅ exit 0";
  } else if (v.exitCode != null) {
    status = `❌ exit ${v.exitCode}`;
  } else if (v.signal) {
    status = `❌ signal ${v.signal}`;
  } else {
    status = "❌ failed";
  }
  const lines = [`\n\n🔍 Verification: \`${v.command}\` → ${status}`];
  if (v.output) {
    const tail = v.output.split("\n").slice(-12).join("\n");
    lines.push("```\n" + tail + "\n```");
  }
  return lines.join("\n");
}
