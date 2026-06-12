// claude-runner tests against the FAKE claude fixture (no cost, fast):
// stream-json parsing, stdin prompt transport, flags, error paths, watchdog.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { PLUGIN_ROOT, FIXTURES_BIN, makeTempHome, claudeProcsUnder, sleep } from "./helpers.mjs";

const HOME = makeTempHome();
const CAPTURE = path.join(HOME, "capture.json");
const REAL_PATH = process.env.PATH;
process.env.HOME = HOME;
process.env.PATH = `${FIXTURES_BIN}:${REAL_PATH}`;
process.env.FAKE_CLAUDE_CAPTURE = CAPTURE;

const { runClaude, buildClaudeArgs } = await import(path.join(PLUGIN_ROOT, "scripts", "lib", "claude-runner.mjs"));

const capture = () => JSON.parse(fs.readFileSync(CAPTURE, "utf8"));

test("buildClaudeArgs: no prompt in argv; gentle plan mode by default", () => {
  const args = buildClaudeArgs({ edit: false, resumeId: null, model: null });
  assert.ok(!args.some((a) => a.includes("hello")), "prompt must not appear in argv");
  assert.ok(args.includes("plan"));
  const editArgs = buildClaudeArgs({ edit: true, resumeId: "sess-9", model: "some-model", effort: "xhigh" });
  assert.ok(editArgs.includes("acceptEdits"));
  assert.ok(editArgs.includes("--resume") && editArgs.includes("sess-9"));
  assert.ok(editArgs.includes("--model") && editArgs.includes("some-model"));
  assert.ok(editArgs.includes("--effort") && editArgs.includes("xhigh"));
});

test("parses the stream: session id, result text, turns, cost", async () => {
  const run = await runClaude({ cwd: HOME, prompt: "hello fake" });
  assert.equal(run.ok, true);
  assert.equal(run.sessionId, "sess-fake-1");
  assert.match(run.result, /^echo:hello fake/);
  assert.equal(run.numTurns, 1);
  assert.equal(run.costUsd, 0.01);
});

test("the prompt travels via stdin and flags via argv", async () => {
  await runClaude({ cwd: HOME, prompt: "stdin proof", edit: true, resumeId: "sess-42" });
  const c = capture();
  assert.equal(c.prompt, "stdin proof");
  assert.ok(c.argv.includes("--permission-mode") && c.argv.includes("acceptEdits"));
  assert.ok(c.argv.includes("--resume") && c.argv.includes("sess-42"));
  assert.ok(!c.argv.some((a) => a.includes("stdin proof")));
});

test("collects touched files from Write tool_use events", async () => {
  const run = await runClaude({ cwd: HOME, prompt: "please TOUCH_FILE now" });
  assert.deepEqual(run.touchedFiles, [path.join(HOME, "fake-touched.py")]);
});

test("error result marks the run as failed", async () => {
  const run = await runClaude({ cwd: HOME, prompt: "FAIL_RUN please" });
  assert.equal(run.ok, false);
  assert.equal(run.isError, true);
  assert.equal(run.subtype, "error_during_execution");
});

test("missing claude binary fails gracefully (ENOENT)", async () => {
  process.env.PATH = "/usr/bin:/bin";
  try {
    const run = await runClaude({ cwd: HOME, prompt: "hi" });
    assert.equal(run.ok, false);
    assert.match(run.error, /failed to launch claude/);
  } finally {
    process.env.PATH = `${FIXTURES_BIN}:${REAL_PATH}`;
  }
});

test("maxRuntimeMs reaps a hung run (and the process group with it)", async () => {
  const work = fs.mkdtempSync(path.join(HOME, "wd-"));
  const started = Date.now();
  const run = await runClaude({ cwd: work, prompt: "SLEEP_FOREVER", ownProcessGroup: true, maxRuntimeMs: 1200 });
  assert.equal(run.maxRuntimeExceeded, true);
  assert.equal(run.isError, true);
  assert.equal(run.subtype, "max_runtime_exceeded");
  assert.ok(Date.now() - started < 10000, "watchdog should fire promptly");
  await sleep(500);
  if (process.platform === "linux") {
    assert.equal(claudeProcsUnder(work), "", "no fake claude may survive the watchdog");
  }
});
