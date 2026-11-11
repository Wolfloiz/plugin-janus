// Loopback HTTP bridge between the DSH plugin and the Herdr mod.
// One owner of state, one bearer token, one discovery file with mode 0600.

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  HttpError,
  bearerMatches,
  isoNow,
  json,
  newToken,
  readJson,
} from "./util.js";

const VERSION = 1;

export function defaultDiscoveryPath(config = {}) {
  if (config.discoveryPath) return config.discoveryPath;
  const home = config.dshHome || process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "janus", "bridge.json");
}

function routeError(res, error) {
  if (res.writableEnded) return;
  if (error instanceof HttpError) {
    json(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  json(res, 500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
}

async function handle(req, res, { controller, token, startedAt }) {
  if (!bearerMatches(req.headers.authorization, token)) {
    json(res, 401, { ok: false, error: { code: "unauthorized", message: "missing or invalid bearer token" } });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const known = new Set([
    "/v1/health",
    "/v1/state",
    "/v1/events",
    "/v1/terminal",
    "/v1/prompt",
    "/v1/cancel",
    "/v1/spawn",
    "/v1/job",
    "/v1/job/continue",
    "/v1/notify",
  ]);
  if (!known.has(path)) {
    json(res, 404, { ok: false, error: { code: "not_found", message: `unknown route ${path}` } });
    return;
  }

  if (req.method === "GET" && path === "/v1/health") {
    json(res, 200, { ok: true, version: VERSION, pid: process.pid, startedAt });
    return;
  }

  if (req.method === "GET" && path === "/v1/state") {
    json(res, 200, await controller.state());
    return;
  }

  if (req.method === "GET" && path === "/v1/events") {
    const since = Number(url.searchParams.get("since") ?? "0");
    json(res, 200, controller.eventsSince(Number.isFinite(since) ? since : 0));
    return;
  }

  if (req.method === "GET" && path === "/v1/terminal") {
    const lines = Number(url.searchParams.get("lines") ?? "80");
    json(res, 200, await controller.herdrRead({
      terminal: url.searchParams.get("terminal"),
      lines: Number.isFinite(lines) ? lines : 80,
    }));
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: { code: "method_not_allowed", message: `${req.method} ${path}` } });
    return;
  }

  const body = await readJson(req);
  switch (path) {
    case "/v1/prompt":
      json(res, 200, controller.prompt(body));
      return;
    case "/v1/cancel":
      json(res, 200, controller.cancel(body));
      return;
    case "/v1/spawn":
      json(res, 200, await controller.spawn(body));
      return;
    case "/v1/job":
      json(res, 200, await controller.job(body));
      return;
    case "/v1/job/continue":
      json(res, 200, await controller.jobContinue(body));
      return;
    case "/v1/notify":
      json(res, 200, controller.notify(body));
      return;
    default:
      json(res, 404, { ok: false, error: { code: "not_found", message: `unknown route ${path}` } });
  }
}

export async function startBridge({ controller, config = {}, logger = console } = {}) {
  const token = config.token || newToken();
  const discoveryPath = defaultDiscoveryPath(config);
  const startedAt = isoNow();
  const port = config.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`janus: invalid bridge port ${String(config.port)}`);
  }

  const server = createServer((req, res) => {
    handle(req, res, { controller, token, startedAt }).catch((error) => routeError(res, error));
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const record = {
    version: VERSION,
    name: "janus",
    url,
    token,
    pid: process.pid,
    startedAt,
    discovery: discoveryPath,
  };

  await mkdir(dirname(discoveryPath), { recursive: true, mode: 0o700 });
  try {
    await chmod(dirname(discoveryPath), 0o700);
  } catch {
    // A directory we do not own may reject chmod; the file mode still matters.
  }
  const temporary = `${discoveryPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, discoveryPath);
  try {
    await chmod(discoveryPath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  logger.info?.(`janus: bridge listening on ${url} (${discoveryPath})`);

  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      await new Promise((resolve) => server.close(() => resolve()));
      try {
        const current = JSON.parse(await readFile(discoveryPath, "utf8"));
        if (current?.token === token) await unlink(discoveryPath);
      } catch {
        // Already gone, replaced by another instance, or unreadable.
      }
      logger.info?.("janus: bridge stopped");
    })();
    return closing;
  };

  return { url, token, discoveryPath, close };
}
