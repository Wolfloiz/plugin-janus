#!/usr/bin/env node
// janus — small client for the Janus bridge. Useful for debugging the plugin
// without the Herdr mod: `janus state`, `janus prompt …`, `janus job …`.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DISCOVERY = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "janus", "bridge.json");

function usage() {
  console.log(`Usage: janus [--discovery FILE] <command> [args]

Commands:
  health                       print bridge pid/version
  state                        sessions + headless jobs
  sessions                     only live sessions
  events [since]               event queue
  prompt <session> <text>      follow-up turn (--steer / --inject)
  cancel <session>             cancel the active turn
  spawn <cwd> <text>           new in-process session (--name NAME)
  job <cwd> <text>             one-shot dsh headless job in a Herdr terminal
  continue <session> <text>    resume a job with --session-id
  notify <title> [body]        post a toast through the Janus mod
  terminal <terminal> [lines]  read a Herdr terminal through the bridge

Environment:
  DSH_HOME                     discovery root (default ~/.dsh)
  JANUS_DISCOVERY              explicit discovery file
`);
}

async function discoveryPath(args) {
  const index = args.indexOf("--discovery");
  if (index !== -1) {
    const value = args[index + 1];
    if (!value) throw new Error("--discovery needs a file path");
    args.splice(index, 2);
    return value;
  }
  return process.env.JANUS_DISCOVERY || DEFAULT_DISCOVERY;
}

function flags(args) {
  const out = { positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--steer") out.mode = "steer";
    else if (value === "--inject") out.mode = "inject";
    else if (value === "--name") out.name = args[++index];
    else if (value === "--level") out.level = args[++index];
    else out.positional.push(value);
  }
  return out;
}

async function connect(path) {
  const record = JSON.parse(await readFile(path, "utf8"));
  if (!record?.url || !record?.token) throw new Error(`invalid discovery file: ${path}`);
  return record;
}

async function call(record, method, path, body) {
  const response = await fetch(`${record.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${record.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) {
    const message = value?.error?.message ?? response.statusText;
    throw new Error(`${response.status}: ${message}`);
  }
  return value;
}

async function main() {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw[0] === "-h" || raw[0] === "--help") {
    usage();
    return;
  }
  const path = await discoveryPath(raw);
  const command = raw.shift();
  const { positional, name, mode, level } = flags(raw);
  const record = await connect(path);

  switch (command) {
    case "health":
      console.log(JSON.stringify(await call(record, "GET", "/v1/health"), null, 2));
      break;
    case "state":
      console.log(JSON.stringify(await call(record, "GET", "/v1/state"), null, 2));
      break;
    case "sessions": {
      const state = await call(record, "GET", "/v1/state");
      console.log(JSON.stringify(state.sessions, null, 2));
      break;
    }
    case "events":
      console.log(JSON.stringify(await call(record, "GET", `/v1/events?since=${Number(positional[0] ?? 0)}`), null, 2));
      break;
    case "prompt":
      console.log(JSON.stringify(await call(record, "POST", "/v1/prompt", {
        session: positional[0],
        text: positional.slice(1).join(" "),
        mode: mode ?? "followup",
      }), null, 2));
      break;
    case "cancel":
      console.log(JSON.stringify(await call(record, "POST", "/v1/cancel", { session: positional[0] }), null, 2));
      break;
    case "spawn":
      console.log(JSON.stringify(await call(record, "POST", "/v1/spawn", {
        cwd: positional[0],
        text: positional.slice(1).join(" "),
        name,
      }), null, 2));
      break;
    case "job":
      console.log(JSON.stringify(await call(record, "POST", "/v1/job", {
        cwd: positional[0],
        text: positional.slice(1).join(" "),
        name,
      }), null, 2));
      break;
    case "continue":
      console.log(JSON.stringify(await call(record, "POST", "/v1/job/continue", {
        session: positional[0],
        text: positional.slice(1).join(" "),
        name,
      }), null, 2));
      break;
    case "notify":
      console.log(JSON.stringify(await call(record, "POST", "/v1/notify", {
        title: positional[0],
        body: positional.slice(1).join(" ") || undefined,
        level: level ?? "info",
      }), null, 2));
      break;
    case "terminal":
      console.log(JSON.stringify(await call(record, "GET", `/v1/terminal?terminal=${encodeURIComponent(positional[0])}&lines=${Number(positional[1] ?? 80)}`), null, 2));
      break;
    default:
      usage();
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`janus: ${error.message}`);
  process.exitCode = 1;
});
