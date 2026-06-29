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
- **Toolbar** (top): `+ agent`, `+ task`, `auto: on/off` (the dispatcher),
  `reset`.
- **Click an agent** to select it, then from its panel: **pause / resume**,
  **assign** the next task, **send to** any zone, or **remove** it.
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

## Make the agents real

The agents currently *simulate* work. To have them actually do something, you
replace **one function** — the executor's `step()` in
[`server/agent-runtime.js`](server/agent-runtime.js) — e.g. with a model call.
Nothing else changes. Worked example (including an LLM executor) in
[docs/ORCHESTRATION.md §7](docs/ORCHESTRATION.md#7-making-the-agents-real).

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
