# CLAUDE.md — project context for Claude Code

This file is auto-loaded by Claude Code. It carries the history and intent of
this project so work can continue on any machine after a `git pull`.

## What this is

**Hermes Agora** — an unofficial, self-hostable rebuild of
[hermesagora.com](https://www.hermesagora.com/): a "living 3D office" that
visualizes AI agents. It was built from scratch in this repo and then **extended
from a pure monitor into a small agent orchestrator**.

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

Config lives in `.env` (gitignored; template in `.env.example`). Never commit
keys. To run live: ensure `.env` has the key, then `npm run dev:all` and open
`?feed=ws://127.0.0.1:8787`. The HUD shows the model name + `(live)`.

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

## Possible NEXT STEPS (not done)
- Priority / skill-based scheduling in `Orchestrator._dispatch()`.
- Surface the *currently active* model (post-rotation) in the HUD; executor
  exposes `current()`.
- Graceful degradation: when fully rate-limited, optionally let agents make slow
  clearly-tagged "(offline)" progress so the office never looks dead.

## Memory portability

A copy of Claude's project memory is checked in under `.claude/memory/`. On a new
machine, this `CLAUDE.md` loads automatically; to also restore the memory index,
see `.claude/README.md`.
