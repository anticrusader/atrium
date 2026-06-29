# Hermes Agora

> A living **3D office for your agents** — watch them walk the floor, pick up
> tasks, think, message, and complete work in real time… and **orchestrate**
> them: spawn agents, create tasks, assign, pause, and route work from the view.

An unofficial, self-hostable take on the [hermesagora.com](https://www.hermesagora.com/)
concept, extended from a *monitor* into a small **agent orchestrator**. Built
with **Three.js + Vite** (dashboard) and a tiny **Node + WebSocket** backend
(orchestrator).

> Independent community project. Not affiliated with Hermes or Nous Research.

New to agent orchestration? Read the guide: **[docs/ORCHESTRATION.md](docs/ORCHESTRATION.md)**.

---

## Quick start

### Option A — dashboard only (simulation, zero backend)

```bash
npm install
npm run dev
```

Open the printed URL (default <http://127.0.0.1:5173>). The orchestration loop
runs **in the browser** — a fleet of agents picks up tasks and works them, and
all the controls (spawn, assign, pause, move) work immediately. Great for
playing with the ideas.

### Option B — dashboard + real orchestrator (recommended for learning)

Run both the web app and the Node orchestrator together:

```bash
npm install
npm run dev:all
```

Then open the dashboard pointed at the orchestrator:

```
http://127.0.0.1:5173/?feed=ws://127.0.0.1:8787
```

Now the fleet, the task board, and the **CPU/MEM/DISK metrics are real**
(sampled from the Node process), state lives server-side, and your commands go
over the wire. If the orchestrator isn't reachable, the dashboard automatically
falls back to the in-browser simulation.

> Run them separately if you prefer: `npm run server` in one terminal,
> `npm run dev` in another.

---

## What you can do

**Watch (monitoring)**
- Ten office zones around a courtyard; agents walk to the right zone for their
  task and animate by state (teal = thinking, green = working, amber =
  messaging, blue = walking, red = paused, grey = idle).
- HUD: status, version, `total / active` counts, per-zone occupancy, host
  meters, the **Jira-floor task board** (backlog / in-progress / done with live
  progress bars), and an activity feed.
- Hover any agent for model / platform / status / task / uptime.

**Drive (orchestration)**
- **Toolbar** (top): `+ agent`, `+ task`, `+ research`, `+ fact-check`,
  `auto: on/off` (the dispatcher), `reset`. The create buttons **prompt you for
  input** — name your own agent, type a task title, a research topic, or a claim
  to fact-check (leave blank for a random one). Your input flows straight into
  the real pipeline (e.g. a typed topic is the actual Wikipedia search).
- **Agent directory** (left): a scrollable list of every agent (name + live
  status). Click a row — or click the agent in the 3D office — to select it
  (the two stay in sync) and expand its details + actions: **pause / resume**,
  **✎ rename**, **assign** the next task, **send to** any zone, **✕ remove**.
- Or from the browser console: `__agora.gateway.send('spawn', { count: 5 })`.

---

## How it works (the short version)

```
  browser  ──────  COMMANDS (spawn, assign, pause…)  ──────▶  orchestrator
  browser  ◀─────  EVENTS   (snapshot, tick: agents+tasks+host)  ───  orchestrator
```

The **orchestrator** is the single source of truth. The dashboard never mutates
state — it sends a command, the orchestrator reconciles the world each tick, and
the result comes back as telemetry. This control-loop split is the core of
orchestration; the long version (with exercises and how to make agents *real*)
is in **[docs/ORCHESTRATION.md](docs/ORCHESTRATION.md)**, and the message format
is in **[docs/PROTOCOL.md](docs/PROTOCOL.md)**.

---

## Project layout

```
index.html              # mount points + boot veil
src/                     # the dashboard (Three.js + DOM HUD)
  main.js               # wires gateway <-> world + HUD + controls
  sim/gateway.js        # data + command layer (MockGateway, RemoteGateway)
  scene/
    world.js            # renderer, camera, lights, avatars, picking/selection
    office.js           # zone layout + furniture
    agent.js            # AgentAvatar (movement + status + selection ring)
  ui/
    hud.js              # telemetry overlay + task board
    controls.js         # the operator control surface (sends commands)
  style.css
server/                  # the orchestrator (Node + ws)
  index.js              # WebSocket edge: snapshots, ticks, command intake
  orchestrator.js       # fleet + task board + dispatcher (the control loop)
  agent-runtime.js      # one agent's lifecycle state machine + executor seam
  metrics.js            # real host CPU/MEM/DISK
  protocol.js           # the shared contract (imported by BOTH sides)
docs/
  ORCHESTRATION.md      # the teaching guide — start here
  PROTOCOL.md           # wire-format reference
```

## Real model executor (the whole fleet on a live LLM)

The agents can run on a **real model** instead of simulated work. This is wired
in [`server/executor.js`](server/executor.js) and enabled automatically when a
key is present.

1. `cp .env.example .env` and put your OpenRouter key in `OPENROUTER_API_KEY`
   (free key: <https://openrouter.ai/keys>). `.env` is gitignored.
2. `npm run dev:all`, then open `http://127.0.0.1:5173/?feed=ws://127.0.0.1:8787`.
3. The HUD shows the model name + `(live)`, and the activity feed fills with the
   model's actual step-by-step reasoning.

How it stays within free limits:

- **Shared rate limiter** across the whole fleet (`LLM_RPM`, default 15/min —
  free tier is ~20 RPM / ~200 RPD). Agents that can't get a slot wait and retry,
  so you can literally watch the fleet bottleneck on the budget.
- **Model fallback list** — `LLM_MODEL` is comma-separated; on a `429` the
  executor rotates to the next model. The default tries on-theme
  `nousresearch/hermes-3-llama-3.1-405b:free` first, then working free models.
- Non-blocking: a slow model call never stalls the tick loop (the agent runtime
  is async-aware).

> Free `:free` models share global capacity and are often `429` / rotate their
> ids. If you hit constant throttling, switch to a **local** model on a GPU box:
> set `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL=hermes3:8b`,
> `OPENROUTER_API_KEY=ollama` (Ollama; any non-empty key). An RTX 3090 (24GB)
> runs `hermes3:8b` comfortably.

To customize *what the agent does* each step (tools, different prompt, real
APIs), edit `step()` in [`server/executor.js`](server/executor.js). Concepts and
patterns: [docs/ORCHESTRATION.md §7](docs/ORCHESTRATION.md#7-making-the-agents-real).

### Real research tasks (genuine tool use)

Most tasks are *simulated* (the model narrates plausible steps). A **research
task** is genuinely real: click **`+ research`** in the toolbar (or it appears
automatically) and the assigned agent will, live:

1. **search** the real Wikipedia API for a topic,
2. **read** the real article extract, then
3. **summarize** that real content with the model.

You'll see it in the activity feed — *searched Wikipedia for "black holes" →
found "Black hole"* → *read … 608 chars of real content* → *📚 A black hole is an
extremely compact astronomical body whose gravity is so strong that nothing,
including light, can escape it.* "Done" means a grounded summary was actually
produced, not a counter. Code: [`server/research.js`](server/research.js). This
is the template for any real tool: swap Wikipedia for web search, a file read, an
API call, or a test runner. (Needs the backend — `?feed=ws://…`; the offline sim
can't make network calls.)

### Real fact-check pipeline (multi-agent, on real data)

Click **`+ fact-check`** and watch a real two-stage, two-agent collaboration:

1. **Agent A** researches a claim (e.g. *"Sharks are mammals"*) against Wikipedia
   and posts a verdict — *⚖️ CONTRADICTED …*.
2. A **handoff** sends that verdict to a **different agent**.
3. **Agent B** independently pulls a **second source** (DuckDuckGo, Wikipedia
   fallback) and *✅ CONFIRM*s or *❌ DISPUTE*s Agent A's conclusion.

This is genuine multi-agent verification: B never saw A's source, only A's
claim and verdict, and reaches its own judgment from independent data. Code:
[`server/research.js`](server/research.js) (`factCheckStep` + `verifyStep`), with
the deterministic handoff in [`server/orchestrator.js`](server/orchestrator.js).

> Caveat: stage 1 reads only Wikipedia's short summary extract, so a *true* claim
> can read as CONTRADICTED when the summary simply doesn't mention it — that's the
> model honestly reporting "the source doesn't support this," not a failure.

## Configuration

| What | Where |
|---|---|
| Orchestrator port / tick rate | env: `PORT`, `HOST`, `TICK_MS` for `npm run server` |
| Initial fleet size | `new Orchestrator({ fleet })` in `server/index.js` |
| Scheduler policy | `_dispatch()` in `server/orchestrator.js` |
| Zones / furniture | `ZONE_LAYOUT` + `decorateZone()` in `src/scene/office.js` |
| Camera / lighting | `src/scene/world.js` |

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dashboard only (in-browser simulation) |
| `npm run server` | Orchestrator only (ws://127.0.0.1:8787) |
| `npm run dev:all` | Both together |
| `npm run build` / `npm run preview` | Production bundle / serve it |
