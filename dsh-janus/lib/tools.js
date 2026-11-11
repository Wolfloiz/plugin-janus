// Model-facing tools. These are plain ToolDefinition objects, so this package
// does not need to import any @deepseek-ai package at runtime.

import { HttpError, truncate } from "./util.js";

const HERDR_ACTIONS = [
  "status",
  "list",
  "read",
  "send",
  "keys",
  "run",
  "open",
  "focus",
  "notify",
  "kill",
  "close",
];
const DSH_ACTIONS = ["sessions", "prompt", "cancel", "spawn", "job", "job_continue", "notify"];

function parameters(actions) {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: actions, description: "The operation to perform." },
      terminal: { type: "string", description: "Herdr terminal address, e.g. t7 or machine/t7." },
      text: { type: "string", description: "Prompt or text to type." },
      keys: { type: "array", items: { type: "string" }, description: "Named keys: enter, esc, up, ctrl+c, ..." },
      lines: { type: "integer", minimum: 0, maximum: 5000, description: "History lines for read (default 80)." },
      argv: { type: "array", items: { type: "string" }, description: "Program and arguments to start." },
      folder: { type: "string", description: "Absolute working directory." },
      name: { type: "string", description: "Terminal, tab, space, or session name." },
      task: { type: "string", description: "First message to send after starting." },
      place: { type: "string", enum: ["tab", "right", "down", "none"], description: "Where to show a new terminal." },
      kind: { type: "string", enum: ["space", "tab", "terminal"], description: "Target kind for focus/open/close." },
      id: { type: "string", description: "Space/tab/terminal id for focus or close." },
      space: { type: "string", description: "Space id for a new tab." },
      confirm: { type: "boolean", description: "Required true for kill/close." },
      title: { type: "string", description: "Notification title." },
      body: { type: "string", description: "Notification body." },
      level: { type: "string", enum: ["info", "success", "warning", "error"], description: "Notification level." },
      mode: { type: "string", enum: ["followup", "steer", "inject"], description: "How to deliver a DSH prompt." },
      session: { type: "string", description: "Live DSH session id." },
      cwd: { type: "string", description: "Absolute working directory for a new DSH session or job." },
      job: { type: "string", description: "Janus job id (for job_continue when the session is unknown)." },
    },
    required: ["action"],
    additionalProperties: false,
  };
}

function output() {
  return {
    schema: { type: "object", properties: {}, additionalProperties: true },
    render(_args, value) {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return [{ type: "text", text: truncate(text, 40_000) }];
    },
  };
}

function tool({ name, description, actions, timeoutMs, execute }) {
  return {
    name,
    description,
    parameters: parameters(actions),
    output: output(),
    timeoutMs,
    async execute(args, exec) {
      return execute(args ?? {}, exec);
    },
  };
}

function dispatchError(action) {
  return new HttpError(400, `unknown action "${action}"`, "unknown_action");
}

export function makeHerdrTool(controller) {
  return tool({
    name: "janus_herdr",
    description:
      "Inspect and control the Herdr desktop app and its herdr-core terminals. " +
      "Actions: status (app + terminals), list (spaces/tabs/terminals), read (terminal screen), " +
      "send (paste text and press Enter), keys (named keys), run (start a program in a new terminal), " +
      "open (new space/tab with an agent and optional task), focus, notify (Herdr toast through the Janus mod), " +
      "kill/close (destructive; require confirm:true). " +
      "Use `run` with argv [\"claude\"] or [\"codex\"] to start an agent, and `task` to send its first message. " +
      "IDs look like sp…, tb…, t…; `list` shows them.",
    actions: HERDR_ACTIONS,
    timeoutMs: 120_000,
    async execute(args, exec) {
      const signal = exec?.signal;
      switch (args.action) {
        case "status":
          return controller.herdrStatus();
        case "list":
          return controller.herdrList();
        case "read":
          return controller.herdrRead(args);
        case "send":
          return controller.herdrSend(args);
        case "keys":
          return controller.herdrKeys(args);
        case "run":
          return controller.herdrRun({ ...args, signal });
        case "open":
          return controller.herdrOpen({ ...args, signal });
        case "focus":
          return controller.herdrFocus({ ...args, signal });
        case "notify":
          return controller.notify(args);
        case "kill":
          return controller.herdrKill(args);
        case "close":
          return controller.herdrClose(args);
        default:
          throw dispatchError(args.action);
      }
    },
  });
}

export function makeDshTool(controller) {
  return tool({
    name: "janus_dsh",
    description:
      "Inspect and drive other live DeepSeek Harness sessions in this process, spawn a new in-process " +
      "session, or launch a one-shot `dsh headless` job in a Herdr terminal. " +
      "Actions: sessions, prompt (followup/steer/inject), cancel, spawn, job, job_continue, notify. " +
      "`spawn` creates a persistent session that appears in the DSH web UI; `job` opens a visible Herdr " +
      "terminal and records the headless session id so `job_continue` can resume it. " +
      "Prefer `sessions` before `prompt` to pick the right session id.",
    actions: DSH_ACTIONS,
    timeoutMs: 180_000,
    async execute(args, exec) {
      const signal = exec?.signal;
      switch (args.action) {
        case "sessions":
          return controller.state();
        case "prompt":
          return controller.prompt(args);
        case "cancel":
          return controller.cancel(args);
        case "spawn":
          return controller.spawn(args);
        case "job":
          return controller.job({ ...args, signal });
        case "job_continue":
          return controller.jobContinue({ ...args, signal });
        case "notify":
          return controller.notify(args);
        default:
          throw dispatchError(args.action);
      }
    },
  });
}
