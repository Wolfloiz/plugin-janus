import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";

import { startBridge } from "../lib/bridge.js";
import { JanusController } from "../lib/controller.js";
import { FakeAgent, FakeHerdr, fakeCtx, tempDiscovery } from "./fixtures.js";

async function boot() {
  const ctx = fakeCtx([new FakeAgent({ id: "session-a", title: "Demo" })]);
  const herdr = new FakeHerdr();
  const controller = new JanusController({ ctx, config: {}, herdr, logger: console });
  const discoveryPath = await tempDiscovery();
  const bridge = await startBridge({
    controller,
    config: { discoveryPath, port: 0, token: "test-token" },
    logger: { info() {} },
  });
  return { bridge, controller, discoveryPath };
}

test("bridge requires the bearer token", async () => {
  const { bridge, discoveryPath } = await boot();
  try {
    const response = await fetch(`${bridge.url}/v1/state`);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, "unauthorized");
  } finally {
    await bridge.close();
    await rm(dirname(discoveryPath), { recursive: true, force: true });
  }
});

test("discovery file is private and contains the bridge facts", async () => {
  const { bridge, discoveryPath } = await boot();
  try {
    const info = await stat(discoveryPath);
    assert.equal(info.mode & 0o777, 0o600);
    const record = JSON.parse(await readFile(discoveryPath, "utf8"));
    assert.equal(record.url, bridge.url);
    assert.equal(record.token, "test-token");
    assert.equal(record.pid, process.pid);
  } finally {
    await bridge.close();
    await rm(dirname(discoveryPath), { recursive: true, force: true });
  }
});

test("state and events answer with the controller payload", async () => {
  const { bridge, controller, discoveryPath } = await boot();
  const headers = { authorization: "Bearer test-token" };
  try {
    controller.record("notice", { title: "hello", body: null, level: "info" });
    const state = await (await fetch(`${bridge.url}/v1/state`, { headers })).json();
    assert.equal(state.ok, true);
    assert.equal(state.sessions[0].session, "session-a");
    const events = await (await fetch(`${bridge.url}/v1/events?since=0`, { headers })).json();
    assert.equal(events.events[0].type, "notice");
  } finally {
    await bridge.close();
    await rm(dirname(discoveryPath), { recursive: true, force: true });
  }
});

test("prompt and terminal routes validate their input", async () => {
  const { bridge, discoveryPath } = await boot();
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  try {
    const ok = await fetch(`${bridge.url}/v1/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ session: "session-a", text: "hello" }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).mode, "followup");

    const missing = await fetch(`${bridge.url}/v1/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ session: "session-a" }),
    });
    assert.equal(missing.status, 400);

    const unknown = await fetch(`${bridge.url}/v1/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ session: "nope", text: "hello" }),
    });
    assert.equal(unknown.status, 404);

    const terminal = await (await fetch(`${bridge.url}/v1/terminal?terminal=t1&lines=10`, { headers })).json();
    assert.equal(terminal.ok, true);
    assert.match(terminal.text, /session-job-1/);
  } finally {
    await bridge.close();
    await rm(dirname(discoveryPath), { recursive: true, force: true });
  }
});

test("invalid JSON and unknown routes fail cleanly", async () => {
  const { bridge, discoveryPath } = await boot();
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  try {
    const invalid = await fetch(`${bridge.url}/v1/prompt`, { method: "POST", headers, body: "{" });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "invalid_json");

    const unknown = await fetch(`${bridge.url}/v1/nope`, { headers });
    assert.equal(unknown.status, 404);
  } finally {
    await bridge.close();
    await rm(dirname(discoveryPath), { recursive: true, force: true });
  }
});

test("closing the bridge removes its discovery file", async () => {
  const { bridge, discoveryPath } = await boot();
  await bridge.close();
  await assert.rejects(() => stat(discoveryPath), /ENOENT/);
  await rm(dirname(discoveryPath), { recursive: true, force: true });
});
