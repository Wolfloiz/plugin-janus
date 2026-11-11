# Janus — plano do plugin DSH + mod Herdr

> Estado: **implementado e verificado**; falta o restart do `dsh web` para o
> processo carregar o código final. Resultados ao vivo na seção 8.

## 1. Objetivo

Um par de extensões que permite **controle bidirecional** entre o DeepSeek Harness (DSH) e o Herdr:

- No DSH: um **plugin** (`dsh-janus`).
- No Herdr: um **mod** (`janus`).
- O agente DSH consegue ler e operar espaços, abas, terminais e agentes do Herdr.
- O mod do Herdr consegue listar, conversar, criar e cancelar sessões do DSH.

O nome Janus vem do deus romano de duas faces — uma olhando para cada lado.

## 2. Fatos do ambiente (levantados nesta sessão)

| Fato | Valor |
|---|---|
| Workspace | `/home/loizlabz/Projects/03-projetos/ativos/plugin-janus` (vazio, sem git) |
| DSH | `0.2.2-rc.1`, GUI web em `http://127.0.0.1:3080` |
| Perfil DSH | `web` em `~/.dsh/profiles/web` (bundle `dsh-base` + `dsh-web-app`) |
| Herdr | app rodando; layout atual `bercail`; CLI `herdr-app` e `hc` em `~/.local/bin` |
| Mods Herdr | `~/.config/herdr-app/mods/` (JS + gpui-kit, sem DOM/Node API) |
| Skills | `grill-me` e `grilling` baixadas em `.dsh/skills/` |
| Sandbox | escrita liberada só no workspace; escrever em `~/.dsh`/`~/.config/herdr-app` exige aprovação |

Capacidades confirmadas nas APIs:

- **DSH**: `ctx.agents.create/resume/get/list`, `agent.followup/steer/inject/cancel`, `ctx.sessions.list`, `ctx.sessionTitle.get`, eventos `agent/status`, `agent/created`, `agent/disposed`. Plugin Cordis = `name`, `inject`, `apply(ctx, config)`.
- **Herdr app**: `herdr-app do <comando>` executa qualquer comando do app (spaces, tabs, panes, terminais, foco, layout, mods); `herdr-app ls/status` lê o estado.
- **Herdr core**: `hc ls/read/send/run/wait/label` opera terminais que continuam vivos mesmo com a janela fechada.
- **Mod Herdr**: `fetch` liberado, `exec`, `readTextFile/writeTextFile`, `watchFolder`, `notify`, `nextCommand`, `shared`; `herdr-app check <pasta>` valida um mod.

## 3. Arquitetura proposta

