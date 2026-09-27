# Workspace map

A Workspace scan produces a **map** of how the member projects of a workspace depend on each
other: which member calls another's API, consumes the messages it publishes, builds on its
package or shares its tables. Every scanned edge carries file:line evidence and a confidence,
every member a coverage level. The map is stored with the workspace, shown on the workspace
page's **Map** tab, and rendered into the workspace description that every agent of a
workspace run receives (`## Workspace Context`).

## How a scan works

The scan is a pipeline run (`wf_workspace_scan`) you can follow under **Running**. Code
extracts facts and does all the matching; agents fill the gaps code leaves and confirm uses.

| Stage | Runs as | What it does |
|---|---|---|
| extract | script | Lists each member's files (`git ls-files`; `graphify-out/`, vendored and build folders skipped) and runs the detectors — package manifests, deploy files, configuration, API specs, and code (HTTP routes and clients, messaging, databases). Each fact records its file, line and the literal text found there. |
| survey | agent `workspaceScanner` | One investigator per member whose coverage is `partial` or `none` reports what code could not find: role, aliases, what the member provides and consumes. |
| catalog | script | Checks every reported fact against its file, builds a catalog of everything the members provide, and searches every member for literal mentions of it (candidates), skipping test files and the files Normal protects (`.env*`, key and certificate files). |
| usage | agent `workspaceUsageMapper` | One investigator per member confirms or rejects its candidates and reports further uses: dynamic URLs, generated clients, configuration. |
| join | script | Checks the reported uses, joins consumers to providers into edges, and computes the change order (providers first) and any cycles. |
| synth | agent `workspaceSynthesizer` | Writes the overview, missing roles and change-coordination notes. |
| render | script | Renders the description. |

- At most 8 investigators run at a time: worca caps each scan agent's parallel tool calls at 8,
  and the agent dispatches its investigators in the foreground, in waves of up to 8.
- A reported fact whose text is not on or near the cited line is moved to where the text is in
  that file, or dropped; a path never leaves the member's checkout.
- A script stage never fails the run on bad data: it records what went wrong and continues with
  what it has. Without a survey or usage result the static facts remain; without a synthesis
  the overview is generated.
- The scan agent model runs survey, usage and synth; the project agent model runs their
  investigators (Settings › General › Workspaces, or the scan's own Models pick).

## Coverage and confidence

Coverage, per member:

| Level | When |
|---|---|
| rich | stack recognised, at least 3 facts outside tests, at most 2 unresolved facts (a route, call or topic whose name is not a literal, a manifest that does not parse), no detector error, not truncated |
| partial | everything between |
| none | nothing scanned, extraction failed, or an unrecognised stack with no facts outside tests — the survey investigates the member in full |

Confidence, per edge:

| Confidence | Meaning |
|---|---|
| exact | code found the use and the definition under the same key (for example `http:GET /invoices/{}`), or a use whose literal host is one of the member's aliases |
| verified | an agent reported one end — a use of a catalog entry, or a fact the survey found — and its cited line checks out |
| heuristic | code matched loosely (path suffix, topic pattern), or a fact on either end is a detector's guess (such as a consumer's host that came only from a configuration key or variable), or a literal candidate stands in for a usage pass that failed |
| inferred | an agent named the relation with evidence on the consumer side only |

Facts that code or the survey found in test files never make edges, and the literal search
skips test files.

## The description

The description is rendered from the map and never exceeds the line budget for the member
count: 300 lines up to 5 members, 500 up to 20, 800 above. When the edges do not fit, lines
collapse — fewer names per line, then one line per member pair, then one per consumer — but no
related pair is dropped. Members the scan could not map, or mapped only partly because their
survey or usage pass failed, are listed under `## Coverage`.

A re-scan replaces the description, hand edits included.

## Reviewing the map

On the **Map** tab you can confirm an edge or reject it, clear either, add an edge the scan
missed (from, to, kind, a one-line name and an optional detail) and delete it again.

- A rejected edge leaves the description and the Map tab's graph; the merged graph file (see
  below) keeps every scanned edge. A manual edge is marked `(manual)` unless the description is
  collapsed to one line per consumer.
- Reviews survive re-scans: they are keyed by edge id (from, to, kind, key) and the next scan's
  description applies them. A confirmed edge the next scan does not find stays on the Map tab
  as missing; the description leaves it out.
- While the description is as the scan wrote it, each review change re-renders it at once.
  After a hand edit, reviews no longer touch it; **Regenerate description** re-renders it and
  discards the hand edit.

The same actions over HTTP:

