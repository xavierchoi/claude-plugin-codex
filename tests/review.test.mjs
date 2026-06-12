// The review tool and its git-diff collection, plus model/effort handling
// (per-call args, settings defaults, validation) — all against the fake claude.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { PLUGIN_ROOT, startServer, initialized, text, makeTempHome, fakeClaudeEnv } from "./helpers.mjs";

const { collectDiff } = await import(path.join(PLUGIN_ROOT, "scripts", "lib", "git-diff.mjs"));

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", ...args], { cwd, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();

function makeRepo(home) {
  const repo = fs.mkdtempSync(path.join(home, "repo-"));
  git(repo, "init", "-b", "main");
  fs.writeFileSync(path.join(repo, "app.js"), "export const answer = 41;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial");
  return repo;
}

test("collectDiff: not a git repository → friendly error", async () => {
  const dir = makeTempHome();
  const result = await collectDiff(dir);
  assert.match(result.error, /not inside a git repository/);
});

test("collectDiff: clean tree → empty; modified tree → patch with the change", async () => {
  const repo = makeRepo(makeTempHome());
  assert.equal((await collectDiff(repo)).empty, true);

  fs.writeFileSync(path.join(repo, "app.js"), "export const answer = 42;\n");
  const diff = await collectDiff(repo);
  assert.match(diff.patch, /\+export const answer = 42;/);
  assert.match(diff.stat, /app\.js/);
  assert.equal(diff.truncated, false);
});

test("collectDiff: base ref reviews everything since the merge-base", async () => {
  const repo = makeRepo(makeTempHome());
  git(repo, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(repo, "feature.js"), "export const fresh = true;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "feature work");
  const diff = await collectDiff(repo, "main");
  assert.match(diff.patch, /\+export const fresh = true;/);
  const bad = await collectDiff(repo, "no-such-branch");
  assert.match(bad.error, /could not resolve base/);
});

test("collectDiff: untracked files are listed", async () => {
  const repo = makeRepo(makeTempHome());
  fs.writeFileSync(path.join(repo, "new-file.txt"), "hello\n");
  const diff = await collectDiff(repo);
  assert.deepEqual(diff.untracked, ["new-file.txt"]);
});

test("review tool: collects the diff, hands Claude a gentle read-only review", async () => {
  const HOME = makeTempHome();
  const repo = makeRepo(HOME);
  fs.writeFileSync(path.join(repo, "app.js"), "export const answer = 42;\n");
  const capture = path.join(HOME, "capture.json");
  const s = startServer(fakeClaudeEnv(HOME, { FAKE_CLAUDE_CAPTURE: capture }));
  try {
    await initialized(s);
    const r = await s.rpc("tools/call", {
      name: "review",
      arguments: { cwd: repo, focus: "the answer constant", effort: "high" }
    });
    const t = text(r);
    assert.match(t, /advised on/, "reviews are advisory");
    const c = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.match(c.prompt, /collaborative second pair of eyes/);
    assert.match(c.prompt, /\+export const answer = 42;/, "the diff travels in the prompt");
    assert.match(c.prompt, /Pay particular attention to: the answer constant/);
    assert.ok(c.argv.includes("--permission-mode") && c.argv.includes("plan"), "review must be read-only");
    assert.ok(c.argv.includes("--effort") && c.argv.includes("high"), "effort passes through");
  } finally {
    s.stop();
  }
});

test("review tool: clean tree and non-repo answer without spawning Claude", async () => {
  const HOME = makeTempHome();
  const repo = makeRepo(HOME);
  const capture = path.join(HOME, "capture.json");
  const s = startServer(fakeClaudeEnv(HOME, { FAKE_CLAUDE_CAPTURE: capture }));
  try {
    await initialized(s);
    const clean = await s.rpc("tools/call", { name: "review", arguments: { cwd: repo } });
    assert.match(text(clean), /Nothing to review — the working tree is clean/);
    const notRepo = await s.rpc("tools/call", { name: "review", arguments: { cwd: HOME } });
    assert.equal(notRepo.result.isError, true);
    assert.match(text(notRepo), /Nothing to review/);
    assert.equal(fs.existsSync(capture), false, "no claude run for nothing-to-review paths");
  } finally {
    s.stop();
  }
});

test("model/effort: per-call args win, settings provide defaults, invalid effort is rejected", async () => {
  const HOME = makeTempHome();
  const capture = path.join(HOME, "capture.json");
  const settingsFile = path.join(HOME, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ model: "sonnet", effort: "low" }));
  const s = startServer(fakeClaudeEnv(HOME, { FAKE_CLAUDE_CAPTURE: capture, CC_PLUGIN_CODEX_SETTINGS: settingsFile }));
  try {
    await initialized(s);

    // settings defaults apply when the call doesn't specify
    await s.rpc("tools/call", { name: "consult", arguments: { prompt: "hi", cwd: HOME } });
    let c = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.ok(c.argv.includes("--model") && c.argv.includes("sonnet"), `argv: ${c.argv.join(" ")}`);
    assert.ok(c.argv.includes("--effort") && c.argv.includes("low"));

    // per-call arguments override the settings — and explicit choices are
    // respected strictly: no automatic fallback model
    await s.rpc("tools/call", { name: "consult", arguments: { prompt: "hi", cwd: HOME, model: "opus", effort: "max" } });
    c = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.ok(c.argv.includes("opus") && c.argv.includes("max"));
    assert.ok(!c.argv.includes("sonnet") && !c.argv.includes("low"));
    assert.ok(!c.argv.includes("--fallback-model"));

    // invalid effort → friendly error, no run
    const bad = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "hi", cwd: HOME, effort: "extreme" } });
    assert.equal(bad.result.isError, true);
    assert.match(text(bad), /Unknown effort `extreme`/);
  } finally {
    s.stop();
  }
});