```
┌────────────────────────── DSH (processo do web) ──────────────────────────┐
│  agente/modelo ──tool──> dsh-janus ──execFile──> herdr-app / hc  ────────┼──> Herdr
│                              │                                            │
│                              ├── HTTP 127.0.0.1:<porta> + token           │
│                              │      GET  /v1/state                        │
│                              │      POST /v1/prompt | /spawn | /cancel    │
│                              └── agent.followup/steer/cancel              │
└───────────────────────────────────▲───────────────────────────────────────┘
                                    │ fetch (token em arquivo 0600)
┌───────────────────────────────────┴───────────────────────────────────────┐
│  mod janus (Herdr) — lista sessões, envia prompt, cria/cancela, notifica   │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Plugin DSH (`dsh-janus`)

- Pacote ESM JS (sem build), Cordis plugin.
- Sobe um servidor `node:http` em `127.0.0.1:0` (porta efêmera).
- Escreve `~/.dsh/janus/bridge.json` com `{ url, token, pid, startedAt }`, modo `0600`.
- Token aleatório de 32 bytes; toda chamada exige `Authorization: Bearer`.
- Registra ferramentas para o modelo:
  - `janus_herdr` — `status`, `list`, `read`, `send`, `keys`, `run`, `open`, `focus`, `notify`, `kill`/`close` (com `confirm`).
  - `janus_dsh` — `sessions`, `prompt` (`followup|steer|inject`), `spawn`, `cancel`, `job`, `job_continue`.
- Escuta `agent/status` / `agent/created` / `agent/disposed` para manter o estado e a fila de eventos do mod.
- Usa `child_process.execFile` com arrays de argumentos (nunca shell), timeout e erros claros.
- Funciona sem a janela do Herdr para o que é `hc` (terminais continuam vivos); comandos de app degradam com aviso.
- Jobs `dsh headless`: sobem num terminal do Herdr com `--json`, o plugin lê o
  `sessionId` da primeira linha e guarda o job para o botão **Continuar**.

### 3.2 Mod Herdr (`janus`)

- UI em gpui-kit: cabeçalho de conexão, lista de sessões DSH (título, cwd, modelo, status), campo de prompt, botões Send/Steer, Cancel, New session, Refresh, Open DSH web.
- Poll do `/v1/state` a cada ~2 s (só enquanto carregado; dados do DSH não são live no Herdr).
- Notificações `done`/`blocked` via `notify()` a partir da fila de eventos (v1: polling; SSE fica para depois se necessário).
- `nextCommand()` para `janus.open`, `janus.notify`, `janus.refresh`.
- Modo offline: mostra "DSH offline" e como subir (`dsh web`).

### 3.3 Contrato HTTP (v1)

| Método | Rota | Corpo | Retorno |
|---|---|---|---|
| GET | `/v1/health` | — | `{ ok, version, pid }` |
| GET | `/v1/state` | — | `{ sessions[], herdr{...}, eventsSince, seq }` |
| POST | `/v1/prompt` | `{ session, text, mode }` | `{ ok, session }` |
| POST | `/v1/spawn` | `{ cwd, prompt, title? }` | `{ ok, session }` |
| POST | `/v1/cancel` | `{ session }` | `{ ok }` |
| GET | `/v1/events?since=N` | — | `{ events[], seq }` (v1 polling) |

Segurança: loopback apenas, token obrigatório, corpo máximo, sem CORS, log sem conteúdo de prompt.

### 3.4 Estrutura de arquivos

```
plugin-janus/
├── PLAN.md
├── README.md                     # PT-BR, depois das decisões
├── package.json                  # scripts de dev/test/install
├── dsh-janus/
│   ├── package.json              # name dsh-janus, type module, peerDeps DSH
│   ├── lib/index.js              # plugin Cordis + tools
│   ├── lib/bridge.js             # HTTP + token + rotas
│   ├── lib/herdr-cli.js          # herdr-app / hc
│   ├── lib/dsh-control.js        # agents/sessions/títulos
│   └── test/*.test.js            # node:test com registry fake
├── mods/janus/
│   ├── mod.json
│   ├── main.js
│   └── ui.js
├── scripts/install.sh            # plugin no perfil + symlink do mod + keys
└── .dsh/skills/                  # grill-me / grilling (já baixadas)
```

### 3.5 Instalação

- DSH: `dsh plugin --profile web add ./dsh-janus` + linha em `~/.dsh/profiles/web/cordis.patch.yml`; reiniciar o `dsh web`.
- Herdr: symlink `mods/janus` → `~/.config/herdr-app/mods/janus`; merge de `keys.json`; `herdr-app check`.
- Desinstalação: remover a linha do patch, o pacote e o symlink; reverter keys.

## 4. Fases

1. **Contrato + esqueleto**: package.json, bridge com health/state e testes unitários; `janus` tool de leitura (`status`, `list`, `read`).
2. **DSH → Herdr completo**: `send`, `run`, `open`, `focus`, `notify`, com bloqueio de ações destrutivas sem `confirm`.
3. **Herdr → DSH**: mod com lista, prompt, cancel, spawn; cliente do bridge.
4. **Eventos/notificações**: fila no plugin, polling no mod, toasts.
5. **Instalação + verificação ponta a ponta** + README PT-BR.

## 5. Riscos e decisões já recomendadas

- **Escrita em terminais é poderosa**: leitura livre; escrita livre só não-destrutiva; `kill`/`close` exigem `confirm: true`.
- **Instalar no perfil web real** exige aprovação e restart do DSH; o teste de desenvolvimento pode rodar num perfil temporário no workspace.
- **Mods do Herdr são confiáveis e sem sandbox**: o token do bridge fica em arquivo `0600` e o servidor só escuta loopback.
- **`fetch` do mod não tem CORS**: sem necessidade de headers extras.
- **Máquinas remotas do Herdr**: o bridge controla via `hc` local; terminais remotos aparecem como `machine/t7`.
- **Sem servidor HTTP no Herdr**: o mod só faz polling; nada de WebSocket no v1.

## 6. Decisões fechadas (rounds de grill)

| # | Decisão | Escolha |
|---|---|---|
| 1 | Escopo | **Controle completo bidirecional** |
| 2 | Escrita no Herdr | **Livre, exceto destrutivo**; `kill`/`close` exigem `confirm:true` |
| 3 | Transporte | **HTTP loopback + token**; CLI `janus` como cliente de debug |
| 4 | Lugar do mod | **Painel dockado** na sidebar + `ctrl-shift-j` para o painel completo |
| 5 | Criar sessões | **Híbrido**: sessão in-process no web + job `dsh headless` em terminal do Herdr |
| 6 | Instalação | **Instalar agora**; o restart do `dsh web` é feito pelo usuário (processo fora do sandbox) |

### Consequências assumidas

- `dsh headless` é one-shot; o mod mostra o terminal e oferece **Continuar** via
  `dsh headless --session-id <id>` num novo terminal, no mesmo `cwd`.
- O perfil `headless` precisa reabilitar `credentials`, `authorization` e
  `deepseek-account` para usar o login salvo do DSH; o instalador aplica esse patch.
- O layout `bercail` e o `keys.json` serão editados com backup. A faixa do Janus
  fica no rodapé da sidebar, acima do footer.
- Reiniciar o `dsh web` encerra esta sessão; a instalação termina com o comando
  de restart e as instruções para reabrir a sessão.

## 7. Ordem de implementação

1. `dsh-janus/lib/{util,herdr,controller,bridge,tools}.js` + `lib/index.js`.
2. CLI `janus` e `scripts/dev-bridge.js` para testar o mod sem reiniciar o DSH.
3. Mod `mods/janus` (dock + painel completo).
4. Testes `node:test`, `node --check`, `herdr-app check`.
5. Instalador idempotente (symlinks, patch YAML, layout, keys) + README PT-BR.
6. Bundle DSH (`dsh.bundle`) instalado com `dsh plugin add`; mod no layout; o usuário reinicia o DSH.

## 8. Verificação realizada

- `npm test`: 16 testes passando.
- `herdr-app check mods/janus`: passa.
- DSH → Herdr: `janus_herdr` `status`, `run`, `send`, `read`, `kill` ao vivo.
- Herdr → DSH: `prompt` em sessão ociosa (`JANUS-PROMPT-OK`), job `dsh headless`
  (`JANUS-HEADLESS-OK`) e Continue (`JANUS-CONTINUE-OK`).
- Notificação `notify` exibida como toast no Herdr.
- Dock instalado no layout `bercail` (150 px), `ctrl-shift-j` vinculado.
- Spawn in-process: `JANUS-SPAWN-OK` (via fallback de modelo do patch).
- Pendente: restart do `dsh web` para carregar o código final (injeção de
  `agentDefaultModel`/`sessionTitle`, títulos derivados); o spawn já funciona
  com o fallback de configuração.
