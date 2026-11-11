#!/usr/bin/env node
// Development bridge: a fake DSH + fake Herdr behind the real Janus HTTP
// bridge, so the Herdr mod can be built and checked without restarting dsh.
//
//   node scripts/dev-bridge.js --discovery ~/.dsh/janus/bridge.json
//
// The fake sessions answer prompt/spawn calls locally; Herdr actions return
// plausible stub data and never touch the real app.

import { JanusController } from "../dsh-janus/lib/controller.js";
import { startBridge } from "../dsh-janus/lib/bridge.js";
import { FakeAgent, FakeHerdr, fakeCtx } from "../dsh-janus/test/fixtures.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const discovery = arg("discovery");
const port = Number(arg("port", "0"));
const logger = { info: (line) => console.log(line), warn: (line) => console.warn(line), error: (line) => console.error(line) };

const agents = [
  new FakeAgent({ id: "session-dev-1", title: "Janus dev · web", status: "idle", last: "Ready when you are." }),
  new FakeAgent({ id: "session-dev-2", title: "Refactor bridge", status: "running", last: "Checking the event queue…" }),
];
const ctx = fakeCtx(agents);
const herdr = new FakeHerdr();
const controller = new JanusController({ ctx, config: { discoveryPath: discovery }, herdr, logger });

const bridge = await startBridge({
  controller,
  config: { discoveryPath: discovery, port, token: arg("token") },
  logger,
});

console.log(`Janus dev bridge: ${bridge.url}`);
console.log(`Discovery:        ${bridge.discoveryPath}`);
console.log("Fake sessions:    session-dev-1, session-dev-2");

const shutdown = async () => {
  await bridge.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
