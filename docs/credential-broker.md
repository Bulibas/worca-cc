# Credential broker

The credential broker keeps model keys out of worca's container. worca holds no Anthropic,
OpenAI or OpenRouter key: every `claude` process it starts gets a short-lived token from the
broker instead, and the broker adds the real key on the way to the provider.

It solves two problems:

- **Agents can't read or leak a key.** Without the broker, a key in worca's environment is
  readable by every agent (`echo $ANTHROPIC_API_KEY`), and a prompt injection can send it
  anywhere. With the broker there is no key where agents run. The token an agent holds only
  works on the broker's private port, only while its process lives.
- **A team can share one worca, each person with their own key.** In multi mode each person
  saves their own keys on the broker's key page, and every model call is charged to the person
  who caused it. Costs can be told apart per person.

This is not multi-tenancy. Projects, workflows, models, plugins and settings stay shared, and
everyone signed in still sees all runs, chats and code.

The full design, including the threat model and what is deliberately out of scope, is in
[`plans/credential-broker-design.html`](../plans/credential-broker-design.html).

## When to use it

| Setup | Broker |
| --- | --- |
| Native install (no container) | Not used. The agent runs as you and can read anything you can, so there is nothing to enforce. |
| Local container, one person | Optional, **single mode**. Recommended when agents run autonomously on repositories you don't fully trust. |
| Hosted, several people (Cloudflare Access or an identity header) | **Multi mode.** worca warns at start while it runs without one; `WORCA_BROKER_REQUIRED=1` makes that an error. |

## How it works

```
worca container (no keys)                         broker container (keys)
  server ── POST /internal/tokens ──────────────►  mints wbt_… for this spawn
  claude ── /p/anthropic/v1/messages + wbt_… ───►  checks the token, adds the key ──► api.anthropic.com
         ◄───────────────────── streamed reply ──  records usage for the person
  server ── DELETE /internal/tokens/<spawn> ────►  revokes it when the process exits
```

- **Two ports.** `8080` is private: the proxy agents call and the internal API worca calls.
  `8081` is the key page, the only port a public route may point at (multi mode only).
- **Slots.** A slot is one kind of credential with one fixed destination: `anthropic`
  (`https://api.anthropic.com`), `openai`, `openrouter`, `copilot` (GitHub Copilot), and `local`
  when `WORCA_BROKER_LOCAL_URL` is set. A request names a slot, never a host, so nothing in
  worca's shared configuration can send a key anywhere else.
- **Every provider goes through it.** Claude models go straight to their slot. Models on
  Settings › Providers (OpenAI, OpenRouter, Copilot, a gateway) still go through worca's
  translation bridge, which forwards to the model's slot with the spawn's token; the slot is
  the one whose pinned origin matches the model's base URL (a gateway needs an entry in
  `WORCA_BROKER_SLOTS_FILE`). Copilot: each person signs in with GitHub on the key page; the
  broker keeps their GitHub token sealed and exchanges it for Copilot's short-lived token.
  Keyless local endpoints (llama.cpp, Ollama, LM Studio) hold no key and are reached directly.
- **Every model of a run is checked before it starts.** Each node's model maps to a slot;
  a person missing any of those keys gets one refusal naming them all, before a worktree or a
  spawn exists. Ask checks the model you picked. Pickers show a badge per model: *your key*,
  *no key*, *key rejected*, *team key* or *local*.
- **Who pays.** The person whose action caused the spawn: whoever started the run, sent the
  Ask message, clicked Test or resumed a paused run. A scheduled run is charged to whoever
  scheduled it. Work with no signed-in person behind it is charged to
  `WORCA_BROKER_SYSTEM_BILL_TO`, or refused.
- **Nothing leaks back.** The broker forwards only allowlisted headers each way, refuses
  redirects, and removes key material from provider error messages. worca removes `wbt_`
  tokens from everything agents print before storing or showing it.

## Single mode (one person, local container)

1. Generate a shared secret:

   ```bash
   docker compose run --rm --no-deps worca worca broker secrets
   ```

