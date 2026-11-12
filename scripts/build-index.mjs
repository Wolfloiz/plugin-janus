#!/usr/bin/env node
// Build the DSH plugin index for this repository.
//
//   npm run build:index                 # npm source (after `npm publish`)
//   JANUS_INDEX_SOURCE=git npm run build:index
//
// Output: docs/index.json + docs/icons/janus.svg, ready for GitHub Pages
// (Settings -> Pages -> Deploy from a branch -> main / docs).

import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const repoUrl = "https://github.com/Wolfloiz/plugin-janus";
// Git is the safe default: it works before the npm package is published.
// Set JANUS_INDEX_SOURCE=npm only after `npm publish` succeeds.
const sourceKind = process.env.JANUS_INDEX_SOURCE === "npm" ? "npm" : "git";
const version = pkg.version;
const dshRange = pkg.engines?.dsh ?? ">=0.2.0-rc.1 <0.3.0";
const timestamp = Number(process.env.JANUS_PUBLISH_TIMESTAMP || Math.floor(Date.now() / 1000));

function gitCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

const source = sourceKind === "git"
  ? { type: "git", url: repoUrl, commit: gitCommit() }
  : { type: "npm" };

const index = {
  format: 1,
  title: { en: "Janus", pt: "Janus" },
  description: {
    en: "Bidirectional control between DeepSeek Harness and Herdr.",
    pt: "Controle bidirecional entre DeepSeek Harness e Herdr.",
  },
  metadata: {
    categories: {
      "developer-tools": { title: { en: "Developer tools", pt: "Ferramentas de desenvolvimento" } },
    },
    labels: {
      agents: { title: { en: "Agents", pt: "Agentes" } },
      herdr: { title: { en: "Herdr", pt: "Herdr" } },
      bridge: { title: { en: "Bridge", pt: "Ponte" } },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: "Janus",
      description: pkg.description,
      icon: "icons/janus.svg",
      author: "Wolfloiz",
      homepage: `${repoUrl}#readme`,
      repository: { url: repoUrl },
      metadata: { category: "developer-tools", labels: ["agents", "herdr", "bridge"] },
      versions: [
        {
          version,
          publishTimestamp: timestamp,
          source,
          engines: { dsh: dshRange },
        },
      ],
    },
  ],
};

await mkdir(join(root, "docs/icons"), { recursive: true });
await copyFile(join(root, "market/icon.svg"), join(root, "docs/icons/janus.svg"));
await writeFile(join(root, "docs/index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote docs/index.json (${sourceKind}, v${version})`);
console.log(`index URL: https://wolfloiz.github.io/plugin-janus/index.json`);
