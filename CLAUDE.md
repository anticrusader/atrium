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

## NEXT STEP (agreed, not yet done)

Make **one** agent call a **real model** so the owner can watch a genuine
plan→act→observe loop in the 3D view. Replace `simulatedExecutor.step()` in
`server/agent-runtime.js` (worked `llmExecutor` example in
[docs/ORCHESTRATION.md §7](docs/ORCHESTRATION.md)). Nothing else changes.

**Model priority:**
1. **Free hosted model first** (OpenAI-compatible, so the executor is the same
   code with a different base URL + model id):
   - OpenRouter `nousresearch/hermes-3-llama-3.1-405b:free` — a real free Hermes
     model, on-theme (`https://openrouter.ai/api/v1`, ~20 RPM / ~200 RPD).
   - or Groq `llama-3.1-8b-instant` — fast, ~14,400 req/day
     (`https://api.groq.com/openai/v1`).
2. **If no suitable free model is available, fall back to LOCAL models** on the
   owner's other machine (**RTX 3090, 24GB**): Ollama, OpenAI-compatible at
   `http://localhost:11434/v1`, model `hermes3:8b` (fits 24GB; 70B does not at a
   good quant).

When wiring it: keep `step()` to one small unit per call, add a concurrency cap
in `_dispatch()` so it doesn't fire many parallel rate-limited calls, and start
with a single agent so every step is readable. Never commit API keys — read from
`process.env`.

## Memory portability

A copy of Claude's project memory is checked in under `.claude/memory/`. On a new
machine, this `CLAUDE.md` loads automatically; to also restore the memory index,
see `.claude/README.md`.
