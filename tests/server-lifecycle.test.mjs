// End-to-end lifecycle tests through the real MCP server, driven by the FAKE
// claude fixture — full coverage of consult/background/cancel/watchdog/cleanup
// behavior without spending real usage.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  startServer,
  initialized,
  text,
  makeTempHome,
  fakeClaudeEnv,
  writeFakeJob,
  readJobFile,
  jobsDir,
  claudeProcsUnder,
  waitFor,
  sleep
} from "./helpers.mjs";

const onLinux = process.platform === "linux";

test("foreground consult: renders result, log pointer, cost", async () => {
  const HOME = makeTempHome();
  const s = startServer(fakeClaudeEnv(HOME));
  try {
    await initialized(s);
    const r = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "say hello", cwd: HOME } });
    const t = text(r);
    assert.match(t, /advised on/);
    assert.match(t, /echo:say hello/);
    assert.match(t, /📋 Progress log:/);
    // OAuth-login runs are plan usage, not a separate bill — and the meta line
    // carries the serving model and a duration
    assert.match(t, /≈\$0\.0100 of plan usage/);
    assert.match(t, /\( fake-model · /);
    assert.match(t, /· \d+m?\d*s ·/);
  } finally {
    s.stop();
  }
});

test("edit + verify:auto: touched files listed, syntax check runs", async () => {
  const HOME = makeTempHome();
  const work = fs.mkdtempSync(path.join(HOME, "wd-"));
  const s = startServer(fakeClaudeEnv(HOME));
  try {
    await initialized(s);
    const r = await s.rpc("tools/call", {
      name: "consult",
      arguments: { prompt: "please TOUCH_FILE", cwd: work, edit: true, verify: "auto" }
    });
    const t = text(r);
    assert.match(t, /made changes in/);
    assert.match(t, /fake-touched\.py/);
    assert.match(t, /python3 -m py_compile/);
    assert.match(t, /✅ exit 0/);
  } finally {
    s.stop();
  }
});

test("plan-file writes outside the repo are working notes, not touched files", async () => {
  const HOME = makeTempHome();
  const work = fs.mkdtempSync(path.join(HOME, "wd-"));
  const s = startServer(fakeClaudeEnv(HOME));
  try {
    await initialized(s);
    // read-only consult where (fake) plan mode writes ~/.claude/plans/fake-plan.md
    const r = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "please TOUCH_PLAN", cwd: work, verify: "auto" } });
    const t = text(r);
    assert.ok(!t.includes("Files Claude touched"), "a read-only run must not look like it modified files");
    assert.match(t, /working notes outside the repository/);
    assert.match(t, /no repository files were modified/);
    assert.match(t, /Verification skipped/, "the plan file must not become a verify target");

    // mixed: a real repo edit AND a plan note — list the edit, mention the note
    const r2 = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "TOUCH_FILE and TOUCH_PLAN", cwd: work, edit: true } });
    const t2 = text(r2);
    assert.match(t2, /Files Claude touched:/);
    assert.match(t2, /fake-touched\.py/);
    assert.ok(!/^- .*fake-plan\.md/m.test(t2), "the plan file must not be a touched-list item");
    assert.match(t2, /also kept working notes outside the repository/);
  } finally {
    s.stop();
  }
});

test("resume: second consult passes --resume with the stored session id", async () => {
  const HOME = makeTempHome();
  const capture = path.join(HOME, "capture.json");
  const s = startServer(fakeClaudeEnv(HOME, { FAKE_CLAUDE_CAPTURE: capture }));
  try {
    await initialized(s);
    await s.rpc("tools/call", { name: "consult", arguments: { prompt: "first", cwd: HOME } });
    const r = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "second", cwd: HOME, resume: true } });
    assert.match(text(r), /Continued the previous Claude session/);
    const c = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.ok(c.argv.includes("--resume") && c.argv.includes("sess-fake-1"), `argv: ${c.argv.join(" ")}`);
    assert.equal(c.prompt, "second");
  } finally {
    s.stop();
  }
});

