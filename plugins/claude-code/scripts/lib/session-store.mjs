import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Remember the last Claude session id per working directory so `resume: true`
// can continue the most recent conversation. Best-effort: any failure here is
// non-fatal and simply means a fresh session next time.
const STORE_DIR = path.join(os.homedir(), ".cache", "cc-plugin-codex");
const STORE_FILE = path.join(STORE_DIR, "sessions.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  } catch {
    // Best effort — losing the resume hint is acceptable.
  }
}

function keyFor(cwd) {
  return crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 16);
}

export function getLastSession(cwd) {
  return load()[keyFor(cwd)]?.sessionId ?? null;
}

export function setLastSession(cwd, sessionId) {
  if (!sessionId) {
    return;
  }
  const data = load();
  data[keyFor(cwd)] = {
    sessionId,
    cwd: path.resolve(cwd),
    updatedAt: new Date().toISOString()
  };
  save(data);
}