2. In `.env` next to `compose.yml` (**not** `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`:
   `compose.yml` would hand those to worca, and worca refuses to start while a key is within
   agents' reach):

   ```bash
   WORCA_BROKER_SECRET=<the secret from step 1>
   WORCA_BROKER_KEY_ANTHROPIC=sk-ant-…
   ```

3. Start with the overlay:

   ```bash
   docker compose -f compose.yml -f compose.broker.yml up -d
   ```

worca's log then shows `credentials: broker single, slots anthropic, openai, openrouter`.

If you signed Claude Code in inside the container before, its stored login is in the
`claude-config` volume. worca refuses to start while it's there; remove it with
`docker compose run --rm worca rm /home/worca/.claude/.credentials.json`.

## Multi mode (a team sharing one instance)

The broker runs as a second service next to worca, with its own volume for the encrypted
key store, and its key page on its own hostname behind its own Cloudflare Access application.

### Broker variables

| Variable | Example | Meaning |
| --- | --- | --- |
| `WORCA_BROKER_MODE` | `multi` | `single` or `multi` |
| `WORCA_BROKER_SECRET` | 32+ random characters | Shared with worca; checked on `/internal/*` |
| `WORCA_BROKER_VAULT_KEY` | 32 bytes, base64 | Encrypts keys at rest. Keep it out of the data volume, and keep a copy in the team's password manager |
| `WORCA_BROKER_VAULT_KEY_OLD` | | Set while rotating: rows sealed with it are re-encrypted at start |
| `WORCA_BROKER_DATA_DIR` | `/data` | Where the SQLite store lives |
| `WORCA_BROKER_HOST` | `::` | Listen address (`::` on Railway's IPv6 network) |
| `WORCA_BROKER_PORT` / `WORCA_BROKER_UI_PORT` | `8080` / `8081` | Private port / key page port |
| `WORCA_BROKER_PUBLIC_URL` | `https://worca-01-keys.example.com` | The key page's address |
| `WORCA_BROKER_RETURN_URL` | `https://worca-01.example.com` | Optional "Back to worca" link |
| `WORCA_CF_ACCESS_TEAM_DOMAIN`, `WORCA_CF_ACCESS_AUD` | | The key page's **own** Access application (a different AUD from worca's) |
| `WORCA_IDENTITY_HEADER` | `X-Forwarded-Email` | Instead of Access, a header a verifying proxy sets |
| `WORCA_BROKER_DEFAULT_DAILY_USD`, `WORCA_BROKER_DEFAULT_MONTHLY_USD` | `50`, `500` | Per-person budget per slot; people may set a lower one |
| `WORCA_BROKER_LOCAL_URL` | `http://host.docker.internal:11434` | A keyless local model server (Anthropic API) as slot `local` |
| `WORCA_BROKER_SLOTS_FILE` | | JSON array of extra or overridden slots |

Every secret also accepts `<NAME>_FILE` pointing at a file.

### worca variables

| Variable | Meaning |
| --- | --- |
| `WORCA_BROKER_URL` | The broker's internal address, e.g. `http://broker:8080`. Unset = broker off |
| `WORCA_BROKER_SECRET` | The same shared secret |
| `WORCA_BROKER_SYSTEM_BILL_TO` | Optional: who pays for work no signed-in person caused |
| `WORCA_BROKER_REQUIRED` | `1`: refuse to start a multi-person instance without a broker |

Remove `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` from worca.

### What worca refuses

With `WORCA_BROKER_URL` set, worca exits (code 78) with a list of what it found when any model
credential is still within agents' reach:

- a provider key in its environment;
- a stored Claude Code sign-in or an `apiKeyHelper` in its own or the agents' HOME;
- a model in the catalog whose env holds a key or routes around the broker with
  `ANTHROPIC_BASE_URL`;
- a bridged model with its own `apiKey` or a remote `baseUrl`;
- a provider key or Copilot sign-in in Settings › Providers.

It also exits when the broker can't be reached within 60 seconds, or the secrets differ.

### People

Each person opens **Settings › My model credentials › Manage keys** (or the key page URL
directly), signs in through Access, and saves their keys; for GitHub Copilot they sign in
with GitHub (a device code) instead. The broker checks each key with the provider before
storing it. Keys are never shown again: the page shows the last four
characters, when a key was added and last used, today's and this month's spend, and optional
personal caps.

Someone without a key who starts a run or sends an Ask message is told so before anything
starts. A key deleted or rejected mid-run, or a spent cap, pauses the run with a message
saying where to fix it; resuming continues it.

## Cloudflare Access and Railway

Use a **first-level** hostname for the key page (`worca-01-keys.example.com`, not
`keys.worca-01.example.com`): Cloudflare's free certificate covers one subdomain level.

1. **Tunnel.** On the existing worca tunnel, add a second public hostname
   `worca-01-keys.example.com` → HTTP → `broker.railway.internal:8081`. Never route port 8080.
2. **Access application.** Add a self-hosted application for `worca-01-keys.example.com` with
   the same Allow policy as worca's. Its AUD tag is the broker's `WORCA_CF_ACCESS_AUD`.
3. **Railway service.** New service `broker` from the same image and version as worca:
   start command `worca-entrypoint worca broker`, a volume at `/data`,
   `RAILWAY_RUN_UID=0` (the entrypoint prepares the volume and drops to `worca`),
   `WORCA_BROKER_DATA_DIR=/data`, `WORCA_BROKER_HOST=::`, `PORT=8081`, healthcheck `/healthz`,
   no public domain, plus the variables above. Seal the secrets.
4. **worca service.** Set `WORCA_BROKER_URL=http://broker.railway.internal:8080` and
   `WORCA_BROKER_SECRET`; remove the old Claude credential. Deploy the broker first.

Section 9 of the design has the dashboard and API steps, the full variable table, checks and
troubleshooting. `tools/railway/worca-railway.mjs` knows the broker once the target names it
(`RAILWAY_BROKER_SERVICE`, `RAILWAY_BROKER_SERVICE_ID`, `KEYS_URL`): upgrades move both
services to one image, `--service broker` sets its variables, and `verify` checks the key
page and, with `--in-container`, the agent boundary.

## Costs per person

**Stats** gains a *By person* card: each person's model spend, requests and tokens in the
selected period, with the providers they used, as the broker metered them.

## Agents under their own users (a team instance)

On a shared instance, run agents under their own users so one person's agents can't read
another's processes (where a live spawn's token sits):

