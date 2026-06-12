import { execFile } from "node:child_process";

// Collect the changes to review, server-side (no approval gate, no shell —
// args go straight to execFile). Used by the `review` tool.
const MAX_PATCH_CHARS = 150000;
const MAX_BUFFER = 32 * 1024 * 1024;

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: MAX_BUFFER, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout ?? "", stderr: (stderr ?? "").trim() });
    });
  });
}

/**
 * Gather a reviewable diff for `cwd`.
 * - With `base` (a ref like "main"): changes since the merge-base of base and
 *   HEAD — the usual "review my branch" view, including uncommitted work.
 * - Without: uncommitted changes (staged + unstaged) against HEAD.
 * Untracked files are listed alongside so they aren't silently ignored.
 *
 * Resolves { stat, patch, untracked, truncated, base } on success,
 * { error } when there is nothing usable (not a repo, bad base, …),
 * { empty: true } when the tree is clean.
 */
export async function collectDiff(cwd, base = null) {
  const inRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inRepo.ok || inRepo.stdout.trim() !== "true") {
    return { error: "this directory is not inside a git repository (or git is not installed), so there is no diff to review" };
  }

  let target = "HEAD";
  if (base) {
    const mergeBase = await git(cwd, ["merge-base", base, "HEAD"]);
    if (!mergeBase.ok) {
      return { error: `could not resolve base \`${base}\`: ${mergeBase.stderr || "unknown ref"}` };
    }
    target = mergeBase.stdout.trim();
  }

  let stat = await git(cwd, ["diff", "--stat", target]);
  let patch = await git(cwd, ["diff", target]);
  if (!patch.ok && !base) {
    // e.g. a fresh repository with no HEAD yet — fall back to the index diff
    stat = await git(cwd, ["diff", "--stat", "--cached"]);
    patch = await git(cwd, ["diff", "--cached"]);
  }
  if (!patch.ok) {
    return { error: `git diff failed: ${patch.stderr || "unknown error"}` };
  }

  const untrackedRes = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const untracked = untrackedRes.ok ? untrackedRes.stdout.split("\n").filter(Boolean) : [];

  if (!patch.stdout.trim() && untracked.length === 0) {
    return { empty: true, base: base ?? null };
  }

  let patchText = patch.stdout;
  let truncated = false;
  if (patchText.length > MAX_PATCH_CHARS) {
    patchText = patchText.slice(0, MAX_PATCH_CHARS);
    truncated = true;
  }

  return {
    stat: stat.ok ? stat.stdout.trim() : "",
    patch: patchText,
    untracked,
    truncated,
    base: base ?? null
  };
}
