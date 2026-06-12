import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Plugin-level user settings. One small JSON file:
//   { "verify": "auto-only" | "safe" | "all",   // verify command policy
//     "model":  "sonnet" | "claude-…",          // default model for consults
//     "effort": "low" | "medium" | "high" | "xhigh" | "max" }
// Per-call tool arguments always win over these defaults; Claude's own
// configured default applies when neither is set.
export const SETTINGS_FILE =
  process.env.CC_PLUGIN_CODEX_SETTINGS ||
  path.join(os.homedir(), ".config", "cc-plugin-codex", "settings.json");

export function loadSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return settings && typeof settings === "object" ? settings : {};
  } catch {
    return {};
  }
}