test("model omitted everywhere → built-in default: fable with sonnet fallback", async () => {
  const HOME = makeTempHome();
  const capture = path.join(HOME, "capture.json");
  const s = startServer(fakeClaudeEnv(HOME, { FAKE_CLAUDE_CAPTURE: capture }));
  try {
    await initialized(s);
    await s.rpc("tools/call", { name: "consult", arguments: { prompt: "hi", cwd: HOME } });
    const c = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.ok(c.argv.includes("--model") && c.argv.includes("fable"), `argv: ${c.argv.join(" ")}`);
    assert.ok(c.argv.includes("--fallback-model") && c.argv.includes("sonnet"));
    assert.ok(!c.argv.includes("--effort"), "no effort default — Claude decides");
  } finally {
    s.stop();
  }
});

test("model 'inherit' → no model flags at all (the user's Claude config decides)", async () => {
  const HOME = makeTempHome();
  const capture = path.join(HOME, "capture.json");
  const s = startServer(fakeClaudeEnv(HOME, { FAKE_CLAUDE_CAPTURE: capture }));
  try {
    await initialized(s);
    await s.rpc("tools/call", { name: "consult", arguments: { prompt: "hi", cwd: HOME, model: "inherit" } });
    const c = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.ok(!c.argv.includes("--model") && !c.argv.includes("--fallback-model"), `argv: ${c.argv.join(" ")}`);

    // …and via settings too
    const settingsFile = path.join(HOME, "settings2.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ model: "inherit" }));
    const s2 = startServer(fakeClaudeEnv(HOME, { FAKE_CLAUDE_CAPTURE: capture, CC_PLUGIN_CODEX_SETTINGS: settingsFile }));
    try {
      await initialized(s2);
      await s2.rpc("tools/call", { name: "consult", arguments: { prompt: "hi", cwd: HOME } });
      const c2 = JSON.parse(fs.readFileSync(capture, "utf8"));
      assert.ok(!c2.argv.includes("--model") && !c2.argv.includes("--fallback-model"));
    } finally {
      s2.stop();
    }
  } finally {
    s.stop();
  }
});
