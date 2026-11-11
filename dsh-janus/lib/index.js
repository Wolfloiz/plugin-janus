// Janus: a DeepSeek Harness plugin that connects the harness to Herdr.
//
// Responsibilities:
//   * register the model-facing janus_herdr / janus_dsh tools;
//   * run a loopback HTTP bridge for the Herdr mod;
//   * translate agent lifecycle events into a small event queue.
//
// The package deliberately imports only Node built-ins, so a profile can load
// it from a symlink without a build step.

import { startBridge } from "./bridge.js";
import { JanusController } from "./controller.js";
import { HerdrCli } from "./herdr.js";
import { makeDshTool, makeHerdrTool } from "./tools.js";

export const name = "janus";
export const inject = ["tools", "agents", "sessions", "sessionTitle", "agentDefaultModel"];

export function apply(ctx, config = {}) {
  const log = typeof ctx.logger === "function" ? ctx.logger("janus") : console;
  const herdr = new HerdrCli({
    hcPath: config.hcPath,
    herdrAppPath: config.herdrAppPath,
    timeoutMs: config.cliTimeoutMs,
    logger: log,
  });
  const controller = new JanusController({ ctx, config, herdr, logger: log });
  let activeBridge = null;

  ctx.effect(async () => {
    try {
      activeBridge = await startBridge({ controller, config, logger: log });
    } catch (error) {
      log.error?.(`janus: bridge did not start: ${String(error?.message ?? error)}`);
      return () => {};
    }
    return async () => {
      await controller.stop();
      await activeBridge?.close();
      activeBridge = null;
    };
  });

  ctx.on("agent/status", (payload) => controller.onStatus(payload));
  ctx.on("agent/created", (payload) => {
    controller.onCreated(payload);
  });
  ctx.on("agent/disposed", (payload) => controller.onDisposed(payload));

  ctx.tools.register(makeHerdrTool(controller));
  ctx.tools.register(makeDshTool(controller));
}
