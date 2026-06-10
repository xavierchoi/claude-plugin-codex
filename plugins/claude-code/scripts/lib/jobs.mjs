import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { isPidAlive } from "./process.mjs";

// File-backed state for background consult jobs. Each job is a detached worker,
// so its state must live on disk (not in the server's memory) to survive a
// server restart and to be readable by the status/result/cancel tools.
const JOBS_DIR = path.join(os.homedir(), ".cache", "cc-plugin-codex", "jobs");

// A "running" job whose worker died without writing a final status (SIGKILL,
// reboot, crash) would otherwise stay "running" forever — misleading the
// status tools and permanently eating a concurrency-cap slot. Reconcile such
// jobs to "error" when their pid is gone. Freshly launched jobs may not have
// a pid on disk yet, so they get a grace period instead.
const STALE_PID_GRACE_MS = 60 * 1000;

function reconcileJob(job) {
  if (job?.status !== "running") {
    return job;
  }
  const pid = Number(job.pid);
  if (Number.isFinite(pid) && pid > 1) {
    if (isPidAlive(pid)) {
      return job;
    }
  } else {
    const started = Date.parse(job.startedAt || "");
    const age = Number.isFinite(started) ? Date.now() - started : Infinity;
    if (age < STALE_PID_GRACE_MS) {
      return job;
    }
  }
  return writeJob({
    ...job,
    status: "error",
    completedAt: nowIso(),
    error: "worker process died without reporting a result (stale job reconciled)"
  });
}

export function nowIso() {
  return new Date().toISOString();
}

export function generateJobId() {
  return `job-${crypto.randomBytes(5).toString("hex")}`;
}

function jobFile(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

export function writeJob(job) {
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    // Write to a non-".json" temp name then rename, so a partial write is never
    // picked up by listJobs() and the swap is atomic.
    const tmp = path.join(JOBS_DIR, `.${job.id}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
    fs.renameSync(tmp, jobFile(job.id));
  } catch {
    // best effort
  }
  return job;
}

export function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(id), "utf8"));
  } catch {
    return null;
  }
}

export function updateJob(id, patch) {
  const current = readJob(id) ?? { id };
  return writeJob({ ...current, ...patch });
}

export function listJobs() {
  let names = [];
  try {
    names = fs.readdirSync(JOBS_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names) {
    try {
      jobs.push(reconcileJob(JSON.parse(fs.readFileSync(path.join(JOBS_DIR, name), "utf8"))));
    } catch {
      // skip corrupt/partial files
    }
  }
  // Newest first.
  jobs.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
  return jobs;
}

// Keep the job store bounded: drop the oldest finished jobs (and their logs)
// beyond `keep`. Running jobs are never pruned.
export function pruneJobs(keep = 50) {
  try {
    for (const job of listJobs().slice(keep)) {
      if (job.status === "running") {
        continue;
      }
      try {
        fs.rmSync(jobFile(job.id), { force: true });
      } catch {
        // best effort
      }
      if (job.logFile) {
        try {
          fs.rmSync(job.logFile, { force: true });
        } catch {
          // best effort
        }
      }
    }
  } catch {
    // best effort
  }
}
