// Terminate a background worker and everything it spawned.
//
// Workers (and foreground claude runs) are launched with `detached: true`,
// which makes each one the leader of its own process group (pgid === pid).
// Signalling the negative pid reaches the whole group — the worker AND the
// `claude` child it spawned — so a cancel never leaves an orphaned Claude
// process burning tokens.
export function terminateProcessTree(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) {
    return false;
  }
  try {
    process.kill(-n, "SIGTERM");
    return true;
  } catch {
    // Group may already be gone; fall back to the single pid.
  }
  try {
    process.kill(n, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

// Escalation for a group that ignored SIGTERM.
export function killProcessTreeHard(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) {
    return false;
  }
  let any = false;
  try {
    process.kill(-n, "SIGKILL");
    any = true;
  } catch {
    // fall through
  }
  try {
    process.kill(n, "SIGKILL");
    any = true;
  } catch {
    // gone
  }
  return any;
}

// Is the process still running? (signal 0 probes without signalling;
// EPERM means "alive but not ours", which still counts as alive.)
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) {
    return false;
  }
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}
