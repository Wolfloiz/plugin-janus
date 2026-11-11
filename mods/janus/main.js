// Janus — Herdr side.
//
// Two copies of this mod exist:
//   * the docked strip in the left sidebar (`props().role === "dock"`), which
//     stays loaded and owns status/notifications;
//   * the full window opened with ctrl-shift-j (`props().role === "full"`).
//
// The dock talks to the DSH plugin's loopback bridge through fetch. The token
// comes from ~/.dsh/janus/bridge.json (mode 0600).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  closeOverlay,
  exec,
  focused,
  home,
  nextCommand,
  notify,
  openOverlay,
  props,
  readTextFile,
  run,
  spaces,
  theme,
  window,
} from "herdr";

const POLL_MS = 3000;
const FULL_WIDTH = 560;
const FULL_HEIGHT = 720;
const DOCK_ROWS = 3;

function ago(value) {
  if (!value) return "";
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function statusColor(t, status) {
  if (status === "working" || status === "running") return t.working;
  if (status === "done") return t.done;
  if (status === "blocked" || status === "lost") return t.blocked;
  if (status === "idle") return t.idle;
  return t.dim;
}

function firstLine(text, max = 64) {
  const line = String(text ?? "").split("\n").map((value) => value.trim()).find(Boolean);
  if (!line) return null;
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}

function sessionLabel(session) {
  return session?.title || firstLine(session?.last) || session?.session || "session";
}

function cwdLabel(cwd) {
  if (!cwd) return "";
  const homeDir = home();
  if (cwd === homeDir) return "~";
  if (cwd.startsWith(`${homeDir}/`)) return `~/${cwd.slice(homeDir.length + 1)}`;
  return cwd;
}

function dot(t, color, size = 7) {
  return div().w(size).h(size).rounded(size / 2).bg(color).flex_none();
}

function button(t, id, text, tone, handler, disabled = false) {
  const background = tone === "primary" ? t.solid : t.raised;
  const foreground = tone === "primary" ? t.solid_foreground : tone === "danger" ? t.blocked : t.foreground;
  const border = tone === "primary" ? t.solid : tone === "danger" ? t.blocked : t.input;
  const base = h_flex()
    .id(id)
    .h(26)
    .px(9)
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(border)
    .bg(background)
    .text_color(foreground)
    .text_size(11.5);
  if (disabled) return base.opacity(0.45).child(text);
  return base
    .cursor_pointer()
    .hover((style) => style.opacity(0.86))
    .on_click(handler)
    .child(text);
}

function chip(t, id, text, active, handler) {
  return h_flex()
    .id(id)
    .h(22)
    .px(8)
    .items_center()
    .rounded(5)
    .bg(active ? t.selected : t.background)
    .border_1()
    .border_color(active ? t.accent : t.input)
    .text_color(active ? t.foreground : t.muted)
    .text_size(10.5)
    .cursor_pointer()
    .hover((style) => style.bg(t.hover))
    .on_click(handler)
    .child(text);
}

function sectionLabel(t, text) {
  return div().text_size(10).font_semibold().text_color(t.dim).child(text.toUpperCase());
}

export default class Janus extends View {
  init(_props, cx) {
    // The layout's dock passes { role: "dock" }; an overlay or `mod.open`
    // without props gets the full panel.
    this.role = props()?.role === "dock" ? "dock" : "full";
    this.discoveryPath = `${home()}/.dsh/janus/bridge.json`;
    this.fallbackDiscoveryPath = `${home()}/.config/herdr-app/janus/bridge.json`;
    this.discovery = null;
    this.state = null;
    this.error = null;
    this.lastSeq = 0;
    this.selected = null;
    this.selectedJob = null;
    this.prompt = "";
    this.mode = "followup";
    this.busy = false;
    this.refreshing = false;
    this.showNew = false;
    this.newKind = "web";
    this.newCwdInput = null;
    this.newPromptInput = null;
    this.confirmCancel = null;
    this.handle = cx.focus_handle();

    this.input = InputState.new({ placeholder: "Message the selected DSH session…" });
    this.input.on("change", (_event, cx) => {
      this.prompt = this.input.value();
      cx.notify();
    });
    this.input.on("submit", () => this.send(cx));

    this.refresh(cx);
    cx.timer.every(POLL_MS, (timerCx) => this.refresh(timerCx));

    cx.spawn(async (cx) => {
      for (;;) {
        let command;
        try {
          command = await nextCommand();
        } catch {
          break;
        }
        if (command === "open") this.openFull();
        else if (command === "refresh") this.refresh(cx);
        else if (command === "close") this.close();
      }
    });

    if (this.role === "full") {
      cx.timer.after(250, () => this.input.focus());
    }
  }

  online() {
    return Boolean(this.state);
  }

  async readDiscovery() {
    for (const path of [this.discoveryPath, this.fallbackDiscoveryPath]) {
      try {
        const text = await readTextFile(path);
        if (!text) continue;
        const value = JSON.parse(text);
        if (value?.url && value?.token) return value;
      } catch {
        // Try the next location.
      }
    }
    return null;
  }

  async request(record, method, path, body) {
    const response = await fetch(`${record.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${record.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = "";
      try {
        const value = await response.json();
        detail = value?.error?.message ?? "";
      } catch {
        // Keep the status line.
      }
      throw new Error(`${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return response.json();
  }

  async post(path, body) {
    if (!this.discovery) throw new Error("bridge offline");
    return this.request(this.discovery, "POST", path, body);
  }

  async refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const discovery = await this.readDiscovery();
      if (!discovery) {
        this.discovery = null;
        this.state = null;
        this.error = "DSH plugin is not running (no bridge.json)";
        return;
      }
      this.discovery = discovery;
      const state = await this.request(discovery, "GET", "/v1/state");
      const bridgeKey = `${discovery.url}|${discovery.token}`;
      if (this.bridgeKey !== bridgeKey) {
        this.bridgeKey = bridgeKey;
        this.lastSeq = Number(state.seq ?? 0);
      }
      this.state = state;
      this.error = null;
      if (this.selected && !state.sessions?.some((session) => session.session === this.selected)) {
        this.selected = null;
      }
      if (!this.selected && state.sessions?.length > 0) this.selected = state.sessions[0].session;
      if (this.lastSeq === 0) this.lastSeq = Number(state.seq ?? 0);
      if (this.role === "dock") await this.pollEvents(discovery);
    } catch (error) {
      this.state = null;
      this.error = `DSH bridge: ${error.message}`;
    } finally {
      this.refreshing = false;
      cx.notify();
    }
  }

  async pollEvents(record) {
    try {
      const data = await this.request(record, "GET", `/v1/events?since=${this.lastSeq}`);
      for (const event of data.events ?? []) this.notifyEvent(event);
      this.lastSeq = Number(data.seq ?? this.lastSeq);
    } catch {
      // A failed event poll must not hide a working state fetch.
    }
  }

  labelFor(sessionId) {
    const session = this.state?.sessions?.find((candidate) => candidate.session === sessionId);
    return session ? sessionLabel(session) : null;
  }

  notifyEvent(event) {
    try {
      if (event.type === "notice") {
        notify({ title: event.title ?? "Janus", body: event.body ?? "", level: event.level ?? "info", timeout: 6000 });
      } else if (event.type === "done") {
        notify({
          title: `DSH · ${event.title ?? this.labelFor(event.session)}`,
          body: "Turn finished",
          level: "success",
          timeout: 4500,
        });
      } else if (event.type === "job_done") {
        notify({
          title: `DSH job · ${event.title ?? this.labelFor(event.session) ?? event.job}`,
          body: "Headless run finished",
          level: "success",
          timeout: 4500,
        });
      }
    } catch {
      // The toast mod may be unavailable; events still advance their cursor.
    }
  }

  openFull() {
    openOverlay({
      mod: "janus",
      kind: "window",
      key: "janus",
      width: FULL_WIDTH,
      height: FULL_HEIGHT,
      props: { role: "full" },
    });
  }

  close() {
    if (this.role !== "full") return;
    closeOverlay(props()?.overlay);
  }

  defaultCwd() {
    try {
      return focused()?.cwd
        ?? spaces().find((space) => space.active)?.folder
        ?? home();
    } catch {
      return home();
    }
  }

  openNew(kind, cx) {
    this.showNew = true;
    this.newKind = kind;
    this.error = null;
    this.newCwdInput = InputState.new({ value: this.defaultCwd() });
    this.newPromptInput = InputState.new({ placeholder: "First prompt…" });
    cx.timer.after(250, () => this.newPromptInput?.focus());
    cx.notify();
  }

  async createNew(cx) {
    const cwd = this.newCwdInput?.value().trim();
    const text = this.newPromptInput?.value().trim();
    if (!cwd || !text) {
      this.error = "cwd and prompt are required";
      cx.notify();
      return;
    }
    this.busy = true;
    this.error = null;
    cx.notify();
    try {
      const result = await this.post(this.newKind === "job" ? "/v1/job" : "/v1/spawn", { cwd, text });
      this.showNew = false;
      if (result.session) {
        this.selected = result.session;
        this.selectedJob = null;
      }
      if (result.job) {
        this.selectedJob = result.job;
        this.selected = null;
      }
      await this.refresh(cx);
    } catch (error) {
      this.error = error.message;
    } finally {
      this.busy = false;
      cx.notify();
    }
  }

  async send(cx) {
    const text = this.prompt.trim();
    if (!text || this.busy) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    try {
      if (this.selectedJob) {
        await this.post("/v1/job/continue", { session: this.selectedJob.session, text });
        this.selectedJob = null;
      } else if (this.selected) {
        await this.post("/v1/prompt", { session: this.selected, text, mode: this.mode });
      }
      this.prompt = "";
      this.input.set_value("");
      this.confirmCancel = null;
      await this.refresh(cx);
    } catch (error) {
      this.error = error.message;
    } finally {
      this.busy = false;
      cx.notify();
    }
  }

  async cancelSelected(cx) {
    if (!this.selected) return;
    if (this.confirmCancel !== this.selected) {
      this.confirmCancel = this.selected;
      cx.notify();
      return;
    }
    this.busy = true;
    try {
      await this.post("/v1/cancel", { session: this.selected });
      this.confirmCancel = null;
      await this.refresh(cx);
    } catch (error) {
      this.error = error.message;
    } finally {
      this.busy = false;
      cx.notify();
    }
  }

  openDsh() {
    const url = this.state?.host?.webUrl;
    if (!url) {
      this.error = "the DSH bridge did not report a web URL";
      return;
    }
    const opener = window()?.platform === "macos" ? "open" : "xdg-open";
    exec(opener, [url]).catch(() => {
      this.error = `could not open ${url}`;
    });
  }

  peek(terminal) {
    if (terminal) run("terminal.peek", { terminal });
  }

  // ---------------------------------------------------------------- rendering

  render(cx) {
    const t = theme();
    return this.role === "full" ? this.renderFull(t, cx) : this.renderDock(t, cx);
  }

  renderDock(t, cx) {
    const sessions = this.state?.sessions ?? [];
    const rows = sessions.slice(0, DOCK_ROWS).map((session) =>
      h_flex()
        .id(`janus-dock-${session.session}`)
        .h(22)
        .px(3)
        .gap(6)
        .items_center()
        .rounded(4)
        .hover((style) => style.bg(t.hover))
        .cursor_pointer()
        .on_click(() => {
          this.selected = session.session;
          this.selectedJob = null;
          this.openFull();
        })
        .child(dot(t, statusColor(t, session.status)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.foreground).child(sessionLabel(session)))
        .child(div().text_size(9.5).text_color(statusColor(t, session.status)).child(session.status === "working" ? "run" : "idle")));

    return v_flex()
      .id("janus-dock")
      .size_full()
      .bg(t.chrome)
      .text_color(t.foreground)
      .p(8)
      .gap(4)
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(dot(t, this.online() ? t.working : t.dim))
          .child(div().text_size(10.5).font_semibold().text_color(t.muted).child("JANUS"))
          .child(div().flex_1().text_size(9.5).text_color(t.dim).child(this.online() ? `${sessions.length} DSH` : "offline"))
          .child(
            h_flex()
              .id("janus-dock-open")
              .px(5)
              .py(2)
              .rounded(4)
              .hover((style) => style.bg(t.hover))
              .cursor_pointer()
              .on_click(() => this.openFull())
              .child(div().text_size(9.5).text_color(t.accent).child("open")),
          ),
      )
      .child(
        v_flex()
          .gap(2)
          .children(
            rows.length > 0
              ? rows
              : [div().px(3).py(6).text_size(10).text_color(t.dim).child(this.error ? "DSH offline" : "No live sessions")],
          ),
      )
      .child(div().text_size(9).text_color(t.dim).child(this.error ? "click open · retry" : "ctrl-shift-j"));
  }

  renderFull(t, cx) {
    return v_flex()
      .id("janus-full")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .bg(t.popover)
      .text_color(t.foreground)
      .p(14)
      .gap(9)
      .on_key_down((event, cx) => {
        if (event.key === "escape" && !this.showNew) {
          this.close();
          cx.stop_propagation();
        }
      })
      .child(
        h_flex()
          .items_center()
          .gap(7)
          .child(dot(t, this.online() ? t.working : t.dim, 8))
          .child(div().text_size(15).font_semibold().child("Janus"))
          .child(div().text_size(10.5).text_color(t.dim).child("DSH ↔ Herdr"))
          .child(div().flex_1())
          .child(
            h_flex()
              .id("janus-close")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(10.5)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((style) => style.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child("Esc"),
          ),
      )
      .child(
        h_flex()
          .gap(6)
          .child(button(t, "janus-new", "New session", "normal", () => this.openNew("web", cx), this.busy))
          .child(button(t, "janus-new-job", "New job", "normal", () => this.openNew("job", cx), this.busy))
          .child(button(t, "janus-refresh", "Refresh", "normal", () => this.refresh(cx), this.busy))
          .child(button(t, "janus-open-dsh", "DSH web", "normal", () => this.openDsh(), false)),
      )
      .when(this.showNew, (element) => element.child(this.renderNew(t, cx)))
      .when(Boolean(this.error), (element) =>
        element.child(
          h_flex()
            .p(7)
            .rounded(6)
            .bg(t.raised)
            .border_1()
            .border_color(t.blocked)
            .gap(6)
            .items_center()
            .child(dot(t, t.blocked))
            .child(div().flex_1().text_size(10.5).text_color(t.foreground).child(this.error))
            .child(
              h_flex()
                .id("janus-retry")
                .px(6)
                .py(2)
                .rounded(4)
                .hover((style) => style.bg(t.hover))
                .cursor_pointer()
                .on_click(() => this.refresh(cx))
                .child(div().text_size(10).text_color(t.accent).child("retry")),
            ),
        ),
      )
      .child(this.renderSessions(t, cx))
      .child(this.renderPrompt(t, cx))
      .child(this.renderJobs(t, cx))
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(div().text_size(9.5).text_color(t.dim).child(this.state ? `bridge v${this.state.version ?? "?"} · seq ${this.state.seq ?? 0}` : "bridge offline"))
          .child(div().flex_1())
          .child(div().text_size(9.5).text_color(t.dim).child("janus 0.1")),
      );
  }

  renderSessions(t, cx) {
    const sessions = [...(this.state?.sessions ?? [])].sort((a, b) => {
      const rank = { working: 0, idle: 1 };
      const byStatus = (rank[a.status] ?? 2) - (rank[b.status] ?? 2);
      if (byStatus !== 0) return byStatus;
      return String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""));
    });
    return v_flex()
      .flex_1()
      .min_h(130)
      .gap(4)
      .child(sectionLabel(t, `Sessions · ${sessions.length}`))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .gap(3)
          .children(
            sessions.length > 0
              ? sessions.map((session) => this.renderSessionRow(t, cx, session))
              : [div().p(10).text_size(11).text_color(t.dim).child("No live DSH sessions. Create one above.")],
          ),
      );
  }

  renderSessionRow(t, cx, session) {
    const selected = this.selected === session.session && !this.selectedJob;
    return v_flex()
      .id(`janus-session-${session.session}`)
      .p(7)
      .gap(2)
      .rounded(6)
      .bg(selected ? t.selected : t.raised)
      .border_1()
      .border_color(selected ? t.accent : t.border)
      .cursor_pointer()
      .hover((style) => style.bg(t.hover))
      .on_click(() => {
        this.selected = session.session;
        this.selectedJob = null;
        this.confirmCancel = null;
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .child(dot(t, statusColor(t, session.status)))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().child(sessionLabel(session)))
          .child(div().text_size(9.5).text_color(t.dim).child(ago(session.createdAt)))
          .when(session.spawned, (element) => element.child(div().text_size(9).text_color(t.accent).child("janus"))),
      )
      .child(
        h_flex()
          .gap(8)
          .child(div().flex_1().min_w(0).truncate().text_size(9.5).text_color(t.muted).child(cwdLabel(session.cwd)))
          .child(div().text_size(9.5).text_color(t.dim).child(session.model?.model ?? ""))
          .child(div().text_size(9.5).text_color(statusColor(t, session.status)).child(session.status)),
      )
      .when(Boolean(session.last), (element) =>
        element.child(div().max_h(28).truncate().text_size(10).text_color(t.muted).child(session.last)),
      );
  }

  renderPrompt(t, cx) {
    const canSend = Boolean(this.prompt.trim()) && (Boolean(this.selected) || Boolean(this.selectedJob)) && !this.busy;
    return v_flex()
      .flex_none()
      .gap(5)
      .when(Boolean(this.selectedJob), (element) =>
        element.child(
          h_flex()
            .gap(6)
            .items_center()
            .child(div().flex_1().text_size(10).text_color(t.accent).child(`Continuing job ${this.selectedJob.id} · ${this.selectedJob.session ?? "unknown session"}`))
            .child(
              h_flex()
                .id("janus-clear-job")
                .px(5)
                .py(2)
                .rounded(4)
                .hover((style) => style.bg(t.hover))
                .cursor_pointer()
                .on_click(() => {
                  this.selectedJob = null;
                  cx.notify();
                })
                .child(div().text_size(9.5).text_color(t.dim).child("clear")),
            ),
        ),
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            Input.new(this.input)
              .flex_1()
              .h(34)
              .px(9)
              .rounded(7)
              .border_1()
              .border_color(this.prompt ? t.accent : t.input)
              .bg(t.background)
              .text_size(12)
              .text_color(t.foreground),
          )
          .child(button(t, "janus-send", this.selectedJob ? "Continue" : "Send", "primary", () => this.send(cx), !canSend))
          .child(
            button(
              t,
              "janus-cancel",
              this.selected && this.confirmCancel === this.selected ? "Sure?" : "Cancel",
              "danger",
              () => this.cancelSelected(cx),
              !this.selected || this.busy,
            ),
          ),
      )
      .when(!this.selectedJob, (element) =>
        element.child(
          h_flex()
            .gap(4)
            .child(chip(t, "janus-mode-followup", "Follow up", this.mode === "followup", () => {
              this.mode = "followup";
              cx.notify();
            }))
            .child(chip(t, "janus-mode-steer", "Steer", this.mode === "steer", () => {
              this.mode = "steer";
              cx.notify();
            }))
            .child(chip(t, "janus-mode-inject", "Inject", this.mode === "inject", () => {
              this.mode = "inject";
              cx.notify();
            })),
        ),
      );
  }

  renderJobs(t, cx) {
    const jobs = this.state?.jobs ?? [];
    if (jobs.length === 0) return v_flex().flex_none();
    return v_flex()
      .flex_none()
      .gap(4)
      .child(sectionLabel(t, `Headless jobs · ${jobs.length}`))
      .children(
        jobs.slice(0, 3).map((job) =>
          h_flex()
            .id(`janus-job-${job.id}`)
            .p(6)
            .gap(6)
            .items_center()
            .rounded(6)
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .child(dot(t, statusColor(t, job.status)))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(1)
                .child(div().truncate().text_size(10.5).text_color(t.foreground).child(job.prompt ?? job.id))
                .child(
                  h_flex()
                    .gap(6)
                    .child(div().truncate().text_size(9).text_color(t.dim).child(`${job.status} · ${cwdLabel(job.cwd)}`))
                    .child(div().text_size(9).text_color(t.dim).child(job.session ?? "no session id")),
                ),
            )
            .child(button(t, `janus-job-peek-${job.id}`, "Terminal", "normal", () => this.peek(job.terminal), false))
            .child(
              button(t, `janus-job-continue-${job.id}`, "Continue", "normal", () => {
                this.selectedJob = job;
                this.selected = null;
                this.input.focus();
                cx.notify();
              }, !job.session),
            ),
        ),
      );
  }

  renderNew(t, cx) {
    return v_flex()
      .flex_none()
      .p(10)
      .gap(6)
      .rounded(8)
      .bg(t.raised)
      .border_1()
      .border_color(t.input)
      .child(
        h_flex()
          .gap(5)
          .child(chip(t, "janus-new-web", "Web session", this.newKind === "web", () => {
            this.newKind = "web";
            cx.notify();
          }))
          .child(chip(t, "janus-new-job", "Headless job", this.newKind === "job", () => {
            this.newKind = "job";
            cx.notify();
          })),
      )
      .child(
        Input.new(this.newCwdInput)
          .h(30)
          .px(8)
          .rounded(6)
          .border_1()
          .border_color(t.input)
          .bg(t.background)
          .text_size(11)
          .text_color(t.foreground),
      )
      .child(
        Input.new(this.newPromptInput)
          .h(30)
          .px(8)
          .rounded(6)
          .border_1()
          .border_color(t.input)
          .bg(t.background)
          .text_size(11)
          .text_color(t.foreground),
      )
      .child(
        h_flex()
          .justify_end()
          .gap(6)
          .child(
            button(t, "janus-new-cancel", "Cancel", "normal", () => {
              this.showNew = false;
              cx.notify();
            }),
          )
          .child(button(t, "janus-new-create", this.newKind === "job" ? "Start job" : "Create", "primary", () => this.createNew(cx), this.busy)),
      );
  }
}