test("verify policy: shell-operator command is blocked through the server (safe default)", async () => {
  const HOME = makeTempHome();
  const s = startServer(fakeClaudeEnv(HOME));
  try {
    await initialized(s);
    const r = await s.rpc("tools/call", {
      name: "consult",
      arguments: { prompt: "hi", cwd: HOME, verify: "echo BOOM >&2 && exit 3" }
    });
    const t = text(r);
    assert.match(t, /🚫 Verification not run/);
    assert.ok(!t.includes("BOOM\n"), "the command must not have executed");
  } finally {
    s.stop();
  }
});

test("missing claude binary → friendly launch error WITH an install next-step", async () => {
  const HOME = makeTempHome();
  const s = startServer({ ...fakeClaudeEnv(HOME), PATH: "/usr/bin:/bin" });
  try {
    await initialized(s);
    const r = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "hi", cwd: HOME } });
    assert.equal(r.result.isError, true);
    const t = text(r);
    assert.match(t, /Could not run Claude Code: failed to launch claude/);
    assert.match(t, /curl -fsSL https:\/\/claude\.ai\/install\.sh/);
    assert.match(t, /`setup` tool/);
  } finally {
    s.stop();
  }
});

test("background launch failure → consult_result explains it with a next-step (not an empty result)", async () => {
  const HOME = makeTempHome();
  const s = startServer({ ...fakeClaudeEnv(HOME), PATH: "/usr/bin:/bin" });
  try {
    await initialized(s);
    const launch = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "hi", cwd: HOME, background: true } });
    const jobId = (text(launch).match(/job-[a-f0-9]+/) || [])[0];
    const final = await waitFor(() => {
      const j = readJobFile(HOME, jobId);
      return j.status !== "running" ? j : null;
    });
    assert.equal(final?.status, "error");
    const r = await s.rpc("tools/call", { name: "consult_result", arguments: { job_id: jobId } });
    assert.equal(r.result.isError, true);
    const t = text(r);
    assert.match(t, /Could not run Claude Code/);
    assert.match(t, /install\.sh|setup/);
    assert.ok(!t.includes("(Claude returned no text.)"), "must not render an empty result for a launch failure");
  } finally {
    s.stop();
  }
});

test("consult_status wait_seconds long-polls until the job finishes", async () => {
  const HOME = makeTempHome();
  const s = startServer(fakeClaudeEnv(HOME));
  try {
    await initialized(s);
    const launch = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "long-poll me", cwd: HOME, background: true } });
    const jobId = (text(launch).match(/job-[a-f0-9]+/) || [])[0];
    // Called immediately — without the wait this would render "running";
    // with it, one call returns the finished state.
    const st = await s.rpc("tools/call", { name: "consult_status", arguments: { job_id: jobId, wait_seconds: 30 } }, 45000);
    assert.match(text(st), /· done ·/);
  } finally {
    s.stop();
  }
});

test("background job: launch → done → rendered result; job is launcher-stamped", async () => {
  const HOME = makeTempHome();
  const s = startServer(fakeClaudeEnv(HOME));
  try {
    await initialized(s);
    const launch = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "quick one", cwd: HOME, background: true } });
    const jobId = (text(launch).match(/job-[a-f0-9]+/) || [])[0];
    assert.ok(jobId, text(launch));
    assert.equal(readJobFile(HOME, jobId).launcherPid, s.child.pid);

    const done = await waitFor(() => {
      const j = readJobFile(HOME, jobId);
      return j.status !== "running" ? j : null;
    });
    assert.equal(done?.status, "done");
    const r = await s.rpc("tools/call", { name: "consult_result", arguments: { job_id: jobId } });
    assert.match(text(r), /echo:quick one/);
    assert.match(text(r), /📋 Progress log:/);
  } finally {
    s.stop();
  }
});

