# Publishing Janus

Janus is distributed through **two galleries** and can be amplified on
**Trendshift**. This guide is the concrete checklist, using the repository name
`Wolfloiz/plugin-janus`; replace it if you fork under another account.

- [0. One-time GitHub setup](#0-one-time-github-setup)
- [1. Herdr Gallery](#1-herdr-gallery)
- [2. DeepSeek Harness plugin index](#2-deepseek-harness-plugin-index)
- [3. Trendshift](#3-trendshift)
- [4. Release checklist](#4-release-checklist)

## 0. One-time GitHub setup

The repo is already laid out for both stores: `mods/janus/` is the Herdr mod,
`dsh-janus/` is the DSH bundle, `RECIPE.md` and `preview.png` are the Herdr
gallery assets, and `docs/` will be the plugin index.

> This checkout is already a git repository with commits. Skip `git init` and
> the first commit if you keep that history. No remote is configured yet.

```bash
cd /path/to/plugin-janus
# git init && git add . && git commit -m "..."   # only for a fresh copy
gh repo create Wolfloiz/plugin-janus \
  --public --source=. --remote=origin --push
gh repo edit Wolfloiz/plugin-janus \
  --description "Bidirectional control between DeepSeek Harness and Herdr" \
  --add-topic herdr-mod,dsh-plugin,deepseek-harness,ai-agents,herdr \
  --homepage "https://herdr.dev/mods/"
```

GitHub topics are the submission mechanism for the Herdr gallery. The
`herdr-mod` topic is mandatory; the others help discovery. Keep the repository
**public**.

## 1. Herdr Gallery

Herdr's gallery is at <https://herdr.dev/mods>. The site's own **Share yours**
instructions say:

1. Ask your agent to write `RECIPE.md` — the brief another agent could rebuild
   the mod from. This repo has it at the root.
2. Push the folder to a public GitHub repo with the topic **`herdr-mod`**.
   Each mod is a folder with `mods/<name>/`, the `RECIPE.md`, a `preview.png`,
   and, if needed, a `keys.json` snippet. **No `layouts/` folder.**
3. It appears under **Community** within the hour. No sign-up, no review of the
   code; community pictures are screened.

This repo satisfies the layout:

```
plugin-janus/
├── RECIPE.md          # the Herdr recipe (root)
├── preview.png        # 960×600 screenshot (root)
├── keys.json          # suggested ctrl-shift-j binding (root)
└── mods/
    └── janus/
        ├── main.js
        └── mod.json
```

Checklist:

- [x] Public GitHub repo
- [x] Topic `herdr-mod` (run the `gh repo edit` command above)
- [x] `RECIPE.md` at the root
- [x] `preview.png` at the root (960×600; `preview.png` in this repo)
- [x] `mods/janus/` with `main.js` and `mod.json`
- [x] Optional `keys.json` at the root
- [x] No `layouts/` folder

After pushing, open <https://herdr.dev/mods> and search for **Janus**. The
listing also gets a detail page under `herdr.dev/mods/Wolfloiz/plugin-janus/`.

> The gallery only shows the mod. The DSH half is installed separately (below).
> Users can also ask their agent: *“Read ~/.config/herdr-app/AGENTS.md, then add
> this mod: herdr.dev/mods/Wolfloiz/plugin-janus.”*

## 2. DeepSeek Harness plugin index

DSH has **no single central store**. Its **Plugin indexes** feature lets a
publisher host one JSON file and users add that URL under
**Plugins → Discover**. The official format and rules are here:

- <https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market>
- <https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish>

Janus is packaged as a **bundle**, not just a plugin. `dsh-janus/package.json`
declares:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

and `dsh-janus/cordis.patch.yml` inserts the `janus` row. That is what lets
`dsh plugin add` compose the layer and what the index generator looks for.

### 2a. Choose the source: Git (works now) or npm

An index entry can point to the **GitHub repo at a pinned commit** (no npm
account needed) or to an **npm package**. `scripts/build-index.mjs` defaults to
Git because it works as soon as the repo is public.

**Git (default, recommended until the npm package exists):**

```bash
git add .
git commit -m "release: v0.1.0"
git push
npm run build:index
```

The generated source is:

```json
{
  "type": "git",
  "url": "https://github.com/Wolfloiz/plugin-janus",
  "commit": "<HEAD sha>"
}
```

The market turns that into
`git+https://github.com/Wolfloiz/plugin-janus.git#<commit>`, which was tested
with `dsh plugin add`. No build script runs; the package is pure JavaScript.
The repository root is the bundle (`dsh.bundle` + `cordis.patch.yml`) and its
`main` re-exports `dsh-janus/lib/index.js`; `dsh-janus/` remains the npm
package for npm installs.

**npm (optional, after you publish):**

```bash
cd dsh-janus
npm login
npm pack --dry-run          # lib/, bin/, cordis.patch.yml, package.json
npm publish --access public
cd ..
JANUS_INDEX_SOURCE=npm npm run build:index
```

The npm source installs `dsh-janus@0.1.0`. The package is pure JavaScript, so
there is no `prepare` step and no build allowlist.

> If `dsh-janus` is taken by the time you publish, switch to a scope such as
> `@wolfloiz/dsh-janus`, update `name` in `package.json`, the bundle row in
> `cordis.patch.yml`, and the index builder.

### 2b. Host the index

`npm run build:index` writes `docs/index.json` and
`docs/icons/janus.svg`. Commit and push the result:

```bash
git add docs && git commit -m "market: index for v0.1.0" && git push
```

Host `docs/` with GitHub Pages:

1. GitHub → **Settings → Pages**.
2. **Deploy from a branch** → branch `main`, folder **`/docs`**.
3. The index URL becomes:

   `https://wolfloiz.github.io/plugin-janus/index.json`

The icon is relative (`icons/janus.svg`) and resolves against the index URL,
exactly as the format requires.

### 2b-bis. Troubleshooting: the tarball error

`ERR_PNPM_TARBALL_UNRECOGNIZED — The response is neither a gzip nor a tar
archive` (with a command such as
`pnpm add https://wolfloiz.github.io/plugin-janus/...`) means **the index URL
itself was installed as a package**. That URL is a JSON list, not a tarball.

The other error, **“Este pacote não declara nenhum pacote”**, came from the
old repository root, which had no `dsh.bundle`. The root now declares one, so
`pnpm add https://github.com/Wolfloiz/plugin-janus` installs a valid bundle.

The correct sequence is:

1. Add the index URL under **Discover → Add index source**.
2. Open the **Janus** card from that source.
3. Install the card.

If the card's source facts still show the Pages URL as the repository, the
client cached an older index. Remove the index source and add it again after
pushing the fixed `docs/index.json`; then retry the card. The repository fact
must be `https://github.com/Wolfloiz/plugin-janus`, with a commit (no
directory).

### 2c. Verify as a user

In a DSH web session:

1. **Plugins → Experimental plugins → Custom plugin indexes** → enable.
2. **Plugins → Discover → Add index source** →
   `https://wolfloiz.github.io/plugin-janus/index.json`.
3. Open the **Janus** card and install the listed version after the
   confirmation.

The card shows the title, icon, author, version, and the source (npm package or
Git commit). The install is a normal bundle installation; restart `dsh web`
if the bundle was not hot-loaded.

### 2d. Optional: use the official generator

The official reference generator can build the same file from a list:

```bash
pnpm --filter @deepseek-ai/dsh-plugin-market-generator start \
  --input plugins.txt --output docs/index.json --title "Janus"
```

It lists every non-deprecated npm version, or the Git repository's bundle
packages. The hand-written `scripts/build-index.mjs` is equivalent for this
single-plugin repo and lets you keep the bilingual title/description.

## 3. Trendshift

Trendshift is a daily-momentum alternative to GitHub Trending:
<https://trendshift.io>. There is **no star threshold** in the submit dialog;
it says it will “monitor and recommend [the repository] based on its growing
momentum.”

1. Sign in at <https://trendshift.io/login> with your email (magic link).
2. Click **Submit repository** (top-right; also the mobile icon button).
3. Paste the public repository URL:
   `https://github.com/Wolfloiz/plugin-janus`.
4. Submit. Trendshift starts tracking it; a repository page appears when it
   enters the ranking. It is not guaranteed and not immediate.

Before submitting, make the repo easy to rank and share:

- Public repo, clear description, topics, MIT license, a README with a
  screenshot and install commands.
- A first release/tag (`v0.1.0`) so the project looks alive.
- A few genuine early users/stars; momentum is the signal.
- Post the launch where the DSH/Herdr communities are (Herdr Discord, DSH
  GitHub Discussions, X) — Trendshift watches GitHub activity, not posts.

### Badge (after it is tracked)

Open the repository page (`https://trendshift.io/repositories/<id>`) and use
its badge:

```markdown
[![Trendshift](https://trendshift.io/api/badge/repositories/<id>)](https://trendshift.io/repositories/<id>)
```

The `<id>` is in the page URL. Uncomment the placeholder in `README.md` and
replace `REPLACE_ID`.

## 4. Release checklist

```bash
# 1. tests and checks
npm test
npm run check
herdr-app check mods/janus

# 2. version + commit + tag
npm --prefix dsh-janus version 0.1.0 --no-git-tag-version
git add .
git commit -m "release: v0.1.0"
git tag v0.1.0
git push origin main --tags

# 3. npm
(cd dsh-janus && npm publish --access public)

# 4. Herdr gallery topic
gh repo edit Wolfloiz/plugin-janus \
  --add-topic herdr-mod,dsh-plugin,deepseek-harness,ai-agents,herdr

# 5. DSH index + Pages (Git source; use JANUS_INDEX_SOURCE=npm after npm publish)
npm run build:index
git add docs && git commit -m "market: index for v0.1.0" && git push

# 6. GitHub release
gh release create v0.1.0 --generate-notes

# 7. Trendshift
#    https://trendshift.io → Submit repository → repo URL
```

### What “listed” looks like

| Store | Where | Signal |
|---|---|---|
| Herdr Gallery | <https://herdr.dev/mods> | Search “Janus”; topic `herdr-mod` |
| DSH index | `https://wolfloiz.github.io/plugin-janus/index.json` | Card in Discover |
| Trendshift | `https://trendshift.io/repositories/<id>` | Ranked by daily momentum |

### Notes

- Herdr does not review mods; users are expected to read the files before
  installing. The gallery screens community images.
- DSH indexes are third-party content too. The confirmation dialog shows the
  exact source; users should check it.
- The Herdr gallery and the DSH index are independent: publish both, and keep
  the same version tag in `mods/janus/mod.json`/`package.json` and
  `dsh-janus/package.json`.
- `RECIPE.md` and `preview.png` are for Herdr. `docs/index.json` and
  `docs/icons/` are for DSH. The root README serves both.
