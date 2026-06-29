# CLAUDE.md — project context for Claude Code

This file is auto-loaded by Claude Code. It carries the history and intent of
this project so work can continue on any machine after a `git pull`.

## What this is

**Atrium** (formerly "Hermes Agora") — a self-hostable "living 3D office" that
visualizes AND orchestrates AI agents. Originally inspired by
[hermesagora.com](https://www.hermesagora.com/); built from scratch in this repo
and **extended from a pure monitor into a small agent orchestrator**. The GitHub
repo is `anticrusader/atrium` (the local folder may still be named `hermesagora`).

**Why it exists:** the owner is using it to **learn agent orchestration
hands-on**. Prioritize clarity and teachability over cleverness. The teaching
guide in [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) is a first-class artifact
— keep it accurate as the code evolves.

## Architecture (one screen)

```
browser ── COMMANDS (spawn, assign, pause, move…) ──▶ orchestrator
browser ◀─ EVENTS   (snapshot, tick: agents+tasks+host) ── orchestrator
```

- **Dashboard** (`src/`, Three.js + Vite): renders the 3D office + HUD, sends
  commands, never mutates state directly.
  - `src/scene/{world,office,agent}.js` — renderer/camera/picking, zones+furniture, avatar state machine
  - `src/ui/{hud,controls}.js` — telemetry overlay + task board; the operator control surface
  - `src/sim/gateway.js` — `MockGateway` (in-browser sim) and `RemoteGateway` (WS to backend); both expose `.send(type,payload)`
- **Orchestrator** (`server/`, Node + `ws`): the source of truth.
  - `server/orchestrator.js` — the control loop: intake → **dispatch (scheduler)** → advance → publish. `_dispatch()` is where scheduling policy lives.
  - `server/agent-runtime.js` — one agent = a lifecycle state machine with a **pluggable `executor.step()`** (the seam for real work).
  - `server/metrics.js` — REAL host CPU/MEM/DISK.
  - `server/index.js` — WebSocket edge.
- **Shared contract**: `server/protocol.js` — imported by BOTH server and
  browser so message shapes can't drift. Reference: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Run

- `npm install`
- `npm run dev` — dashboard only (simulation runs in the browser).
- `npm run dev:all` — dashboard + orchestrator. Open
  `http://127.0.0.1:5173/?feed=ws://127.0.0.1:8787` to use the real backend.
- `npm run server` — orchestrator only (env: `PORT`, `HOST`, `TICK_MS`).
- `npm run build` — production bundle (verifies all imports compile).

Verified working: production build (13 modules), and a WS smoke test confirming
snapshot + commands (spawn/create_task acked) + tick reconciliation.

## Persistence (state survives restarts)

The orchestrator world — fleet, task board, cumulative completed count, auto flag
— is saved to `server/state.json` (gitignored) every 5s and on SIGINT/SIGTERM,
and restored on boot. See `server/store.js` and `Orchestrator.seed()/toState()/
hydrate()`; `server/index.js` restores if a saved world exists, else seeds.
Restarts no longer wipe custom/named agents. (Hard kills lose at most ~5s.)

## Conventions

- Plain ESM JavaScript (no TypeScript). Vanilla Three.js + DOM (no React).
- Keep the four layers decoupled: runtime ⟂ orchestrator ⟂ transport ⟂ UI.
- Status values: `idle | walking | thinking | working | messaging | paused`.
  Task states: `backlog | assigned | in_progress | done | failed`.
- Zone keys: reception, lounge, designers, library, cafe, playroom, jira,
  conference, office, courtyard.

## Real model executor — DONE (the WHOLE fleet runs on a live model)

Implemented in **`server/executor.js`** (`makeLLMExecutor`). `server/index.js`
loads `.env` (`process.loadEnvFile()`), and if `OPENROUTER_API_KEY` is set it
builds the LLM executor and hands it to the orchestrator; otherwise it falls
back to simulated work. The agent runtime (`server/agent-runtime.js`) was made
**async-aware**: an agent fires one model call in `WORKING`, stays put while it's
in flight, and applies the result on a later tick (never blocks the loop). Each
agent keeps working memory in `task.scratch`.

Key design points (all in `server/executor.js`):
- **Shared rate limiter** (token bucket, `LLM_RPM`, default 15/min) across the
  whole fleet — the free tier is ~20 RPM / ~200 RPD. You can watch the fleet
  bottleneck on it.
- **Model fallback list**: `LLM_MODEL` is comma-separated. On a 429/5xx it
  **rotates to the next model**. Default list starts with on-theme Hermes, then
  working free models.
- Concurrency cap (`maxInFlight`), 429 cooldown, and forced task completion
  after `maxSteps` real steps.

**Reality check (verified):** the on-theme `nousresearch/hermes-3-llama-3.1-405b:free`
is frequently **429 upstream** (shared free capacity), so the executor rotates to
`google/gemma-4-26b-a4b-it:free` (responds in ~3.5s) or
`meta-llama/llama-3.3-70b-instruct:free`. The `:free` slugs rotate over time —
re-probe `GET {baseURL}/models` (filter pricing 0) if they 404.

**Providers (provider-aware `buildExecutor` in `server/index.js`):** `LLM_PROVIDER`
selects the key + default base URL — `nvidia` (NVIDIA_API_KEY,
`integrate.api.nvidia.com/v1`), `openrouter` (OPENROUTER_API_KEY), `groq`, or
`ollama` (local). All OpenAI-compatible. **Current active = NVIDIA build** (much
more generous free tier than OpenRouter): primary model
`meta/llama-3.3-70b-instruct` (fast ~1.3s, clean instruct output), fallbacks
`nvidia/llama-3.3-nemotron-super-49b-v1` + `meta/llama-3.1-8b-instruct`,
`LLM_RPM=30`, `MAX_CONCURRENT=8`. Verified live: tasks complete steadily, real
coherent multi-step output. NOTE: NVIDIA's catalog has **no Hermes/Nous model**,
so the model isn't on-theme; the app is still Hermes Agora.

Config lives in `.env` (gitignored; template in `.env.example`). Never commit
keys. To run live: ensure `.env` has the provider's key, then `npm run dev:all`
and open `?feed=ws://127.0.0.1:8787`. The HUD shows the model name + `(live)`.

### Local fallback (owner's other machine, RTX 3090 24GB)
If hosted free models are too throttled, run locally with Ollama
(OpenAI-compatible at `http://localhost:11434/v1`, model `hermes3:8b` — fits
24GB; 70B does not at a good quant). Just point `.env` at it:
`LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL=hermes3:8b`,
`OPENROUTER_API_KEY=ollama` (any non-empty string).

## Agent-to-agent handoff + WIP cap — DONE

- **WIP / concurrency cap** (`Orchestrator.maxConcurrent`, env `MAX_CONCURRENT`,
  default 6): the dispatcher won't run more than N tasks at once. This fixes the
  "18 in-progress, nothing moving" look under a rate-limited model — a few tasks
  progress and complete while the rest of the fleet idles in social zones.
- **Handoff**: when a stage-1 task completes, `Orchestrator._maybeHandoff()`
  (~45%) creates a stage-2 follow-up task (`review:`/`QA:`/`write up:` …) that a
  *different* idle agent picks up — a 2-stage pipeline. Chains stop at stage 2.
  The dispatcher prioritizes stage-2 tasks so pipelines drain. Verified: 63
  completions → 22 handoffs in a 140-tick simulated run.
- `executor.js` `maxSteps` lowered to 3 (fewer calls per task → faster drain).

### Free-tier reality (important)
Free `:free` models share GLOBAL capacity and the daily ~200-request cap is easy
to hit with an 18-agent fleet. When all models in `LLM_MODEL` are 429, the board
legitimately stalls (zero progress) — this is the free tier, not a bug. Mitigate
by lowering `MAX_CONCURRENT`/`LLM_RPM`, waiting for the daily reset, or using a
LOCAL model (see RTX 3090 note above) which has no limits. DeepSeek V4 exists but
`deepseek-v4-flash` is currently *paid-but-cheap* (~$0.09/M), not in the free
catalog.

## Real research task — DONE (genuinely real work, not simulated)

Most tasks are simulated narration. A task with `kind:'research'` does REAL work
(`server/research.js`, routed from `executor.js`): (1) SEARCH the live Wikipedia
API for `task.topic`, (2) READ the real article extract, (3) SUMMARIZE that real
content with the model. "Done" = a grounded summary was actually produced
(stored on `task.result`); the 📚 summary appears in the activity feed. Phases
advance one per tick via the same async WORKING loop. Only the summarize phase
spends a rate-limiter token (search/read are free Wikipedia calls).

- Created via: the **`+ research`** toolbar button (sends `create_task {kind:'research'}`),
  the seed (2 at boot), and the trickle (~30%). Research happens in the library.
- `Orchestrator._wireTasks()` strips `_`-prefixed fields (e.g. `_extract`) from
  the wire payload.
- Verified live: e.g. "searched Wikipedia for 'black holes' → found 'Black hole'"
  → "read … 608 chars of real content" → "📚 A black hole is an extremely compact
  astronomical body whose gravity is so strong that nothing, including light, can
  escape from it."
- NOTE: offline `MockGateway` can't fetch, so it only *labels* research tasks and
  narrates them — real research needs the backend (`?feed=ws://…`).
- This is the template for ALL real work: swap Wikipedia for any tool (web
  search, file read, API, test runner) and decide completion from real results.

## Real fact-check pipeline (multi-agent, 2 stages) — DONE

A real 2-stage collaboration on real data (`server/research.js`
`factCheckStep` + `verifyStep`):
- **Stage 1 (`kind:'factcheck'`)** — Agent A researches a CLAIM against Wikipedia
  and gives a verdict (SUPPORTED/CONTRADICTED/UNCLEAR), shown as `⚖️ …`. Happens
  on the jira floor.
- **Handoff** — on completion, `_maybeHandoff` ALWAYS creates a `kind:'verify'`
  stage-2 task carrying the claim + stage-1 verdict, and sets `_exclude = doer`
  so a DIFFERENT agent must take it.
- **Stage 2 (`kind:'verify'`)** — Agent B pulls an INDEPENDENT second source
  (DuckDuckGo Instant Answer, Wikipedia fallback — retrieved by SUBJECT/topic,
  not the full claim) and CONFIRMs/DISPUTEs A's verdict, shown as `✅`/`❌`.
  Happens in the conference hall.

Created via the **`+ fact-check`** toolbar button, seed (1), and trickle (~15%).
Claims live in `CLAIMS` (orchestrator). `_dispatch` now ranks backlog: stage-2
verify > real (research/factcheck) > simulated, so real work is promptly visible
and doesn't starve under the shared rate limit. `_dispatch` also honors
`_exclude` (skips the stage-1 agent). The per-tick event window was widened
(`events.slice(-16)`) so verdicts aren't dropped when many agents emit at once.

Verified live on NVIDIA: e.g. Zephyr Dune ⚖️ CONTRADICTED → handoff → Nico Dune
✅ CONFIRM (different agents). NOTE: stage 1 reads only the short Wikipedia
summary extract, so a true claim can read as CONTRADICTED if the summary omits
it — honest behavior ("the source doesn't support this"), not a bug.

## Agent SKILLS + skill-based scheduling — DONE

Agents are no longer interchangeable. Each `Agent` has a `skills: string[]`
(capabilities). A task `kind` can REQUIRE a skill via `SKILL_FOR_KIND` in
`server/protocol.js`; the dispatcher (`_dispatch`) only assigns a skill-gated
task to an idle agent that owns the skill. Kinds NOT in the map (research /
factcheck / verify / sim) stay open to anyone. This is the "skill-based
scheduling" step that was on the list.

- **A skill = a capability + routing.** Capability = a task kind with a real
  `step()`; routing = `SKILL_FOR_KIND[kind]` gating which agent gets it.
- Skills persist (in `toState`/`hydrate`) and ride the wire (`toRecord`). The
  UI shows them as chips + a ★ on specialist rows; spawn one with **`+ specialist`**
  (or `set_skills` command to grant an existing agent a skill). `seed()` creates
  two specialists out of the box (a Solution Architect + an Inbox Assistant).
- When skill-gated work has NO capable agent, `_warnMissingSkill` emits an
  `orchestrator waiting: no agent has skill "X"` line **into the per-tick events**
  (not just the internal feed), so the board explains itself instead of stalling
  silently. Throttled to once / ~30 ticks / skill.

### Skill: RPA / UiPath Solution Architect (`server/rpa.js`) — DONE, real
Skill key `rpa-architect`, task kind `rpa-design`. Pure-expertise skill (no
external creds): a senior-architect system prompt encodes real UiPath knowledge
(REFramework, Orchestrator queues/assets/credential stores, attended/unattended,
selector strategy, Document Understanding/AI Center, exception handling, SDLC).
Runs in 2 real model calls over 2 ticks: **ANALYZE** the process → **DESIGN** the
UiPath solution (feasibility, components, integration, risks, S/M/L estimate).
Full architecture stored on `task.result`; feed shows `🧩 …` then `🏗️ …`.
Created via **`+ RPA design`** (prompts for the process brief; samples in
`RPA_BRIEFS`). Verified live on NVIDIA: produced a real invoice-processing→SAP
architecture and an onboarding design.

### Custom prompt-skills — DESIGN A SKILL ON THE PAGE — DONE, real
The owner asked "is there a way to design a skill on the page?" — yes. A *knowledge*
skill is just a name + a system prompt (the expertise); only tool-using skills
(email) need code. So the dashboard's **`+ skill`** button lets you author one:
type a skill name + the expertise, and it (1) `define_skill`s it, (2) spawns a
specialist agent with that skill, (3) optionally gives it a first task — no code.
- Stored in `Orchestrator.customSkills` (persisted in state; key+name sent on the
  wire via `_skillCatalog()`, never the prompt body).
- A `custom` task carries its required skill on `task.skill` and the authored
  prompt on `task._system` (server-side only). `requiredSkill(task)` in
  protocol.js unifies built-in (`SKILL_FOR_KIND`) + custom routing, so dispatch,
  the missing-skill warning, handoff-suppression and artifact-saving all treat
  custom skills like first-class specialists.
- Executed by `server/custom-skill.js` `customStep` (the generic form of
  `rpa.js` — one model call grounded in the user's prompt; result saved to a file).
- Verified live: defined a "SQL Expert" from the wire → specialist produced a
  correct composite-index recommendation → saved to `server/outputs/`.

### Skill: Outlook email — read + DRAFT-ONLY (`server/email.js`) — built, needs setup
Skill key `email`, task kind `email`. Reads the Outlook inbox and DRAFTS a reply
via Microsoft Graph; **never sends** (no `/send` call — drafts land in Drafts for
the user to review). Flow: FETCH inbox → TRIAGE (model picks the message most
needing a reply) → DRAFT (model writes the body; `createReply` + PATCH saves it).
- **Auth:** OAuth2 device-code flow (public client, no secret). One-time
  `npm run email:login` caches a refresh token to `server/.msgraph-token.json`
  (gitignored). The step auto-refreshes; degrades gracefully with a clear feed
  note if unconfigured/unauthorized.
- **Setup (user-side, required before it does anything):** register a public-
  client Azure app with delegated Graph `Mail.Read` + `Mail.ReadWrite` +
  `offline_access`; put its client ID in `.env` as `EMAIL_CLIENT_ID`
  (`EMAIL_TENANT=consumers` for personal outlook.com). See the header of
  `server/email.js`. Then spawn an `email`-skilled agent (`+ specialist`).
- Status: code complete + gated; NOT yet verified live (needs the owner's Azure
  registration + sign-in). The "draft only, never auto-send" decision is baked in.

## Possible NEXT STEPS (not done)
- Finish the email skill: do the Azure app registration + `npm run email:login`,
  spawn an `email` specialist, and verify a real draft lands in Drafts.
- More real task kinds (web search via Tavily/Brave, run a shell command, etc.).
- Use fuller article text (not just the summary) for deeper fact-checks.
- Surface the *currently active* model (post-rotation) in the HUD; executor
  exposes `current()`.
- Graceful degradation: when fully rate-limited, optionally let agents make slow
  clearly-tagged "(offline)" progress so the office never looks dead.

## Memory portability

A copy of Claude's project memory is checked in under `.claude/memory/`. On a new
machine, this `CLAUDE.md` loads automatically; to also restore the memory index,
see `.claude/README.md`.
