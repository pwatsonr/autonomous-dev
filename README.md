# autonomous-dev

**An autonomous, self-improving AI development system for Claude Code — and an AI-native onboarding platform for any GitHub org.**

It does two things:

1. **Runs a full development pipeline autonomously.** You submit a product
   request; a continuously-running daemon decomposes it through
   **PRD → TDD → Plan → Spec → Code**, reviews its own work at every gate, opens
   a pull request, watches it stabilize, and even generates its own improvement
   PRDs.
2. **Onboards a whole GitHub org (ONBOARD).** Link an org → it ingests every
   repo read-only, builds **per-repo and per-project knowledge**, infers how the
   repos group into projects, proposes scoped skills, and makes each repo
   **ready to self-improve** — all visible and steerable from a web portal and
   from Discord/Slack chat commands.

> This is a wiki-style overview: what the product is, the vocabulary, the
> surfaces (portal pages, chat, CLI), and how to use it end-to-end. For deep
> daemon/config/troubleshooting detail see
> [the full plugin guide](plugins/autonomous-dev/README.md); for the onboarding
> internals see the [`docs/`](docs/) directory.

---

## Table of contents
- [What it is](#what-it-is)
- [Core concepts (the vocabulary)](#core-concepts-the-vocabulary)
  - [Org → Project → Repo → Team](#org--project--repo--team)
  - [Scope and resolution](#scope-and-resolution)
  - [Managed vs user-owned](#managed-vs-user-owned)
  - [Ingestion ≠ Enrollment](#ingestion--enrollment)
  - [The pipeline + review gates](#the-pipeline--review-gates)
- [The three surfaces](#the-three-surfaces)
  - [1. The Portal (web UI)](#1-the-portal-web-ui)
  - [2. Chat triggers (Discord / Slack)](#2-chat-triggers-discord--slack)
  - [3. The CLI](#3-the-cli)
- [How to use it (walkthroughs)](#how-to-use-it-walkthroughs)
- [Architecture](#architecture)
- [Safety model](#safety-model)
- [Installation](#installation)
- [Documentation map](#documentation-map)

---

## What it is

autonomous-dev is a **daemon** (a background process managed by launchd/systemd)
plus a set of Claude Code plugins. The daemon polls for work, runs each request
through a multi-agent pipeline, and enforces cost/safety limits the whole time.
Around that core, the **ONBOARD** system turns it from "run one request" into
"continuously understand and improve an entire organization's codebase."

**The pipeline half** is for getting work done: submit "add rate limiting to the
orders API" and the system writes the PRD, the technical design, a plan, specs,
the code + tests, reviews each artifact against rubrics, and opens an integrated
PR — pausing for you only at the gates you configure.

**The ONBOARD half** is for scaling that across a company: point it at a GitHub
org and it crawls every repository (read-only), extracts each one's stack,
standards, ownership, and domain language into a **scoped memory tree**, builds a
**cross-repo graph** (in Neo4j) of how things relate, groups repos into
**projects**, and proposes repo- and project-specific skills. You then choose
which repos to **enroll** for autonomous improvement, and drive work by toggles
in the portal or by typing `/autodev` in chat.

---

## Core concepts (the vocabulary)

### Org → Project → Repo → Team

ONBOARD models your code as a four-level hierarchy:

| Level | What it is | Example |
|-------|-----------|---------|
| **Org** | The linked GitHub organization — the root of everything ingested | `acme` |
| **Project** | A logical group of repos that belong together (a microservice system, a product line, a business unit) | `payments` |
| **Repo** | A single repository; belongs to one project, or stands alone | `acme/orders` |
| **Team** | A flexible **tag** on projects/repos for filtering (the dimension is yours — team, domain, product-line…) | `team: checkout` |

Repos are grouped into projects either by **inference** (the system clusters them
by shared dependencies, code-owners, schemas, and naming) or by your explicit
assignment. Context flows **down** the hierarchy: a repo inherits its project's
context, which inherits the org's.

### Scope and resolution

Every piece of knowledge, every agent/skill, carries a **scope**:
`global`, `project:<id>`, or `repo:<id>`. When the system needs the context or
agent for a given repo, it resolves **most-specific-wins** — a repo-scoped item
overrides a project-scoped one, which overrides global. This is what lets one
org have universal conventions *and* repo-specific quirks at the same time.

### Managed vs user-owned

Agents, skills, and standards are either:
- **`managed: true`** — AI-owned. The self-improvement lifecycle (baseline →
  shadow → frozen → promoted) applies; the system may rewrite them over time.
- **`managed: false`** — **user-owned and authoritative.** The system *must load
  and honor* them but **must never modify** them. This is where you put business
  goals, architecture constraints ("this service is Go-only"), and compliance
  rules. They shape every run but are never touched by the AI.

### Ingestion ≠ Enrollment

Two separate, deliberate steps:
- **Ingestion** is **read-only** — crawling a repo to build its memory + graph.
  Linking an org ingests *everything*. Nothing is changed.
- **Enrollment** is opt-in — you toggle which repos may participate in
  **autonomous improvement** (the part that spends money and opens PRs). A repo
  can be fully ingested and understood while staying un-enrolled.

### The pipeline + review gates

A request flows through phases, each run by a specialist agent and checked at a
gate before advancing:

```
intake → PRD → TDD → Plan → Spec → Code → review → integrate (PR) → stabilization watch
```

Reviews score against rubrics (security, correctness, edge cases,
accessibility, standards…). **Trust levels** and **review gates** decide where a
human must approve vs where the system proceeds on its own. Every run is
bounded by **cost caps** and can be halted instantly with the **kill switch**.

---

## The three surfaces

### 1. The Portal (web UI)

A local web app (separate `autonomous-dev-portal` plugin) bound to
**`http://127.0.0.1:19280`**. It's where you *watch* and *steer* the system. The
onboarding pages — the "different pages" — are:

| Page | What it shows / does |
|------|----------------------|
| **`/onboard`** | The **Org / Project / Repo browser.** Filter and page through everything ingested. The **org** view lists projects + standalone repos; a **project** view lists its member repos + shared context; a **repo** view drills into that repo's extracted memory (stack, standards, ownership, domain). |
| **`/onboard/repo/<id>`** | Deep-dive on one repo: its memory topics and details. |
| **`/onboard/ingestion`** | **Live ingestion status** (polls every 5s) — how many repos are crawled, have memory, are blocked, have pending questions or skill proposals. |
| **`/onboard/questions`** | **Answer blocking questions.** When ingestion hits an ambiguity it can't resolve ("is repo X part of project Y?"), it pauses that repo and asks here; you answer and it resumes. |
| **Enroll toggle** (`/onboard/enroll`, `/onboard/unenroll`) | Turn a repo's autonomous-improvement participation on/off. |

The portal also surfaces the day-to-day pipeline: request queue, run progress,
audit log, and daemon health. (Localhost-only; tunnel with
`ssh -L 19280:localhost:19280` to view remotely.)

### 2. Chat triggers (Discord / Slack)

Type a scoped command in a channel the bot is in:

```
/autodev repo acme/orders fix the flaky retry test in the checkout flow
/autodev project payments add structured logging across the services
```

The system resolves the scope, authorizes you, enqueues a full pipeline run,
replies with an acknowledgement, then reports back when it's **done**, **failed**,
or **stabilized** (CI green for 3 days). Both platforms are supported; the inbound
listener runs as `autonomous-dev triggers serve`. (Setup:
[`docs/ONBOARD-phase4-deploy.md`](docs/ONBOARD-phase4-deploy.md).)

### 3. The CLI

`autonomous-dev <family> <verb>`. The main families:

```bash
# Pipeline
autonomous-dev request submit "Add pagination to /api/users" --repo owner/name
autonomous-dev request list
autonomous-dev request status REQ-000042
autonomous-dev request cancel REQ-000042 --yes

# Onboarding
autonomous-dev org link acme                 # link a GitHub org
autonomous-dev org ingest                     # crawl every repo (read-only)
autonomous-dev project infer                  # cluster repos into projects
autonomous-dev repo assign acme/orders --project payments --path /abs/checkout
autonomous-dev repo enroll acme/orders        # opt a repo into auto-improvement
autonomous-dev questions list                 # ingestion questions awaiting answers
autonomous-dev graph sync                      # push the cross-repo graph to Neo4j
autonomous-dev graph status

# Scoped skills (Hermes-style auto-generation)
autonomous-dev artifact propose               # propose skills from ingested memory
autonomous-dev artifact list
autonomous-dev artifact accept <id>           # human-gated promotion

# Triggers + daemon ops
autonomous-dev triggers serve                  # run the Discord/Slack inbound listener
autonomous-dev triggers watch-tick             # one stabilization-watch tick
autonomous-dev daemon status
autonomous-dev install-daemon --force
autonomous-dev config show
```

See the [full commands reference](plugins/autonomous-dev/README.md#commands-reference)
for every verb and flag.

---

## How to use it (walkthroughs)

**A. Install + start.** Install the plugin (below), then
`autonomous-dev install-daemon` to register and start the background daemon.
Confirm with `autonomous-dev daemon status` (you want a fresh heartbeat).

**B. Run one request.** `autonomous-dev request submit "…" --repo owner/name`
on a repo that's on the daemon allowlist. Watch it advance in the portal or with
`autonomous-dev request status <id>`. It ends in an integrated PR. *(A full run
costs roughly a few dollars and runs autonomously — set your cost caps first.)*

**C. Onboard an org.** `org link <org>` → `org ingest` (read-only) →
`project infer`. Watch progress at `/onboard/ingestion`; answer anything that
shows up at `/onboard/questions`. For each repo you want to act on:
`repo assign … --path <local checkout>` and add that path to the allowlist, then
`repo enroll <id>`.

**D. Drive from the portal.** Browse `/onboard`, drill into a repo's memory,
flip enrollment toggles, and answer questions — all without the CLI.

**E. Drive from chat.** Provision the bots, run `autonomous-dev triggers serve`,
and `/autodev repo <id> <task>` from Discord/Slack.

---

## Architecture

```
                ┌──────────────── you ────────────────┐
          Portal (127.0.0.1:19280)   Discord/Slack   CLI
                └───────┬───────────────┬─────────────┬┘
                        ▼               ▼             ▼
                  ┌──────────────── intake ─────────────────┐
                  │ adapters · authz · rate-limit · sanitize │
                  │ scoped /autodev triggers                 │
                  └───────────────────┬──────────────────────┘
                                      ▼
   ┌──────────────────────── the daemon ────────────────────────┐
   │ supervisor loop · pipeline (PRD→…→Code) · review gates ·     │
   │ cost caps · kill switch · stabilization watch               │
   └───┬───────────────┬───────────────┬───────────────┬─────────┘
       ▼               ▼               ▼               ▼
  agent-factory     memory          graph          ingestion
  (18+ agents,    (scoped tree:   (Neo4j cross-   (read-only org
   self-improve)   global→repo)    repo relations) crawl)
```

- **Core plugin** `plugins/autonomous-dev/` — the daemon, the 18+ agents, the
  intake framework, the ownership/scope/memory/graph subsystems, the CLI.
- **Portal plugin** `plugins/autonomous-dev-portal/` — the local web UI.
- **Deploy backends** `plugins/autonomous-dev-deploy-{aws,gcp,azure,k8s}/` —
  optional, one per cloud; install only what you need.
- **Assist plugin** `plugins/autonomous-dev-assist/` — guided setup,
  troubleshooting, and an eval harness.

---

## Safety model

The system spends money and writes code, so safety is layered:
- **Allowlist** — the daemon only ever acts on repositories you explicitly add.
- **Cost caps** — per-request, daily, and monthly USD ceilings; work stops at the
  cap.
- **Kill switch + circuit breaker** — halt everything instantly; auto-pause on
  repeated crashes.
- **Review gates + trust levels** — humans approve where you decide they must.
- **`managed: false`** — your business/architecture/compliance context is honored
  but never modified by the AI.
- **Prompt-injection filtering + per-user rate limits** on every inbound request.
- **Read-only ingestion** — understanding a repo never changes it.
- **Secrets** are stored `0600` / in env, never logged or committed.

---

## Installation

```bash
# Add the marketplace
claude plugin marketplace add pwatsonr/autonomous-dev

# Install the core plugin
claude plugin install autonomous-dev

# (optional) the web portal and cloud deploy backends
claude plugin install autonomous-dev-portal
claude plugin install autonomous-dev-deploy-aws   # …-gcp / -azure / -k8s
```

Then `autonomous-dev install-daemon` to start the background daemon. Requires
Claude Code 4.0+.

---

## Documentation map

| Doc | Covers |
|-----|--------|
| [plugins/autonomous-dev/README.md](plugins/autonomous-dev/README.md) | **Full daemon guide** — quick start, every command, configuration, usage examples, architecture, security, troubleshooting |
| [docs/ONBOARD-integration.md](docs/ONBOARD-integration.md) | The end-to-end onboarding flow + operator go-live checklist |
| [docs/ONBOARD-phase4-deploy.md](docs/ONBOARD-phase4-deploy.md) | Activating the Discord/Slack `/autodev` triggers (bots, tokens, the listener) |
| `plugins/autonomous-dev-portal/README.md` | The web portal |
| `plugins/autonomous-dev-assist/` | Setup wizard + troubleshooter |

## License

MIT
