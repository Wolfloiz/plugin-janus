#!/usr/bin/env bash
# Remove the Janus plugin, mod, dock, and key binding. Backups stay in
# ~/.config/herdr-app/janus/backups and next to the profile patch files.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
HERDR_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
PROFILE="${DSH_PROFILE:-web}"
PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
PLUGIN_LINK="$DSH_HOME/profiles/node_modules/dsh-janus"
MOD_LINK="$HERDR_HOME/mods/janus"
CLI_LINK="$HOME/.local/bin/janus"

say() { printf 'janus: %s\n' "$*"; }

if command -v dsh >/dev/null; then
  if dsh plugin --profile "$PROFILE" remove dsh-janus >/dev/null 2>&1; then
    say "removed the dsh-janus bundle from profile '$PROFILE'"
  fi
fi

if [ -L "$PLUGIN_LINK" ]; then
  rm -f "$PLUGIN_LINK"
  say "removed $PLUGIN_LINK"
fi

if [ -f "$PATCH" ]; then
  node "$REPO/scripts/patch-profile.mjs" "$PATCH" janus remove
fi

if [ -f "$DSH_HOME/profiles/headless/cordis.patch.yml" ]; then
  node "$REPO/scripts/patch-profile.mjs" "$DSH_HOME/profiles/headless/cordis.patch.yml" janus-auth remove
fi

if [ -L "$MOD_LINK" ]; then
  rm -f "$MOD_LINK"
  say "removed $MOD_LINK"
fi

node "$REPO/scripts/patch-herdr.mjs" "$HERDR_HOME" remove

if [ -L "$CLI_LINK" ]; then
  rm -f "$CLI_LINK"
  say "removed $CLI_LINK"
fi

rm -f "$DSH_HOME/janus/bridge.json"
say "done (restart dsh web to unload the plugin)"
