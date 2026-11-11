// Test doubles for the Janus controller and bridge.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class FakeAgent {
  constructor({ id, title = null, status = "idle", cwd = "/tmp", last = null } = {}) {
    this.calls = [];
    this.status = status;
    this.session = {
      id,
      header: { cwd, createdAt: 1_700_000_000_000 },
      seq: 3,
      deriveMessages: () => (last ? [{ role: "assistant", content: [{ type: "text", text: last }] }] : []),
    };
    this.model = { current: () => ({ provider: "deepseek", model: "deepseek-chat" }) };
    this.title = title;
  }

  followup(message) {
    this.calls.push(["followup", message]);
    this.status = "running";
  }

  steer(message) {
    this.calls.push(["steer", message]);
    this.status = "running";
  }

  inject(message) {
    this.calls.push(["inject", message]);
  }

  cancel(cause) {
    this.calls.push(["cancel", cause]);
    this.status = "idle";
  }
}

export class FakeAgents {
  constructor(agents = []) {
    this.agents = new Map(agents.map((agent) => [agent.session.id, agent]));
    this.created = [];
    this.disposed = [];
  }

  list() {
    return [...this.agents.values()];
  }

  get(id) {
    return this.agents.get(id);
  }

  async create(options) {
    const agent = new FakeAgent({ id: options.sessionId, cwd: options.meta?.cwd ?? "/tmp" });
    agent.agentOptions = options.agentOptions;
    this.agents.set(agent.session.id, agent);
    const self = this;
    return {
      agent,
      async dispose() {
        self.disposed.push(agent.session.id);
        self.agents.delete(agent.session.id);
      },
    };
  }
}

export class FakeHerdr {
  constructor() {
    this.calls = [];
    this.terminalsValue = {
      terminals: [
        { address: "t1", agent: "claude", name: null, cwd: "/tmp", state: "live", status: "working", where: "work / 1" },
      ],
    };
    this.readValue = { complete: true, text: '{"type":"session","sessionId":"session-job-1"}\nreading…' };
  }

  async run(options) {
    this.calls.push(["run", options]);
    return { terminal: "t99", tab: "tb1", pane: "p1", name: options.name, cwd: options.cwd, taskSent: Boolean(options.task) };
  }

  async read(terminal, lines) {
    this.calls.push(["read", terminal, lines]);
    return this.readValue;
  }

  async send(terminal, text) {
    this.calls.push(["send", terminal, text]);
  }

  async keys(terminal, keys) {
    this.calls.push(["keys", terminal, keys]);
  }

  async status() {
    return { ok: true, layout: "bercail" };
  }

  async list() {
    return { spaces: [{ id: "sp1", name: "demo", tabs: [] }] };
  }

  async terminals(options) {
    this.calls.push(["terminals", options]);
    return this.terminalsValue;
  }

  async newSpace(options) {
    this.calls.push(["newSpace", options]);
    return { space: "sp2", tab: "tb2", terminal: "t2" };
  }

  async newTab(options) {
    this.calls.push(["newTab", options]);
    return { tab: "tb3", terminal: "t3" };
  }

  async focus(options) {
    this.calls.push(["focus", options]);
    return { ok: true };
  }

  async killTerminal(terminal) {
    this.calls.push(["killTerminal", terminal]);
    return { ok: true };
  }

  async closeTab(id) {
    this.calls.push(["closeTab", id]);
    return { ok: true };
  }

  async closeSpace(id) {
    this.calls.push(["closeSpace", id]);
    return { ok: true };
  }
}

export function fakeCtx(agents = []) {
  const registry = new FakeAgents(agents);
  return {
    agents: registry,
    sessions: {},
    sessionTitle: {
      get: (session) => {
        const agent = registry.get(session.id);
        return agent?.title ? { title: agent.title } : undefined;
      },
      rename: (session, title) => {
        const agent = registry.get(session.id);
        if (agent) agent.title = title;
        return { title };
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }),
    },
    registry,
  };
}

export async function tempDiscovery() {
  const dir = await mkdtemp(join(tmpdir(), "janus-test-"));
  return join(dir, "bridge.json");
}
