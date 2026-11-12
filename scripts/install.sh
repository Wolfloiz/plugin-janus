#!/usr/bin/env bash
# Janus installer: DSH plugin, Herdr mod, dock, key binding.
# Run it from the repository checkout. It writes outside the workspace, so run
# it without the DSH file sandbox if your environment restricts writes.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
HERDR_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
PROFILE="${DSH_PROFILE:-web}"
WEB_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH="$WEB_DIR/cordis.patch.yml"
PLUGIN_LINK="$DSH_HOME/profiles/node_modules/dsh-janus"
MOD_LINK="$HERDR_HOME/mods/janus"
CLI_LINK="$HOME/.local/bin/janus"

say() { printf 'janus: %s\n' "$*"; }
warn() { printf 'janus: warning: %s\n' "$*" >&2; }
die() { printf 'janus: error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "node is required"
command -v dsh >/dev/null || warn "dsh is not on PATH; the plugin will load when the web profile starts"
command -v herdr-app >/dev/null || warn "herdr-app is not on PATH; the mod will load when Herdr starts"
command -v hc >/dev/null || warn "hc is not on PATH; DSH-to-Herdr terminal control will fail"

[ -d "$REPO/dsh-janus" ] || die "run from the plugin-janus checkout"
[ -d "$WEB_DIR" ] || die "DSH profile not found: $WEB_DIR"

say "installing DSH bundle into profile '$PROFILE'"
mkdir -p "$DSH_HOME/janus"
BUNDLE_OK=0
if command -v dsh >/dev/null; then
  # Migrate any pre-bundle manual row out of the profile patch first.
  if [ -f "$PATCH" ]; then
    node "$REPO/scripts/patch-profile.mjs" "$PATCH" janus remove >/dev/null
  fi
  if dsh plugin --profile "$PROFILE" add "$REPO"; then
    BUNDLE_OK=1
    say "bundle installed with dsh plugin add"
  else
    warn "dsh plugin add failed; falling back to the manual profile row"
  fi
fi

if [ "$BUNDLE_OK" -eq 0 ]; then
  mkdir -p "$DSH_HOME/profiles/node_modules"
  if [ -e "$PLUGIN_LINK" ] && [ ! -L "$PLUGIN_LINK" ]; then
    die "$PLUGIN_LINK exists and is not a symlink; remove it manually"
  fi
  ln -sfn "$REPO/dsh-janus" "$PLUGIN_LINK"
  node "$REPO/scripts/patch-profile.mjs" "$PATCH" janus web "$DSH_HOME/janus/bridge.json"
fi

if [ -d "$DSH_HOME/profiles/headless" ]; then
  say "enabling saved sign-in for dsh headless"
  node "$REPO/scripts/patch-profile.mjs" "$DSH_HOME/profiles/headless/cordis.patch.yml" janus-auth headless
else
  warn "headless profile not found; skipped the headless auth patch"
fi

if [ "$BUNDLE_OK" -eq 1 ] && [ -L "$PLUGIN_LINK" ]; then
  rm -f "$PLUGIN_LINK"
fi

say "installing Herdr mod"
mkdir -p "$HERDR_HOME/mods"
if [ -e "$MOD_LINK" ] && [ ! -L "$MOD_LINK" ]; then
  die "$MOD_LINK exists and is not a symlink; remove it manually"
fi
ln -sfn "$REPO/mods/janus" "$MOD_LINK"
node "$REPO/scripts/patch-herdr.mjs" "$HERDR_HOME" install

say "installing janus CLI"
mkdir -p "$HOME/.local/bin"
ln -sfn "$REPO/dsh-janus/bin/janus.js" "$CLI_LINK"

if command -v herdr-app >/dev/null; then
  say "checking the mod"
  if herdr-app check "$REPO/mods/janus" >/dev/null 2>&1; then
    say "mod check passed"
  else
    warn "mod check failed; run: herdr-app check $REPO/mods/janus"
  fi
fi

cat <<EOF

Janus installed.

  bundle     $PROFILE profile: dsh-janus (dsh.profile.bundles)
  headless   saved sign-in re-enabled
  mod        $MOD_LINK -> $REPO/mods/janus
  dock       $HERDR_HOME/layouts (150 px strip in the sidebar)
  key        ctrl-shift-j -> janus.open (layout section)
  CLI        $CLI_LINK

The Herdr side applies live: the Janus strip should appear in the sidebar.
The DSH side needs a restart because the web process owns the plugin runtime:

  1. quit the running dsh web process;
  2. start it again with the same command (usually: dsh web);
  3. reopen this session in the browser.

After the restart, ~/.dsh/janus/bridge.json is written by the plugin and the
Herdr mod connects. To test without restarting DSH, run:

  node $REPO/scripts/dev-bridge.js --discovery "$DSH_HOME/janus/bridge.json"
EOF
