// The Janus controller: one place that knows how to read and drive live DSH
// agents, how to launch one-shot headless jobs in Herdr, and how to relay
// Herdr actions. The HTTP bridge and the model-facing tools are thin shells
// around this class.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  HttpError,
  asBool,
  asInt,
  asString,
  asStringArray,
  assertDir,
  delay,
  isoNow,
  messageFor,
  messageText,
  oneOf,
  optString,
  parseSessionId,
  sanitizeName,
  shortId,
  truncate,
} from "./util.js";

const MAX_EVENTS = 300;
const MAX_JOBS = 50;
const PLACES = ["tab", "right", "down", "none"];
const LEVELS = ["info", "success", "warning", "error"];

export class JanusController {
  constructor({ ctx, config = {}, herdr, logger }) {
    this.ctx = ctx;
    this.config = config;
    this.herdr = herdr;
    this.logger = logger ?? console;
    this.version = 1;
    this.startedAt = isoNow();
    this.seq = 0;
    this.events = [];
    this.lastStatus = new Map();
    this.textCache = new Map();
    this.titleCache = new Map();
    this.spawned = new Map();
    this.jobs = new Map();
    this.dshHome = config.dshHome || process.env.DSH_HOME || `${homedir()}/.dsh`;
  }

  // ---------------------------------------------------------------- state

  service(name) {
    const direct = this.ctx?.[name];
    if (direct !== undefined) return direct;
    try {
      return this.ctx?.get?.(name);
    } catch {
      return undefined;
    }
  }

  titleOf(session) {
    try {
      return this.service("sessionTitle")?.get(session)?.title ?? null;
    } catch {
      return null;
    }
  }

  fallbackTitle(session) {
    const id = session?.id;
    if (!id) return null;
    const seq = session.seq;
    const cached = this.titleCache?.get(id);
    if (cached && cached.seq === seq) return cached.title;
    let title = null;
    try {
      const messages = session.deriveMessages();
      for (const message of messages) {
        if (message?.role !== "user") continue;
        const text = messageText(message.content);
        if (text) {
          title = truncate(text.split("\n")[0].trim(), 72);
          break;
        }
      }
    } catch {
      title = null;
    }
    this.titleCache ??= new Map();
    this.titleCache.set(id, { seq, title });
    return title;
  }

  modelOf(agent) {
    try {
      const current = agent.model?.current?.();
      if (!current) return { provider: null, model: null, reasoningEffort: null };
      return {
        provider: current.provider ?? null,
        model: current.model ?? null,
        reasoningEffort: current.reasoningEffort ?? null,
      };
    } catch {
      return { provider: null, model: null, reasoningEffort: null };
    }
  }

