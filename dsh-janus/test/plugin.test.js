import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";

import { apply } from "../lib/index.js";
import { FakeAgent, fakeCtx, tempDiscovery } from "./fixtures.js";

test("plugin registers both tools and starts/clears the bridge", async () => {
  const agents = [new FakeAgent({ id: "session-a", title: "Demo" })];
  const base = fakeCtx(agents);
  const listeners = new Map();
  const tools = [];
  let cleanup = null;
  let resolveEffect;
  const effectDone = new Promise((resolve) => {
    resolveEffect = resolve;
  });

  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect: (fn) => {
      Promise.resolve(fn()).then((value) => {
        cleanup = value;
        resolveEffect();
      });
    },
    on: (name, listener) => {
      listeners.set(name, listener);
      return () => {};
    },
    tools: { register: (definition) => tools.push(definition) },
    agents: base.agents,
    sessions: base.sessions,
    sessionTitle: base.sessionTitle,
    agentDefaultModel: base.agentDefaultModel,
  };

  const discoveryPath = await tempDiscovery();
  apply(ctx, { discoveryPath, port: 0, token: "plugin-test" });
  await effectDone;

  try {
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["janus_dsh", "janus_herdr"]);
    for (const tool of tools) {
      assert.equal(tool.parameters.type, "object");
      assert.ok(tool.parameters.properties.action.enum.length > 0);
      assert.equal(typeof tool.execute, "function");
      assert.equal(typeof tool.output.render, "function");
    }
    const record = JSON.parse(await readFile(discoveryPath, "utf8"));
    assert.equal(record.token, "plugin-test");

    const headers = { authorization: "Bearer plugin-test" };
    const state = await (await fetch(`${record.url}/v1/state`, { headers })).json();
    assert.equal(state.sessions[0].session, "session-a");

    const agent = { session: { id: "session-a", header: { cwd: "/tmp" } }, status: "running" };
    listeners.get("agent/status")({ agent, status: "running" });
    listeners.get("agent/status")({ agent, status: "idle" });
    const events = await (await fetch(`${record.url}/v1/events?since=0`, { headers })).json();
    assert.ok(events.events.some((event) => event.type === "done"));
  } finally {
    if (cleanup) await cleanup();
    await rm(dirname(discoveryPath), { recursive: true, force: true });
  }
  await assert.rejects(() => readFile(discoveryPath, "utf8"), /ENOENT/);
});