test("background cancel: kills the worker tree, no orphan, result says cancelled", async () => {
  const HOME = makeTempHome();
  const work = fs.mkdtempSync(path.join(HOME, "wd-"));
  const s = startServer(fakeClaudeEnv(HOME));
  try {
    await initialized(s);
    const launch = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "SLEEP_FOREVER", cwd: work, background: true } });
    const jobId = (text(launch).match(/job-[a-f0-9]+/) || [])[0];
    if (onLinux) {
      const seen = await waitFor(() => claudeProcsUnder(work));
      assert.ok(seen, "fake claude should be running before the cancel");
    } else {
      await sleep(1500);
    }
    const c = await s.rpc("tools/call", { name: "consult_cancel", arguments: { job_id: jobId } });
    assert.match(text(c), /Cancelled job/);
    assert.equal(readJobFile(HOME, jobId).status, "cancelled");
    if (onLinux) {
      const gone = await waitFor(() => (claudeProcsUnder(work) === "" ? "gone" : null));
      assert.equal(gone, "gone", "cancel must not leave an orphaned claude");
    }
    const r = await s.rpc("tools/call", { name: "consult_result", arguments: { job_id: jobId } });
    assert.match(text(r), /was cancelled/);
  } finally {
    s.stop();
  }
});

test("notifications/cancelled kills the foreground claude and suppresses the reply", { skip: !onLinux }, async () => {
  const HOME = makeTempHome();
  const work = fs.mkdtempSync(path.join(HOME, "wd-"));
  const s = startServer(fakeClaudeEnv(HOME));
  try {
    await initialized(s);
    const { id, promise } = s.rpcWithId("tools/call", { name: "consult", arguments: { prompt: "SLEEP_FOREVER", cwd: work } }, 8000);
    const seen = await waitFor(() => claudeProcsUnder(work));
    assert.ok(seen, "fake claude should be running before the cancel");
    s.notify("notifications/cancelled", { requestId: id, reason: "test cancel" });
    const gone = await waitFor(() => (claudeProcsUnder(work) === "" ? "gone" : null));
    assert.equal(gone, "gone");
    await assert.rejects(promise, /timeout/, "a cancelled request must get no reply");
  } finally {
    s.stop();
  }
});

test("session end: reaps foreground run and OWN jobs; leaves another session's job alone", { skip: !onLinux }, async () => {
  const HOME = makeTempHome();
  const work = fs.mkdtempSync(path.join(HOME, "wd-"));
  const s = startServer(fakeClaudeEnv(HOME));
  const foreignSleeper = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
  try {
    await initialized(s);
    writeFakeJob(HOME, "job-foreign", { pid: foreignSleeper.pid, launcherPid: 999999, startedAt: new Date().toISOString() });

    const bg = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "SLEEP_FOREVER bg", cwd: work, background: true } });
    const ownJobId = (text(bg).match(/job-[a-f0-9]+/) || [])[0];
    s.rpc("tools/call", { name: "consult", arguments: { prompt: "SLEEP_FOREVER fg", cwd: work } }, 60000).catch(() => null);
    await waitFor(() => (claudeProcsUnder(work).split("\n").filter(Boolean).length >= 2 ? "both" : null));

    s.child.stdin.end();
    await new Promise((r) => s.child.on("exit", r));

    const gone = await waitFor(() => (claudeProcsUnder(work) === "" ? "gone" : null));
    assert.equal(gone, "gone", "foreground + own background claude must be reaped");
    const own = readJobFile(HOME, ownJobId);
    assert.equal(own.status, "cancelled");
    assert.equal(own.error, "session ended");
    const foreign = readJobFile(HOME, "job-foreign");
    assert.equal(foreign.status, "running", "another session's job must not be touched");
    assert.doesNotThrow(() => process.kill(foreignSleeper.pid, 0), "foreign worker process must still be alive");
  } finally {
    try {
      process.kill(foreignSleeper.pid, "SIGKILL");
    } catch {}
    s.stop();
  }
});

