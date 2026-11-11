// Small shared helpers for the Janus DSH plugin.
// No DeepSeek Harness imports here: the package stays self-contained so it can be
// symlinked into a profile without a build step or a node_modules copy.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export class HttpError extends Error {
  constructor(status, message, code = "bad_request") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function isoNow() {
  return new Date().toISOString();
}

export function shortId(bytes = 5) {
  return randomBytes(bytes).toString("hex");
}

export function newToken() {
  return randomBytes(32).toString("hex");
}

export function bearerMatches(header, token) {
  const expected = `Bearer ${token}`;
  if (typeof header !== "string" || header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

export function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export async function readJson(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`, "body_too_large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body must be valid JSON", "invalid_json");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "request body must be a JSON object", "invalid_body");
  }
  return value;
}

export function asString(value, name, max = 20_000) {
  if (typeof value !== "string") throw new HttpError(400, `\`${name}\` must be a string`);
  if (value.length === 0) throw new HttpError(400, `\`${name}\` must not be empty`);
  if (value.length > max) throw new HttpError(400, `\`${name}\` exceeds ${max} characters`);
  return value;
}

export function optString(value, name, max = 20_000) {
  if (value === undefined || value === null) return null;
  return asString(value, name, max);
}

export function asBool(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new HttpError(400, `\`${name}\` must be a boolean`);
  return value;
}

export function asInt(value, name, { min = 0, max = 100_000, fallback } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `\`${name}\` is required`);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `\`${name}\` must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new HttpError(400, `\`${name}\` must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

export function asStringArray(value, name, { maxItems = 64, maxLength = 20_000 } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, `\`${name}\` must be a non-empty array of strings`);
  }
  if (value.length > maxItems) throw new HttpError(400, `\`${name}\` has more than ${maxItems} items`);
  return value.map((item, index) => asString(item, `${name}[${index}]`, maxLength));
}

export async function assertDir(value, name = "cwd") {
  const path = asString(value, name, 4096);
  if (!isAbsolute(path)) throw new HttpError(400, `\`${name}\` must be an absolute path`);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new HttpError(400, `\`${name}\` does not exist: ${path}`);
  }
  if (!info.isDirectory()) throw new HttpError(400, `\`${name}\` is not a directory: ${path}`);
  return path;
}

export function sanitizeName(value, fallback) {
  const raw = (value ?? fallback ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = raw || `janus-${shortId()}`;
  return name.slice(0, 32);
}

export function parseSessionId(text) {
  const match = String(text ?? "").match(/"sessionId"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

export function truncate(text, max = 2000) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function messageFor(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

export function messageText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