- **Railway** and other single-volume hosts (`WORCA_DATA_DIR`) do this already.
- **Compose** (a Linux server, or a Mac hosting a local model): add
  `docker/compose.isolation.yml`:

  ```bash
  docker compose -f compose.yml -f compose.broker.yml -f compose.isolation.yml up -d
  ```

  It keeps everything on one volume (`/data`, repositories under `/data/projects`), starts as
  root only to prepare it, and lifts `no-new-privileges` so worca can `sudo` to the agent users
  (never to root). Needs Docker Compose 2.24 or newer.

The image has a pool of 16 agent users (`worca-agent-01…16`). Each signed-in person gets one
for good (stored in `agent-pool.json` in worca's home), with its own home folder, where Claude
Code keeps that person's sessions. A resumed run keeps its starter's user; the person who
resumes pays. Work with no signed-in person uses the shared `worca-agent`. With more than 16
people, the rest share users by a stable hash (worca warns once).
`WORCA_AGENT_POOL=0` turns the pool off.

Ask Worca runs as the person's agent user too. Its worca tools (runs, projects, memory…)
then run inside the worca server: the chat's tool process only relays each call over
loopback with a token that lives for one turn.

## Limits

- Two people who share an agent user (a pool of 16 exceeded) can use each other's live
  tokens: credits spent on the wrong person, never a key.
- Repositories and run checkouts are shared by all agent users (teammates share repos), and
  so are Ask's folders. Code one person's run plants can run in another's.
- On Railway, agents can still reach the internet directly. Keys are safe regardless; data
  leaving the container is outside what the broker does.
- A Claude subscription token (`sk-ant-oat…`) is not a supported per-person credential yet.
