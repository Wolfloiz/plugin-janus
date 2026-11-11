#!/usr/bin/env node
// Install/remove the Janus dock in the active Herdr layout and bind ctrl-shift-j.
//
//   node scripts/patch-herdr.mjs <herdrHome> install|remove
//
// A symlink for the mod itself is created by scripts/install.sh.

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isoNow } from "../dsh-janus/lib/util.js";

const DOCK_ID = "janus-dock";
const KEY = "ctrl-shift-j";
const ACTION = "janus.open";

function nowSlug() {
  return isoNow().replaceAll(":", "-");
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function backup(file, herdrHome) {
  const dir = join(herdrHome, "janus", "backups");
  await mkdir(dir, { recursive: true });
  const name = file.split("/").pop();
  try {
    await copyFile(file, join(dir, `${name}.bak-janus-${nowSlug()}`));
  } catch {
    // Missing file on first install.
  }
}

function findById(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function removeById(node, id) {
  if (!node || !Array.isArray(node.children)) return false;
  const before = node.children.length;
  node.children = node.children.filter((child) => child.id !== id);
  let removed = node.children.length !== before;
  for (const child of node.children) removed = removeById(child, id) || removed;
  return removed;
}

async function activeLayout(herdrHome) {
  const view = await readJson(join(herdrHome, "view.json"), {});
  const name = typeof view.layout === "string" && view.layout !== "" ? view.layout : "bercail";
  return name;
}

async function patchLayout(herdrHome, mode) {
  const name = await activeLayout(herdrHome);
  const file = join(herdrHome, "layouts", `${name}.json`);
  const layout = await readJson(file, null);
  if (!layout) {
    console.warn(`layout not found: ${file} (skipping dock)`);
    return { name, changed: false };
  }
  const sidebar = findById(layout, "sidebar");
  if (!sidebar || !Array.isArray(sidebar.children)) {
    console.warn(`layout ${name} has no sidebar block (skipping dock)`);
    return { name, changed: false };
  }
  const had = removeById(layout, DOCK_ID);
  if (mode === "remove") {
    if (!had) return { name, changed: false };
    await backup(file, herdrHome);
    await writeFile(file, `${JSON.stringify(layout, null, 2)}\n`);
    return { name, changed: true };
  }
  const dock = {
    id: DOCK_ID,
    type: "block",
    content: { mod: "janus", props: { role: "dock", v: 1 } },
    size: { px: 150 },
    min: 110,
  };
  const footerIndex = sidebar.children.findIndex((child) => child.id === "sidebar-footer");
  if (footerIndex === -1) sidebar.children.push(dock);
  else sidebar.children.splice(footerIndex, 0, dock);
  await backup(file, herdrHome);
  await writeFile(file, `${JSON.stringify(layout, null, 2)}\n`);
  return { name, changed: true };
}

async function patchKeys(herdrHome, mode, layoutName) {
  const file = join(herdrHome, "keys.json");
  const keys = await readJson(file, {});
  const section = `layout:${layoutName}`;
  if (mode === "remove") {
    if (keys[section]?.[KEY] !== ACTION) return false;
    delete keys[section][KEY];
    if (Object.keys(keys[section]).length === 0) delete keys[section];
  } else {
    keys[section] = keys[section] ?? {};
    if (keys[section][KEY] !== undefined && keys[section][KEY] !== ACTION) {
      console.warn(`${KEY} is already bound to ${keys[section][KEY]} in ${section}; left unchanged`);
      return false;
    }
    keys[section][KEY] = ACTION;
  }
  await backup(file, herdrHome);
  await writeFile(file, `${JSON.stringify(keys, null, 2)}\n`);
  return true;
}

async function main() {
  const [herdrHome, mode = "install"] = process.argv.slice(2);
  if (!herdrHome || !["install", "remove"].includes(mode)) {
    console.error("usage: patch-herdr.mjs <herdrHome> install|remove");
    process.exit(2);
  }
  const layout = await patchLayout(herdrHome, mode);
  const keys = await patchKeys(herdrHome, mode, layout.name);
  console.log(`${mode}: layout ${layout.name} ${layout.changed ? "updated" : "unchanged"}; keys ${keys ? "updated" : "unchanged"}`);
}

main().catch((error) => {
  console.error(`patch-herdr: ${error.message}`);
  process.exit(1);
});
