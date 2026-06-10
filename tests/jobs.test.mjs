// Unit tests for the file-backed job store, including the stale-job
// reconciliation that keeps dead workers from eating the concurrency cap.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { PLUGIN_ROOT, makeTempHome, jobsDir, writeFakeJob, readJobFile } from "./helpers.mjs";

// The lib computes its paths from $HOME at import time — point it at a temp
// home BEFORE importing.
const HOME = makeTempHome();
process.env.HOME = HOME;
const { writeJob, readJob, updateJob, listJobs, pruneJobs, generateJobId } = await import(
  path.join(PLUGIN_ROOT, "scripts", "lib", "jobs.mjs")
);

test("writeJob/readJob roundtrip is atomic (no temp files left behind)", () => {
  const id = generateJobId();
  writeJob({ id, status: "done", startedAt: new Date().toISOString() });
  assert.equal(readJob(id).status, "done");
  const leftovers = fs.readdirSync(jobsDir(HOME)).filter((f) => !f.endsWith(".json"));
  assert.deepEqual(leftovers, []);
  fs.rmSync(path.join(jobsDir(HOME), `${id}.json`));
});

test("updateJob merges a patch over the stored job", () => {
  const id = generateJobId();
  writeJob({ id, status: "running", pid: process.pid, startedAt: new Date().toISOString() });
  updateJob(id, { sessionId: "sess-1" });
  const job = readJob(id);
  assert.equal(job.status, "running");
  assert.equal(job.sessionId, "sess-1");
  fs.rmSync(path.join(jobsDir(HOME), `${id}.json`));
});

test("listJobs sorts newest first", () => {
  writeFakeJob(HOME, "job-old", { status: "done", startedAt: "2020-01-01T00:00:00.000Z" });
  writeFakeJob(HOME, "job-new", { status: "done", startedAt: "2030-01-01T00:00:00.000Z" });
  const ids = listJobs().map((j) => j.id);
  assert.ok(ids.indexOf("job-new") < ids.indexOf("job-old"));
  fs.rmSync(path.join(jobsDir(HOME), "job-old.json"));
  fs.rmSync(path.join(jobsDir(HOME), "job-new.json"));
});

test("reconcile: a running job with a dead pid becomes an error", () => {
  writeFakeJob(HOME, "job-stale", { pid: 999999 });
  const job = listJobs().find((j) => j.id === "job-stale");
  assert.equal(job.status, "error");
  assert.match(job.error, /stale job reconciled/);
  // and it was persisted, not just reported
  assert.equal(readJobFile(HOME, "job-stale").status, "error");
  fs.rmSync(path.join(jobsDir(HOME), "job-stale.json"));
});

test("reconcile: a running job with a live pid is left alone", async () => {
  const sleeper = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  try {
    writeFakeJob(HOME, "job-alive", { pid: sleeper.pid });
    const job = listJobs().find((j) => j.id === "job-alive");
    assert.equal(job.status, "running");
  } finally {
    try {
      process.kill(sleeper.pid, "SIGKILL");
    } catch {}
    fs.rmSync(path.join(jobsDir(HOME), "job-alive.json"));
  }
});

test("reconcile: a fresh pid-less job gets a grace period; an old one does not", () => {
  writeFakeJob(HOME, "job-fresh", { pid: null, startedAt: new Date().toISOString() });
  writeFakeJob(HOME, "job-ancient", { pid: null, startedAt: "2020-01-01T00:00:00.000Z" });
  const byId = Object.fromEntries(listJobs().map((j) => [j.id, j.status]));
  assert.equal(byId["job-fresh"], "running");
  assert.equal(byId["job-ancient"], "error");
  fs.rmSync(path.join(jobsDir(HOME), "job-fresh.json"));
  fs.rmSync(path.join(jobsDir(HOME), "job-ancient.json"));
});

test("pruneJobs keeps the newest N finished jobs and never prunes running ones", () => {
  for (let i = 0; i < 55; i++) {
    writeFakeJob(HOME, `job-prune${String(i).padStart(2, "0")}`, {
      status: "done",
      pid: null,
      startedAt: new Date(Date.now() - i * 1000).toISOString()
    });
  }
  pruneJobs(50);
  let left = fs.readdirSync(jobsDir(HOME)).filter((f) => f.startsWith("job-prune")).length;
  assert.equal(left, 50);

  writeFakeJob(HOME, "job-prunerun", { status: "running", pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" });
  pruneJobs(0);
  assert.ok(fs.existsSync(path.join(jobsDir(HOME), "job-prunerun.json")));
  for (const f of fs.readdirSync(jobsDir(HOME))) if (f.startsWith("job-prune")) fs.rmSync(path.join(jobsDir(HOME), f));
});
