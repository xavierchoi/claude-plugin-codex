import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { PLUGIN_ROOT, startServer, initialized, text, makeTempHome, fakeClaudeEnv, sleep } from "./helpers.mjs";

const HOME = makeTempHome();
const server = startServer(fakeClaudeEnv(HOME));

test.after(() => server.stop());

test("initialize: clamps unknown protocolVersion to the latest supported", async () => {
  const init = await server.rpc("initialize", { protocolVersion: "2099-12-31", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  server.notify("notifications/initialized", {});
});

test("initialize: serverInfo version matches the plugin manifest", async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
  const init = await server.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.serverInfo.name, "claude-code");
  assert.equal(init.result.serverInfo.version, manifest.version);
});

test("initialize: echoes a supported older protocolVersion", async () => {
  const init = await server.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.protocolVersion, "2024-11-05");
});

test("tools/list exposes exactly the six tools", async () => {
  const tl = await server.rpc("tools/list", {});
  assert.deepEqual(
    tl.result.tools.map((t) => t.name).sort(),
    ["consult", "consult_cancel", "consult_result", "consult_status", "review", "setup"]
  );
});

test("ping replies with an empty object, including for id 0", async () => {
  const p = await server.rpc("ping", {});
  assert.deepEqual(p.result, {});
  const p0 = await server.rpcRawId(0, "ping", {});
  assert.deepEqual(p0.result, {});
});

test("malformed JSON lines are tolerated", async () => {
  server.raw("this is not json\n");
  await sleep(100);
  const p = await server.rpc("ping", {});
  assert.deepEqual(p.result, {});
});

test("unknown method → -32601, unknown tool → -32602", async () => {
  const um = await server.rpc("no/such", {});
  assert.equal(um.error.code, -32601);
  const ut = await server.rpc("tools/call", { name: "nope", arguments: {} });
  assert.equal(ut.error.code, -32602);
});

test("consult argument validation is friendly", async () => {
  const noCwd = await server.rpc("tools/call", { name: "consult", arguments: { prompt: "hi" } });
  assert.equal(noCwd.result.isError, true);
  assert.match(text(noCwd), /pass `cwd`/);

  const badCwd = await server.rpc("tools/call", { name: "consult", arguments: { prompt: "hi", cwd: "/no/such/dir/xyz" } });
  assert.equal(badCwd.result.isError, true);
  assert.match(text(badCwd), /not an existing directory/);

  const noPrompt = await server.rpc("tools/call", { name: "consult", arguments: { cwd: "/tmp" } });
  assert.equal(noPrompt.result.isError, true);
  assert.match(text(noPrompt), /prompt/);
});

test("job tools distinguish 'no jobs' from 'unknown id'", async () => {
  const none = await server.rpc("tools/call", { name: "consult_status", arguments: {} });
  assert.match(text(none), /No background consult jobs found/);
  const bogus = await server.rpc("tools/call", { name: "consult_status", arguments: { job_id: "job-doesnotexist" } });
  assert.match(text(bogus), /No job found with id `job-doesnotexist`/);
  const bogusResult = await server.rpc("tools/call", { name: "consult_result", arguments: { job_id: "job-doesnotexist" } });
  assert.match(text(bogusResult), /No job found with id/);
});
