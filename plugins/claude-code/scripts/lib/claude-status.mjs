import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runClaude } from "./claude-runner.mjs";

// Readiness checks for the consult tool — the gentle mirror of `/codex:setup`:
// is `claude` installed, and is a login available so headless runs work?

function binaryVersion(bin, args = ["--version"]) {
  try {
    const out = execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000
    }).trim();
    return { available: true, detail: out.split(/\r?\n/)[0] };
  } catch (err) {
    const detail = err?.code === "ENOENT" ? `${bin} not found on PATH` : err?.message || "unavailable";
    return { available: false, detail };
  }
}

function credentialsPresent() {
  const candidates = [];
  if (process.env.CLAUDE_CONFIG_DIR) {
    candidates.push(path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"));
  }
  candidates.push(
    path.join(os.homedir(), ".claude", ".credentials.json"),
    path.join(os.homedir(), ".config", "claude", ".credentials.json")
  );
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return { present: true, path: candidate, unknown: false };
      }
    } catch {
      // keep looking
    }
  }
  // macOS stores the login in the Keychain, not a credentials file. Probe it,
  // but treat any failure as "unknown" rather than "not logged in" — keychain
  // service names vary across versions and the keychain may be locked.
  if (process.platform === "darwin") {
    try {
      execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
        stdio: "ignore",
        timeout: 5000
      });
      return { present: true, path: "macOS Keychain", unknown: false };
    } catch {
      return { present: false, path: null, unknown: true };
    }
  }
  return { present: false, path: null, unknown: false };
}

/**
 * Inspect whether Claude Code is ready to be consulted.
 * Pass `deep: true` to confirm the login with a tiny live `claude -p` call.
 */
export async function checkClaudeReadiness({ deep = false } = {}) {
  const node = { available: true, detail: process.version };
  const claude = binaryVersion("claude");
  const apiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const credentials = credentialsPresent();

  // auth.loggedIn is tri-state: true / false / null ("couldn't determine").
  let auth;
  if (!claude.available) {
    auth = { loggedIn: false, method: null, verified: false, detail: "claude is not installed" };
  } else if (apiKey) {
    auth = {
      loggedIn: true,
      method: "api-key",
      verified: false,
      detail: "ANTHROPIC_API_KEY is set — API billing will be used instead of your Claude login"
    };
  } else if (credentials.present) {
    auth = { loggedIn: true, method: "login", verified: false, detail: "Claude login detected" };
  } else if (credentials.unknown) {
    auth = {
      loggedIn: null,
      method: null,
      verified: false,
      detail: "couldn't determine the login state (macOS keeps it in the Keychain) — run setup with deep: true to check with a live call"
    };
  } else {
    auth = { loggedIn: false, method: null, verified: false, detail: "no Claude login found" };
  }

  if (deep && claude.available) {
    const ping = await runClaude({ cwd: os.homedir(), prompt: "Reply with exactly the single word: OK", edit: false });
    if (ping.ok && /OK/.test(ping.result || "")) {
      auth = {
        ...auth,
        loggedIn: true,
        verified: true,
        detail: auth.method === "api-key" ? "API key verified via a live call" : "Claude login verified via a live call"
      };
    } else if (ping.error) {
      auth = { ...auth, verified: false, detail: `live check could not run claude: ${ping.error}` };
    } else {
      auth = {
        ...auth,
        loggedIn: false,
        verified: false,
        detail: `live check did not succeed (${ping.subtype ?? "error"}); you may need to sign in again`
      };
    }
  }

  // "unknown" login state (macOS Keychain) doesn't block readiness — consult
  // will work if the user is in fact logged in, and deep:true can confirm.
  const ready = node.available && claude.available && auth.loggedIn !== false;

  const nextSteps = [];
  if (!claude.available) {
    nextSteps.push(
      "Install Claude Code (`npm install -g @anthropic-ai/claude-code`, or see https://docs.claude.com/claude-code), then make sure `claude` is on your PATH."
    );
  }
  if (claude.available && auth.loggedIn === false) {
    nextSteps.push("Sign in: run `claude` once and complete login (or `claude setup-token` for a long-lived token).");
  }
  if (claude.available && auth.loggedIn === null) {
    nextSteps.push("Run setup with `deep: true` to confirm the login with a quick live call.");
  }
  if (ready && auth.loggedIn === true && !deep) {
    nextSteps.push("Optional: run setup with `deep: true` to verify the login with a quick live call.");
  }

  return { ready, node, claude, auth, credentials, nextSteps };
}

export function renderReadiness(status) {
  const lines = [];
  lines.push(status.ready ? "✅ Claude Code is ready to consult." : "⚠️ Claude Code isn't fully set up yet.");
  lines.push("");
  lines.push(`- Node: ${status.node.detail}`);
  lines.push(`- claude: ${status.claude.available ? status.claude.detail : `not available (${status.claude.detail})`}`);
  const loginIcon = status.auth.loggedIn === true ? "✅" : status.auth.loggedIn === null ? "❓" : "❌";
  lines.push(`- Login: ${loginIcon} ${status.auth.detail}${status.auth.verified ? " (verified)" : ""}`);
  if (status.nextSteps.length) {
    lines.push("");
    lines.push("Next steps:");
    for (const step of status.nextSteps) {
      lines.push(`- ${step}`);
    }
  } else {
    lines.push("");
    lines.push("You're all set — use the `consult` tool to hand work to Claude.");
  }
  return lines.join("\n");
}
