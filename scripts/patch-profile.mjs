#!/usr/bin/env node
// Insert or remove the Janus rows in a DSH profile patch file.
//
//   node scripts/patch-profile.mjs <cordis.patch.yml> <marker> web <discoveryPath>
//   node scripts/patch-profile.mjs <cordis.patch.yml> <marker> headless
//   node scripts/patch-profile.mjs <cordis.patch.yml> <marker> remove
//
// The patch file is a YAML sequence. Janus's rows live between two comment
// markers, so a re-run replaces exactly its own block and leaves user rows alone.

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isoNow } from "../dsh-janus/lib/util.js";

function blockFor(mode, discoveryPath) {
  if (mode === "web") {
    return [
      "# >>> janus",
      "- insert:",
      "    - id: janus",
      "      name: dsh-janus",
      "      config:",
      `        discoveryPath: ${JSON.stringify(discoveryPath)}`,
      `        webUrl: ${JSON.stringify(process.env.DSH_WEB_URL || "http://127.0.0.1:3080")}`,
      '        hcPath: "hc"',
      '        herdrAppPath: "herdr-app"',
      '        dshPath: "dsh"',
      '        provider: "deepseek-account"',
      '        model: "deepseek-flash"',
      '        reasoningEffort: "high"',
      "# <<< janus",
    ].join("\n");
  }
  if (mode === "headless") {
    return [
      "# >>> janus-auth",
      "# Let `dsh headless` use the sign-in saved by the DSH web app.",
      "- id: credentials",
      "  disabled: false",
      "- id: authorization",
      "  disabled: false",
      "- id: deepseek-account",
      "  disabled: false",
      "- id: agent-default-model",
      "  config:",
      "    provider: deepseek-account",
      "    model: deepseek-flash",
      "    reasoningEffort: high",
      "# <<< janus-auth",
    ].join("\n");
  }
  throw new Error(`unknown mode: ${mode}`);
}

function markerNames(marker) {
  return { start: `# >>> ${marker}`, end: `# <<< ${marker}` };
}

function stripBlock(text, marker) {
  const { start, end } = markerNames(marker);
  const pattern = new RegExp(`\\n?${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g");
  return text.replace(pattern, "\n");
}

function normalizeEmpty(text) {
  // An empty sequence literal cannot be followed by sequence items. Drop it;
  // header comments may stay, because comments before a sequence are valid.
  const stripped = text.replace(/^\s*\[\]\s*$/gm, "");
  if (stripped.trim() === "") return "";
  return stripped.endsWith("\n") ? stripped : `${stripped}\n`;
}

async function main() {
  const [file, marker, mode, discoveryPath] = process.argv.slice(2);
  if (!file || !marker || !mode) {
    console.error("usage: patch-profile.mjs <file> <marker> web|headless|remove [discoveryPath]");
    process.exit(2);
  }
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const base = normalizeEmpty(stripBlock(text, marker));

  if (mode === "remove") {
    await mkdir(dirname(file), { recursive: true });
    const hasEntries = base.split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("#") && line.trim() !== "[]");
    await writeFile(file, hasEntries ? base : "[]\n");
    console.log(`removed ${marker} from ${file}`);
    return;
  }

  const block = blockFor(mode, discoveryPath || `${process.env.DSH_HOME || ""}/janus/bridge.json`);
  const next = base === "" ? `${block}\n` : `${base}\n${block}\n`;

  await mkdir(dirname(file), { recursive: true });
  try {
    await copyFile(file, `${file}.bak-janus-${isoNow().replaceAll(":", "-")}`);
  } catch {
    // First install: there is nothing to back up.
  }
  const temporary = `${file}.janus.tmp`;
  await writeFile(temporary, next);
  await rename(temporary, file);
  console.log(`wrote ${marker} into ${file}`);
}

main().catch((error) => {
  console.error(`patch-profile: ${error.message}`);
  process.exit(1);
});