test("signals: SIGINT is ignored (bridge survives terminal interrupts); SIGTERM shuts down and reaps own jobs", async () => {
  const HOME = makeTempHome();
  const s = startServer(fakeClaudeEnv(HOME));
  const sleeper = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
  try {
    await initialized(s);

    // SIGINT must NOT kill the server — a Ctrl+C aimed at the host's turn
    // would otherwise take the whole MCP bridge down for the session.
    s.child.kill("SIGINT");
    await sleep(300);
    const ping = await s.rpc("ping", {});
    assert.deepEqual(ping.result, {}, "server must keep serving after SIGINT");

    // SIGTERM is the host's shutdown signal — exit and reap own jobs.
    writeFakeJob(HOME, "job-sigterm", { pid: sleeper.pid, launcherPid: s.child.pid, startedAt: new Date().toISOString() });
    s.child.kill("SIGTERM");
    await new Promise((r) => s.child.on("exit", r));
    await sleep(300);
    const job = readJobFile(HOME, "job-sigterm");
    assert.equal(job.status, "cancelled");
    assert.equal(job.error, "session ended");
    assert.throws(() => process.kill(sleeper.pid, 0), "the job's process must be gone");
  } finally {
    try {
      process.kill(sleeper.pid, "SIGKILL");
    } catch {}
    s.stop();
  }
});

test("foreground watchdog: time limit returns an error and points to background mode", async () => {
  const HOME = makeTempHome();
  const work = fs.mkdtempSync(path.join(HOME, "wd-"));
  const s = startServer(fakeClaudeEnv(HOME, { CC_PLUGIN_CODEX_FG_TIMEOUT_MS: "1200" }));
  try {
    await initialized(s);
    const r = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "SLEEP_FOREVER", cwd: work } }, 30000);
    assert.equal(r.result.isError, true);
    assert.match(text(r), /foreground time limit/);
    assert.match(text(r), /background=true/);
    if (onLinux) {
      const gone = await waitFor(() => (claudeProcsUnder(work) === "" ? "gone" : null));
      assert.equal(gone, "gone");
    }
  } finally {
    s.stop();
  }
});

test("worker watchdog: background job is terminated and marked timed_out", async () => {
  const HOME = makeTempHome();
  const work = fs.mkdtempSync(path.join(HOME, "wd-"));
  const s = startServer(fakeClaudeEnv(HOME, { CC_PLUGIN_CODEX_WORKER_TIMEOUT_MS: "1500" }));
  try {
    await initialized(s);
    const launch = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "SLEEP_FOREVER", cwd: work, background: true } });
    const jobId = (text(launch).match(/job-[a-f0-9]+/) || [])[0];
    const final = await waitFor(() => {
      const j = readJobFile(HOME, jobId);
      return j.status !== "running" ? j : null;
    }, { timeoutMs: 15000 });
    assert.equal(final?.status, "timed_out");
    const r = await s.rpc("tools/call", { name: "consult_result", arguments: { job_id: jobId } });
    assert.match(text(r), /exceeded the max runtime/);
    if (onLinux) {
      const gone = await waitFor(() => (claudeProcsUnder(work) === "" ? "gone" : null));
      assert.equal(gone, "gone");
    }
  } finally {
    s.stop();
  }
});

test("concurrency cap: live jobs block, stale (dead) jobs do not", async () => {
  const HOME = makeTempHome();
  const s = startServer(fakeClaudeEnv(HOME));
  const sleepers = Array.from({ length: 4 }, () => spawn("sleep", ["120"], { detached: true, stdio: "ignore" }));
  try {
    await initialized(s);
    sleepers.forEach((p, i) => writeFakeJob(HOME, `job-live${i}`, { pid: p.pid, startedAt: new Date().toISOString() }));
    const blocked = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "hi", cwd: HOME, background: true } });
    assert.equal(blocked.result.isError, true);
    assert.match(text(blocked), /Too many background consults/);

    sleepers.forEach((p) => {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {}
    });
    await sleep(300); // let the kernel reap them so the pids read as dead
    const allowed = await s.rpc("tools/call", { name: "consult", arguments: { prompt: "now it fits", cwd: HOME, background: true } });
    assert.match(text(allowed), /Started background consult job/, "dead jobs must be reconciled, not block the cap");
  } finally {
    sleepers.forEach((p) => {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {}
    });
    s.stop();
  }
});
