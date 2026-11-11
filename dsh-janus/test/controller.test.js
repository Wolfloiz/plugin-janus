import assert from "node:assert/strict";
import test from "node:test";

import { JanusController } from "../lib/controller.js";
import { FakeAgent, FakeHerdr, fakeCtx } from "./fixtures.js";

function setup({ agents = [] } = {}) {
  const ctx = fakeCtx(agents);
  const herdr = new FakeHerdr();
  const controller = new JanusController({ ctx, config: {}, herdr, logger: console });
  return { ctx, herdr, controller };
}

test("state describes live sessions with title, status, cwd, and model", async () => {
  const agent = new FakeAgent({ id: "session-a", title: "Fix login", status: "running", last: "working on it" });
  const { controller } = setup({ agents: [agent] });
  const state = await controller.state();
  assert.equal(state.ok, true);
  assert.equal(state.sessions.length, 1);
  assert.deepEqual(state.sessions[0], {
    session: "session-a",
    title: "Fix login",
    status: "working",
    cwd: "/tmp",
    model: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: null },
    createdAt: "2023-11-14T22:13:20.000Z",
    last: "working on it",
    spawned: false,
  });
});

test("prompt routes to followup, steer, or inject", () => {
  const agent = new FakeAgent({ id: "session-a" });
  const { controller } = setup({ agents: [agent] });
  controller.prompt({ session: "session-a", text: "next", mode: "followup" });
  controller.prompt({ session: "session-a", text: "focus", mode: "steer" });
  controller.prompt({ session: "session-a", text: "context", mode: "inject" });
  assert.deepEqual(agent.calls.map(([kind]) => kind), ["followup", "steer", "inject"]);
  assert.equal(agent.calls[0][1].content[0].text, "next");
});

test("prompt rejects an unknown session", () => {
  const { controller } = setup();
  assert.throws(() => controller.prompt({ session: "nope", text: "hi" }), /no live DSH session/);
});

test("spawn creates an in-process agent and sends the first prompt", async () => {
  const { controller } = setup();
  const created = await controller.spawn({ cwd: "/tmp", text: "hello", name: "Bridge session" });
  assert.equal(created.ok, true);
  assert.match(created.session, /^session-/);
  const agent = controller.ctx.agents.get(created.session);
  assert.equal(agent.calls[0][0], "followup");
  assert.equal(agent.title, "Bridge session");
  const state = await controller.state();
  assert.equal(state.sessions.find((session) => session.session === created.session)?.spawned, true);
  await controller.stop();
  assert.deepEqual(controller.ctx.agents.disposed, [created.session]);
});

test("job starts a visible headless run and captures the session id", async () => {
  const { controller, herdr } = setup();
  const result = await controller.job({ cwd: "/tmp", text: "run the tests" });
  assert.equal(result.ok, true);
  assert.equal(result.job.session, "session-job-1");
  assert.equal(result.job.terminal, "t99");
  const run = herdr.calls.find(([kind]) => kind === "run")[1];
  assert.deepEqual(run.argv, ["dsh", "headless", "--json", "run the tests"]);
  assert.equal(run.labels["janus.job"], "1");
});

test("jobContinue resumes the same session in a new terminal", async () => {
  const { controller, herdr } = setup();
  const started = await controller.job({ cwd: "/tmp", text: "first" });
  const result = await controller.jobContinue({ session: started.job.session, text: "second" });
  assert.equal(result.ok, true);
  assert.equal(result.job.session, "session-job-1");
  assert.equal(result.job.runs, 2);
  const runs = herdr.calls.filter(([kind]) => kind === "run").map(([, options]) => options.argv);
  assert.deepEqual(runs[1], ["dsh", "headless", "--json", "--session-id", "session-job-1", "second"]);
});

test("destructive Herdr actions require explicit confirmation", async () => {
  const { controller, herdr } = setup();
  await assert.rejects(() => controller.herdrKill({ terminal: "t1" }), /confirm/);
  assert.equal(herdr.calls.some(([kind]) => kind === "killTerminal"), false);
  const result = await controller.herdrKill({ terminal: "t1", confirm: true });
  assert.equal(result.ok, true);
  assert.equal(herdr.calls.filter(([kind]) => kind === "killTerminal").length, 1);
});

test("agent status transitions produce done events", () => {
  const { controller } = setup();
  const session = { id: "session-a", header: { cwd: "/tmp" } };
  const agent = { session, status: "running" };
  controller.onStatus({ agent, status: "running" });
  controller.onStatus({ agent, status: "idle" });
  const events = controller.eventsSince(0).events;
  assert.ok(events.some((event) => event.type === "done" && event.session === "session-a"));
});

test("herdrStatus degrades when the app is unavailable but hc still works", async () => {
  const { controller, herdr } = setup();
  herdr.status = async () => {
    throw new Error("app not running");
  };
  const result = await controller.herdrStatus();
  assert.equal(result.ok, true);
  assert.equal(result.app, null);
  assert.match(result.appError, /app not running/);
  assert.equal(result.terminals.length, 1);
});