| Request | Body |
|---|---|
| `GET /api/workspaces/:id/map` | — (answers `map`, `synthesis`, `overrides`, `edges`, `descriptionOrigin`) |
| `PUT /api/workspaces/:id/map/edges/:edgeId` | `{ "state": "confirmed" \| "rejected" \| null }` — scanned edges (`x_…`) only |
| `POST /api/workspaces/:id/map/edges` | `{ "from", "to", "kind", "display", "detail"? }` — member project keys; 201 (200 and the existing edge when one with the same from, to, kind and display exists; 400 while the workspace has no map) |
| `DELETE /api/workspaces/:id/map/edges/:edgeId` | — manual edges (`m_…`) only |
| `POST /api/workspaces/:id/map/render` | — Regenerate description |

## Cross-project graph

When the graphify CLI is installed, worca builds each member's graph in the scan's checkout of
that member before the stages run. With a graph built at that checkout's commit
(`graphify-out/graph.json`), the join attaches the enclosing symbol and up to 3 callers to each
edge end whose cited line lies inside a symbol of that graph. The member graphs are then
merged, with every scanned edge as a link between them (reviews do not change this file), so
`graphify query` and `graphify path` walk across repositories: the whole graphs up to 60 000
nodes and 64 MiB in total, otherwise each member's edge-end nodes and their neighbours within
2 hops (the edge ends are always kept; neighbours stop at 2 000 nodes per member). No
graphify, no merged graph.

The merged graph is kept at `<worcaHome>/store/workspaces/<workspaceId>/workspace-graph.json` and
named on the description's last line:

```
Cross-project graph: <path> — graphify query "<question>" --graph "<path>"
```

## Measuring a scan

`tools/workspace-map-eval.mjs`, in a checkout of the worca repository, scores a map against
labelled truth. It is offline and makes no model calls.

```
node tools/workspace-map-eval.mjs --map <file|runFolder|runId> (--labels <file> | --overrides <workspaceId> | --init <out>) [--json]
```

- `--map` — a `workspace-map.json` (or a stored `{ map, synthesis }` document), a scan's run
  folder, or the id of a scan run (the file in its run folder).
- `--init <out>` — writes a labels template: one entry per edge with `"truth": null`. Set each
  to `true` or `false` and add the relations the scan missed. Never overwrites a file.
- `--labels <file>` — `{ "version": 1, "workspace": "…", "edges": [{ "from", "to", "kind",
  "key"?, "truth" }] }`. `from` and `to` are member project keys, as on the map; `from` uses
  `to`. An entry with `key` (a normalised key such as `http:GET /users/{}`, or a raw one such
  as `GET /users/:id` or `npm:@acme/auth`) is scored per key; one without, per member pair and
  kind. Key entries also count for their pair and kind: true when any is true, false only when
  every edge the map has for that pair and kind is labelled false. A key worca cannot read is
  listed under label errors and not scored; labels that look wrong for the map (another
  workspace, a member the map does not have, a self edge, contradicting truths) are listed
  there too, and still scored.
- `--overrides <workspaceId>` — the workspace's review as labels: confirmed = true, rejected =
  false, manual = true (a relation the scan missed).

The report gives tp / fp / fn, precision and recall per pair and kind and per key, broken down
by kind and by confidence, and lists the missed and spurious edges; `--json` prints the same as
JSON. A predicted edge with no label counts as unlabelled, never as wrong. Run ids and
workspaces are read from worca's database, `<worcaHome>/worca-cc.db` (see
[storage](storage.md#resolution-rules)); `WORCA_HOME=<dir>` reads the home at `<dir>/.worca-cc`.

## Guardrails

The scan runs under the Normal set. Its script stages are worca's own programs, not `claude`
processes: no deny rule reaches them. Extract reads the files its detectors claim in each
member's checkout — `.env` and `.env.*` files such as `.env.example` included, which Normal
protects from agents. Checking a line an agent cites (a survey fact in the catalog, a reported
use in the join) reads that file whatever its name, inside the member's checkout. The
catalog's search for literal mentions skips the files Normal protects (`.env*`, `*.pem`,
`*.key`, `id_rsa`, `id_ed25519`, `*.p12`, `*.pfx`). What the stages record (a URL, a topic, a
table name, with its file and line) is stored in the map, shown on the Map tab, and given to
the scan's agents in their briefs. Credentials in what they read — URL passwords, password,
token and API-key values, `Authorization` header values, well-known API token formats (GitHub,
GitLab, Slack, Stripe, Google, OpenAI, Anthropic, npm), webhook URL tokens (Slack, Discord,
Teams, Telegram), AWS access key ids and PEM blocks — are replaced by `***` before anything is
recorded (a token keeps its prefix, such as `ghp_***`). See [guardrails](guardrails.md).
