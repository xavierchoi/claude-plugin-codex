// Readiness checks for the setup tool, including the tri-state login logic.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { PLUGIN_ROOT, FIXTURES_BIN, makeTempHome } from "./helpers.mjs";

const HOME = makeTempHome();
const REAL_PATH = process.env.PATH;
process.env.HOME = HOME;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CONFIG_DIR;

const { checkClaudeReadiness, renderReadiness } = await import(
  path.join(PLUGIN_ROOT, "scripts", "lib", "claude-status.mjs")
);

test("claude missing from PATH → not ready, install step suggested", async () => {
  process.env.PATH = "/usr/bin:/bin";
  try {
    const status = await checkClaudeReadiness();
    assert.equal(status.ready, false);
    assert.equal(status.claude.available, false);
    assert.ok(status.nextSteps.some((s) => /Install Claude Code/.test(s)));
    assert.match(renderReadiness(status), /isn't fully set up/);
  } finally {
    process.env.PATH = `${FIXTURES_BIN}:${REAL_PATH}`;
  }
});

test("claude present but no credentials (linux) → logged out", async () => {
  const status = await checkClaudeReadiness();
  assert.equal(status.claude.available, true);
  assert.match(status.claude.detail, /fake claude/);
  if (process.platform === "linux") {
    assert.equal(status.auth.loggedIn, false);
    assert.equal(status.ready, false);
    assert.ok(status.nextSteps.some((s) => /Sign in/.test(s)));
    assert.match(renderReadiness(status), /❌/);
  }
});

test("credentials file under $HOME/.claude → ready", async () => {
  fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(HOME, ".claude", ".credentials.json"), "{}");
  try {
    const status = await checkClaudeReadiness();
    assert.equal(status.auth.loggedIn, true);
    assert.equal(status.ready, true);
    assert.match(renderReadiness(status), /ready to consult/);
  } finally {
    fs.rmSync(path.join(HOME, ".claude"), { recursive: true, force: true });
  }
});

test("CLAUDE_CONFIG_DIR is honored for credentials discovery", async () => {
  const altDir = path.join(HOME, "alt-config");
  fs.mkdirSync(altDir, { recursive: true });
  fs.writeFileSync(path.join(altDir, ".credentials.json"), "{}");
  process.env.CLAUDE_CONFIG_DIR = altDir;
  try {
    const status = await checkClaudeReadiness();
    assert.equal(status.auth.loggedIn, true);
    assert.equal(status.credentials.path, path.join(altDir, ".credentials.json"));
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    fs.rmSync(altDir, { recursive: true, force: true });
  }
});

test("deep:true verifies the login with a live (fake) call", async () => {
  fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(HOME, ".claude", ".credentials.json"), "{}");
  try {
    const status = await checkClaudeReadiness({ deep: true });
    assert.equal(status.auth.verified, true);
    assert.match(renderReadiness(status), /verified/);
  } finally {
    fs.rmSync(path.join(HOME, ".claude"), { recursive: true, force: true });
  }
});

test("readiness report carries the platform; render warns on Windows", async () => {
  const status = await checkClaudeReadiness();
  assert.equal(status.platform.supported, process.platform !== "win32");
  const win = renderReadiness({
    ...status,
    platform: { name: "win32", supported: false, detail: "Windows is not fully supported — background-job cancellation and bash-based auto-verify are unavailable" }
  });
  assert.match(win, /Platform: ⚠️ Windows is not fully supported/);
  if (process.platform === "linux") {
    assert.ok(!renderReadiness(status).includes("Platform:"), "no platform line on supported OSes");
  }
});

test("renderReadiness shows ❓ for the unknown (tri-state) login", () => {
  const rendered = renderReadiness({
    ready: true,
    node: { available: true, detail: "v0" },
    claude: { available: true, detail: "fake" },
    auth: { loggedIn: null, verified: false, detail: "couldn't determine the login state" },
    credentials: { present: false, path: null, unknown: true },
    nextSteps: []
  });
  assert.match(rendered, /❓/);
});
