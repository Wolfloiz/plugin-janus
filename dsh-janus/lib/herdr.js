// Thin, JSON-first wrapper around `herdr-app` (the window) and `hc` (herdr-core).
// Everything uses execFile with an argument array: no shell interpolation.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { delay } from "./util.js";

const execFileAsync = promisify(execFile);

function cleanArgs(args) {
  return args.filter((value) => value !== undefined && value !== null).map((value) => String(value));
}

function parseOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function doArgs(args) {
  const out = [];
  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined || value === null) continue;
    out.push(`--${key}`);
    if (typeof value === "boolean") out.push(value ? "true" : "false");
    else if (typeof value === "object") out.push(JSON.stringify(value));
    else out.push(String(value));
  }
  return out;
}

export class HerdrCli {
  constructor(options = {}) {
    this.hcPath = options.hcPath || "hc";
    this.herdrAppPath = options.herdrAppPath || "herdr-app";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.env = options.env ?? process.env;
    this.logger = options.logger ?? null;
  }

  async execFile(bin, args, options = {}) {
    const label = `${bin} ${args[0] ?? ""}`.trim();
    try {
      const result = await execFileAsync(bin, cleanArgs(args), {
        cwd: options.cwd,
        env: { ...this.env, ...(options.env ?? {}) },
        timeout: options.timeoutMs ?? this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        signal: options.signal,
        encoding: "utf8",
      });
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: 0 };
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`${label} aborted`);
      const code = error?.code ?? error?.exitCode;
      const stderr = String(error?.stderr ?? "").trim();
      const stdout = String(error?.stdout ?? "").trim();
      const detail = stderr || stdout || error?.message || "unknown error";
      throw new Error(`${label} failed${code !== undefined ? ` (exit ${code})` : ""}: ${detail}`);
    }
  }

  async hc(args, options = {}) {
    const result = await this.execFile(this.hcPath, args, options);
    return parseOutput(result.stdout);
  }

  async app(args, options = {}) {
    const result = await this.execFile(this.herdrAppPath, args, options);
    return parseOutput(result.stdout);
  }

  async do(command, args = {}, options = {}) {
    const value = await this.app(["do", command, ...doArgs(args)], options);
    if (value && typeof value === "object" && typeof value.error === "string") {
      throw new Error(`${command}: ${value.error}`);
    }
    return value;
  }

  async status(options = {}) {
    return this.app(["status"], options);
  }

  async list(options = {}) {
    return this.app(["ls"], options);
  }

  async terminals({ all = false, labels = [], signal } = {}) {
    const args = ["ls", "--json"];
    if (all) args.push("--all");
    for (const [key, value] of Object.entries(labels ?? {})) args.push("--label", `${key}=${value}`);
    return this.hc(args, { signal });
  }

  async getTerminal(terminal, options = {}) {
    return this.hc(["get", "--json", terminal], options);
  }

  async read(terminal, lines = 80, options = {}) {
    return this.hc(["read", "--json", terminal, "--lines", String(lines)], options);
  }

  async send(terminal, text, options = {}) {
    return this.hc(["send", "--json", terminal, text], options);
  }

  async keys(terminal, keys, options = {}) {
    return this.hc(["keys", "--json", terminal, ...keys], options);
  }

  async wait(terminal, { timeout, signal } = {}) {
    const args = ["wait", terminal, "--json"];
    if (timeout !== undefined) args.push("--timeout", String(timeout));
    return this.hc(args, { signal });
  }

  /**
   * Start a program in a new herdr-core terminal (and, when `place` is not
   * "none", show it in a pane). Returns the terminal and where it landed.
   */
  async run({ argv, cwd, name, labels, place = "tab", task, signal } = {}) {
    const args = ["run", "--bg", "--json", "--name", name, "--no-parent"];
    if (cwd) args.push("--cwd", cwd);
    for (const [key, value] of Object.entries(labels ?? {})) args.push("--label", `${key}=${value}`);
    args.push("--", ...argv);
    const started = await this.hc(args, { signal, timeoutMs: 30_000 });
    const terminal = started?.address ?? started?.terminal ?? null;
    if (!terminal) throw new Error("hc run returned no terminal address");
    let placed = null;
    let placeError = null;
    if (place && place !== "none") {
      // The app may not have seen the new core terminal yet; retry briefly.
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try {
          placed = await this.do("terminal.keep", { terminal, place }, { signal });
          placeError = null;
          break;
        } catch (error) {
          placeError = error.message;
          if (!/no running terminal/i.test(error.message)) break;
          await delay(100, signal);
        }
      }
    }
    let taskSent = false;
    let taskError = null;
    if (task) {
      try {
        await this.send(terminal, task, { signal });
        taskSent = true;
      } catch (error) {
        taskError = error.message;
      }
    }
    return {
      terminal,
      tab: placed?.tab ?? null,
      pane: placed?.pane ?? null,
      name: started?.name ?? name ?? null,
      cwd: started?.cwd ?? cwd ?? null,
      taskSent,
      placeError,
      taskError,
    };
  }

  async newSpace({ name, folder, argv, task, machine, signal } = {}) {
    return this.do("space.new", { name, folder, argv, task, machine }, { signal });
  }

  async newTab({ name, folder, argv, task, space, signal } = {}) {
    return this.do("tab.new", { name, folder, argv, task, space }, { signal });
  }

  async focus({ kind, id, signal } = {}) {
    if (kind === "space") return this.do("space.select", { id }, { signal });
    if (kind === "tab") return this.do("tab.select", { id }, { signal });
    return this.do("pane.focus", { terminal: id }, { signal });
  }

  async killTerminal(terminal, options = {}) {
    try {
      return await this.do("terminal.kill", { terminal }, options);
    } catch (error) {
      // A finished terminal has no program to kill; remove it instead.
      if (/no running terminal/i.test(error.message)) {
        return this.hc(["rm", terminal], options);
      }
      throw error;
    }
  }

  async closeTab(id, options = {}) {
    return this.do("tab.close", { id, confirmed: true }, options);
  }

  async closeSpace(id, options = {}) {
    return this.do("space.close", { id, confirmed: true }, options);
  }
}

export { parseOutput };
