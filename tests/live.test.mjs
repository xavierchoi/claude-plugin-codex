// OPT-IN live smoke tests against the REAL `claude` CLI. Each test spends a
// small amount of real usage, so they only run when explicitly requested:
//
//   CC_PLUGIN_CODEX_LIVE_TESTS=1 node --test tests/live.test.mjs
//
// Requirements: `claude` installed and logged in.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startServer, initialized, text, makeTempHome, waitFor } from "./helpers.mjs";

const LIVE = process.env.CC_PLUGIN_CODEX_LIVE_TESTS === "1";
const skip = LIVE ? false : "set CC_PLUGIN_CODEX_LIVE_TESTS=1 to run live tests (spends real usage)";

// Live runs use the REAL claude on PATH but still keep plugin state in a
// throwaway HOME? No — claude needs the real HOME for its login. State
// pollution is acceptable here: these are opt-in smoke tests, and the jobs
// they create are cleaned below.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-codex-live-"));

test("live: read-only consult answers and reports cost", { skip, timeout: 240000 }, async () => {
  const s = startServer();
  try {
    await initialized(s);
    const r = await s.rpc(
      "tools/call",
      { name: "consult", arguments: { prompt: "Reply with exactly the single word: PONG", cwd: work, verify: "auto" } },
      220000
    );
    const t = text(r);
    assert.match(t, /PONG/);
    assert.match(t, /advised on/);
    assert.match(t, /Verification skipped: no auto-checkable files/);
    assert.match(t, /📋 Progress log:/);
  } finally {
    s.stop();
  }
});

test("live: background job completes end-to-end", { skip, timeout: 300000 }, async () => {
  const s = startServer();
  try {
    await initialized(s);
    const launch = await s.rpc(
      "tools/call",
      { name: "consult", arguments: { prompt: "Reply with exactly the single word: FINISHED", cwd: work, background: true } },
      30000
    );
    const jobId = (text(launch).match(/job-[a-f0-9]+/) || [])[0];
    assert.ok(jobId, text(launch));
    const jobFile = path.join(os.homedir(), ".cache", "cc-plugin-codex", "jobs", `${jobId}.json`);
    const done = await waitFor(
      () => {
        const j = JSON.parse(fs.readFileSync(jobFile, "utf8"));
        return j.status !== "running" ? j : null;
      },
      { timeoutMs: 240000, intervalMs: 3000 }
    );
    assert.equal(done?.status, "done");
    const r = await s.rpc("tools/call", { name: "consult_result", arguments: { job_id: jobId } });
    assert.match(text(r), /FINISHED/);
    fs.rmSync(jobFile, { force: true });
  } finally {
    s.stop();
  }
});
