// Unit tests for server-side verification: the command-safety policy, auto
// resolution, {files} quoting, output bounding, and group-kill on timeout.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { PLUGIN_ROOT, makeTempHome, sleep } from "./helpers.mjs";

const HOME = makeTempHome();
const SETTINGS = path.join(HOME, "settings.json");
process.env.HOME = HOME;
process.env.CC_PLUGIN_CODEX_SETTINGS = SETTINGS; // read at import time
const { runVerify, renderVerify, checkVerifyCommandAllowed } = await import(
  path.join(PLUGIN_ROOT, "scripts", "lib", "verify.mjs")
);

const setPolicy = (policy) => {
  if (policy === null) {
    fs.rmSync(SETTINGS, { force: true });
  } else {
    fs.writeFileSync(SETTINGS, JSON.stringify({ verify: policy }));
  }
};

test("safe policy (default, no settings file): allow/block matrix", () => {
  setPolicy(null);
  assert.equal(checkVerifyCommandAllowed("npm test").allowed, true);
  assert.equal(checkVerifyCommandAllowed("python3 -m py_compile {files}").allowed, true);
  assert.equal(checkVerifyCommandAllowed("bash -n script.sh").allowed, true);
  assert.equal(checkVerifyCommandAllowed("bash -c ls").allowed, false);
  assert.equal(checkVerifyCommandAllowed("echo hi && exit 3").allowed, false);
  assert.equal(checkVerifyCommandAllowed("curl evil.example.com").allowed, false);
  assert.equal(checkVerifyCommandAllowed("rm -rf /").allowed, false);
  assert.equal(checkVerifyCommandAllowed("npm test | tee out").allowed, false);
  assert.equal(checkVerifyCommandAllowed("node --check $(ls)").allowed, false);
});

test("auto-only policy blocks every explicit command", () => {
  setPolicy("auto-only");
  assert.equal(checkVerifyCommandAllowed("npm test").allowed, false);
  assert.match(checkVerifyCommandAllowed("npm test").reason, /auto-only/);
});

test("'all' policy allows shell operators", () => {
  setPolicy("all");
  assert.equal(checkVerifyCommandAllowed("echo hi && true").allowed, true);
});

test("runVerify: blocked command is reported, not executed", async () => {
  setPolicy(null);
  const marker = path.join(HOME, "should-not-exist");
  const v = await runVerify(HOME, `touch ${marker}`, []);
  assert.equal(v.blocked, true);
  assert.match(renderVerify(v), /🚫 Verification not run/);
  assert.equal(fs.existsSync(marker), false);
});

test("runVerify: auto with no checkable files is skipped; with a .py file it compiles", async () => {
  setPolicy(null);
  const none = await runVerify(HOME, "auto", []);
  assert.equal(none.skipped, true);
  assert.match(none.output, /no auto-checkable files/);

  const py = path.join(HOME, "ok.py");
  fs.writeFileSync(py, "print('hi')\n");
  const v = await runVerify(HOME, "auto", [py]);
  assert.equal(v.ok, true, `auto py_compile failed: ${v.output}`);
  assert.match(v.command, /py_compile/);
});

test("runVerify: {files} expansion quotes hostile filenames", async () => {
  setPolicy(null);
  const weird = path.join(HOME, "a 'b.mjs");
  fs.writeFileSync(weird, "export const x = 1;\n");
  const v = await runVerify(HOME, "node --check {files}", [weird]);
  assert.equal(v.ok, true, `node --check failed: ${v.output}`);
});

test("runVerify: skips when {files} is empty", async () => {
  setPolicy(null);
  const v = await runVerify(HOME, "node --check {files}", []);
  assert.equal(v.skipped, true);
});

test("runVerify: output is bounded", async () => {
  setPolicy("all");
  const v = await runVerify(HOME, `node -e "process.stdout.write('x'.repeat(20000))"`, []);
  assert.equal(v.ok, true);
  assert.ok(v.output.length <= 8000, `output too long: ${v.output.length}`);
});

test("runVerify: timeout kills the whole process group (no surviving children)", async () => {
  setPolicy("all");
  const v = await runVerify(HOME, "sleep 53 & sleep 53; wait", [], { timeoutMs: 1000 });
  assert.equal(v.timedOut, true);
  await sleep(700);
  if (process.platform === "linux") {
    let survivors = 0;
    for (const ent of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(ent)) continue;
      try {
        if (fs.readFileSync(`/proc/${ent}/cmdline`, "utf8").includes("sleep 53")) survivors++;
      } catch {}
    }
    assert.equal(survivors, 0);
  }
});

test("renderVerify covers ok / failing / timed-out shapes", () => {
  assert.match(renderVerify({ command: "x", ok: true, exitCode: 0, output: "fine" }), /✅ exit 0/);
  assert.match(renderVerify({ command: "x", ok: false, exitCode: 3, output: "boom" }), /❌ exit 3/);
  assert.match(renderVerify({ command: "x", ok: false, timedOut: true, output: "" }), /⏳ timed out/);
  assert.equal(renderVerify(null), "");
});