  lastAssistantText(session) {
    const id = session?.id;
    if (!id) return null;
    const seq = session.seq;
    const cached = this.textCache.get(id);
    if (cached && cached.seq === seq) return cached.text;
    let text = "";
    try {
      const messages = session.deriveMessages();
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role !== "assistant") continue;
        text = messageText(messages[index].content);
        if (text) break;
      }
    } catch {
      text = "";
    }
    const value = text ? truncate(text, 600) : null;
    this.textCache.set(id, { seq, text: value });
    return value;
  }

  describeAgent(agent) {
    const session = agent.session;
    const model = this.modelOf(agent);
    return {
      session: session.id,
      title: this.titleOf(session) ?? this.fallbackTitle(session),
      status: agent.status === "running" ? "working" : "idle",
      cwd: session.header?.cwd ?? null,
      model,
      createdAt: session.header?.createdAt ? new Date(session.header.createdAt).toISOString() : null,
      last: this.lastAssistantText(session),
      spawned: this.spawned.has(session.id),
    };
  }

  listSessions() {
    try {
      return this.ctx.agents.list().map((agent) => this.describeAgent(agent));
    } catch (error) {
      this.logger.warn?.(`janus: cannot list agents: ${String(error)}`);
      return [];
    }
  }

  publicJob(job) {
    return {
      id: job.id,
      session: job.sessionId,
      terminal: job.terminal,
      tab: job.tab,
      pane: job.pane,
      cwd: job.cwd,
      prompt: job.prompt,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      runs: job.runs,
    };
  }

  listJobs() {
    return [...this.jobs.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, MAX_JOBS)
      .map((job) => this.publicJob(job));
  }

  async state() {
    await this.refreshJobs();
    return {
      ok: true,
      version: this.version,
      seq: this.seq,
      startedAt: this.startedAt,
      host: {
        home: homedir(),
        dshHome: this.dshHome,
        pid: process.pid,
        webUrl: this.config.webUrl || process.env.DSH_WEB_URL || null,
      },
      sessions: this.listSessions(),
      jobs: this.listJobs(),
    };
  }

  async refreshJobs() {
    if (this.jobs.size === 0) return;
    let data;
    try {
      data = await this.herdr.terminals({ all: true });
    } catch {
      return;
    }
    const terminals = Array.isArray(data?.terminals) ? data.terminals : [];
    const byAddress = new Map(terminals.map((terminal) => [terminal.address, terminal]));
    for (const job of this.jobs.values()) {
      const terminal = byAddress.get(job.terminal);
      if (!terminal) {
        if (job.status === "running") {
          job.status = "lost";
          job.updatedAt = isoNow();
        }
        continue;
      }
      if (terminal.state !== "live" && job.status === "running") {
        job.status = "done";
        job.updatedAt = isoNow();
        this.record("job_done", { job: job.id, session: job.sessionId, title: job.prompt });
      }
    }
  }

  // --------------------------------------------------------------- events

  record(type, fields = {}) {
    const event = {
      seq: (this.seq += 1),
      at: isoNow(),
      type,
      ...fields,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return event;
  }

  eventsSince(since) {
    const from = Number.isInteger(since) && since >= 0 ? since : 0;
    return {
      ok: true,
      seq: this.seq,
      events: this.events.filter((event) => event.seq > from),
    };
  }

  onStatus({ agent, status } = {}) {
    const session = agent?.session;
    if (!session) return;
    const id = session.id;
    const previous = this.lastStatus.get(id);
    this.lastStatus.set(id, status);
    if (previous === undefined) return;
    if (status === "running" && previous !== "running") {
      this.record("working", { session: id, title: this.titleOf(session) ?? this.fallbackTitle(session) });
    } else if (status === "idle" && previous === "running") {
      this.record("done", { session: id, title: this.titleOf(session) ?? this.fallbackTitle(session) });
    }
  }

  onCreated({ agent } = {}) {
    const session = agent?.session;
    if (!session) return;
    this.lastStatus.set(session.id, agent.status);
    this.record("created", { session: session.id, title: this.titleOf(session) ?? this.fallbackTitle(session) });
  }

  onDisposed({ agent } = {}) {
    const session = agent?.session;
    if (!session) return;
    this.lastStatus.delete(session.id);
    this.textCache.delete(session.id);
    this.titleCache.delete(session.id);
    this.record("disposed", { session: session.id });
  }

  // ------------------------------------------------------------ DSH actions

  agentOrThrow(sessionId) {
    const agent = this.ctx.agents.get(sessionId);
    if (!agent) throw new HttpError(404, `no live DSH session "${sessionId}"`, "session_not_found");
    return agent;
  }

  prompt(body = {}) {
    const session = asString(body.session, "session", 256);
    const text = asString(body.text, "text", 100_000);
    const mode = body.mode === undefined || body.mode === null
      ? "followup"
      : oneOf(body.mode, ["followup", "steer", "inject"], "mode");
    const agent = this.agentOrThrow(session);
    agent[mode](messageFor(text));
    this.record("prompt", { session, mode });
    return { ok: true, session, mode, status: agent.status };
  }

  cancel(body = {}) {
    const session = asString(body.session, "session", 256);
    const agent = this.agentOrThrow(session);
    agent.cancel({ kind: "user" });
    this.record("cancel", { session });
    return { ok: true, session };
  }

  defaultSelection() {
    let selection = null;
    try {
      selection = this.service("agentDefaultModel")?.currentSelection?.() ?? null;
    } catch {
      selection = null;
    }
    if (!selection?.provider || !selection?.model) {
      if (this.config.provider && this.config.model) {
        selection = {
          provider: this.config.provider,
          model: this.config.model,
          ...(this.config.reasoningEffort ? { reasoningEffort: this.config.reasoningEffort } : {}),
        };
      }
    }
    if (!selection?.provider || !selection?.model) {
      throw new HttpError(500, "no default model selection is available", "no_model");
    }
    const result = { provider: selection.provider, model: selection.model };
    if (selection.reasoningEffort) result.reasoningEffort = selection.reasoningEffort;
    return result;
  }

  async spawn(body = {}) {
    const cwd = await assertDir(body.cwd, "cwd");
    const text = asString(body.text, "text", 100_000);
    const selection = this.defaultSelection();
    const sessionId = `session-${randomUUID()}`;
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: selection,
    });
    this.spawned.set(sessionId, handle);
    if (body.name) {
      try {
        this.service("sessionTitle")?.rename?.(handle.agent.session, asString(body.name, "name", 120));
      } catch {
        // A failed rename does not prevent the session from running.
      }
    }
    handle.agent.followup(messageFor(text));
    this.record("spawn", { session: sessionId, cwd });
    return {
      ok: true,
      session: sessionId,
      cwd,
      status: handle.agent.status,
      model: selection,
    };
  }

  // --------------------------------------------------------- headless jobs

  dshCommand() {
    const configured = this.config.dshPath;
    if (Array.isArray(configured) && configured.length > 0) return configured.map(String);
    if (typeof configured === "string" && configured.trim() !== "") return [configured];
    return ["dsh"];
  }

  async waitForSessionId(terminal, signal) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (signal?.aborted) throw new Error("aborted");
      let read;
      try {
        read = await this.herdr.read(terminal, 140, { signal });
      } catch {
        read = null;
      }
      const found = parseSessionId(read?.text);
      if (found) return found;
      await delay(500, signal);
    }
    return null;
  }

  async job(body = {}) {
    const cwd = await assertDir(body.cwd, "cwd");
    const text = asString(body.text, "text", 100_000);
    const id = `job-${shortId(6)}`;
    const name = sanitizeName(body.name, `janus-${shortId(4)}`);
    const started = await this.herdr.run({
      argv: [...this.dshCommand(), "headless", "--json", text],
      cwd,
      name,
      labels: { "janus.job": "1", "janus.job_id": id },
      place: "tab",
      signal: body.signal,
    });
    const sessionId = await this.waitForSessionId(started.terminal, body.signal);
    const now = isoNow();
    const job = {
      id,
      sessionId,
      terminal: started.terminal,
      tab: started.tab,
      pane: started.pane,
      cwd,
      prompt: truncate(text, 500),
      status: "running",
      createdAt: now,
      updatedAt: now,
      runs: 1,
    };
    this.jobs.set(id, job);
    if (this.jobs.size > MAX_JOBS) {
      const oldest = [...this.jobs.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      if (oldest) this.jobs.delete(oldest.id);
    }
    this.record("job", { job: id, session: sessionId, title: job.prompt });
    return {
      ok: true,
      job: this.publicJob(job),
      note: sessionId ? null : "session id not found yet; read the terminal for details",
    };
  }

  async jobContinue(body = {}) {
    const session = asString(body.session, "session", 256);
    let job = [...this.jobs.values()].find((candidate) => candidate.sessionId === session) ?? null;
    if (!job && body.job) job = this.jobs.get(asString(body.job, "job", 128)) ?? null;
    if (!job) throw new HttpError(404, `no Janus job for session "${session}"`, "job_not_found");
    const text = asString(body.text, "text", 100_000);
    const started = await this.herdr.run({
      argv: [...this.dshCommand(), "headless", "--json", "--session-id", session, text],
      cwd: job.cwd,
      name: sanitizeName(body.name, `janus-${shortId(4)}`),
      labels: { "janus.job": "1", "janus.job_id": job.id },
      place: "tab",
      signal: body.signal,
    });
    const found = await this.waitForSessionId(started.terminal, body.signal);
    job.terminal = started.terminal;
    job.tab = started.tab;
    job.pane = started.pane;
    job.status = "running";
    job.updatedAt = isoNow();
    job.runs = (job.runs ?? 1) + 1;
    if (found && found !== session) {
      job.sessionId = found;
    }
    this.record("job_continue", { job: job.id, session: job.sessionId, title: job.prompt });
    return { ok: true, job: this.publicJob(job) };
  }

  // ---------------------------------------------------------- Herdr actions

  async herdrStatus() {
    const [app, core] = await Promise.allSettled([
      this.herdr.status(),
      this.herdr.terminals({ all: false }),
    ]);
    const terminals = core.status === "fulfilled" && Array.isArray(core.value?.terminals)
      ? core.value.terminals.map((terminal) => ({
        address: terminal.address,
        agent: terminal.agent ?? null,
        name: terminal.name ?? null,
        cwd: terminal.cwd ?? null,
        state: terminal.state ?? null,
        status: terminal.status ?? null,
        where: terminal.where ?? null,
        parent: terminal.parent ?? null,
      }))
      : [];
    return {
      ok: true,
      app: app.status === "fulfilled" ? app.value : null,
      appError: app.status === "rejected" ? String(app.reason?.message ?? app.reason) : null,
      terminals,
      coreError: core.status === "rejected" ? String(core.reason?.message ?? core.reason) : null,
    };
  }

  async herdrList() {
    const value = await this.herdr.list();
    return { ok: true, spaces: Array.isArray(value?.spaces) ? value.spaces : [] };
  }

  async herdrRead(body = {}) {
    const terminal = asString(body.terminal, "terminal", 256);
    const lines = asInt(body.lines, "lines", { min: 0, max: 5000, fallback: 80 });
    const value = await this.herdr.read(terminal, lines);
    return {
      ok: true,
      terminal,
      complete: value?.complete ?? null,
      text: truncate(value?.text ?? "", 40_000),
    };
  }

  async herdrSend(body = {}) {
    const terminal = asString(body.terminal, "terminal", 256);
    const text = asString(body.text, "text", 100_000);
    await this.herdr.send(terminal, text);
    return { ok: true, terminal };
  }

  async herdrKeys(body = {}) {
    const terminal = asString(body.terminal, "terminal", 256);
    const keys = asStringArray(body.keys, "keys", { maxItems: 64, maxLength: 64 });
    await this.herdr.keys(terminal, keys);
    return { ok: true, terminal, keys };
  }

  async herdrRun(body = {}) {
    const argv = asStringArray(body.argv, "argv", { maxItems: 64, maxLength: 20_000 });
    const folder = body.folder === undefined || body.folder === null ? null : await assertDir(body.folder, "folder");
    const place = body.place === undefined || body.place === null
      ? "tab"
      : oneOf(body.place, PLACES, "place");
    const name = sanitizeName(body.name, `janus-${shortId(4)}`);
    const task = optString(body.task, "task", 100_000);
    const started = await this.herdr.run({
      argv,
      cwd: folder,
      name,
      labels: { "janus": "1" },
      place,
      task,
      signal: body.signal,
    });
    return { ok: true, ...started, argv };
  }

  async herdrOpen(body = {}) {
    const kind = oneOf(body.kind ?? "tab", ["space", "tab"], "kind");
    const name = optString(body.name, "name", 120);
    const folder = body.folder === undefined || body.folder === null ? null : await assertDir(body.folder, "folder");
    const argv = body.argv === undefined || body.argv === null
      ? null
      : asStringArray(body.argv, "argv", { maxItems: 64, maxLength: 20_000 });
    const task = optString(body.task, "task", 100_000);
    const space = optString(body.space, "space", 256);
    const result = kind === "space"
      ? await this.herdr.newSpace({ name, folder, argv, task, signal: body.signal })
      : await this.herdr.newTab({ name, folder, argv, task, space, signal: body.signal });
    return { ok: true, kind, result };
  }

  async herdrFocus(body = {}) {
    const id = asString(body.id, "id", 256);
    const inferred = /^sp/.test(id) ? "space" : /^tb/.test(id) ? "tab" : "terminal";
    const kind = body.kind === undefined || body.kind === null
      ? inferred
      : oneOf(body.kind, ["space", "tab", "terminal"], "kind");
    const result = await this.herdr.focus({ kind, id, signal: body.signal });
    return { ok: true, kind, id, result };
  }

  async herdrKill(body = {}) {
    const terminal = asString(body.terminal, "terminal", 256);
    if (!asBool(body.confirm, "confirm")) {
      throw new HttpError(400, "killing a terminal requires `confirm: true`", "confirmation_required");
    }
    await this.herdr.killTerminal(terminal);
    return { ok: true, terminal, action: "killed" };
  }

  async herdrClose(body = {}) {
    const kind = oneOf(body.kind ?? "tab", ["tab", "space"], "kind");
    const id = asString(body.id, "id", 256);
    if (!asBool(body.confirm, "confirm")) {
      throw new HttpError(400, "closing a tab or space requires `confirm: true`", "confirmation_required");
    }
    if (kind === "tab") await this.herdr.closeTab(id);
    else await this.herdr.closeSpace(id);
    return { ok: true, kind, id, action: "closed" };
  }

  notify(body = {}) {
    const title = asString(body.title, "title", 200);
    const message = optString(body.body, "body", 2000);
    const level = body.level === undefined || body.level === null
      ? "info"
      : oneOf(body.level, LEVELS, "level");
    this.record("notice", { title, body: message, level });
    return { ok: true };
  }

  // ------------------------------------------------------------- lifecycle

  async stop() {
    if (this.config.keepSpawnedOnUnload === true) return;
    const handles = [...this.spawned.values()];
    this.spawned.clear();
    await Promise.all(handles.map(async (handle) => {
      try {
        await handle.dispose();
      } catch {
        // Best effort: shutdown must not be blocked by one session.
      }
    }));
  }
}
