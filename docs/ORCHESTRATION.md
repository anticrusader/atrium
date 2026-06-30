# Understanding Agent Orchestration (with this project)

A hands-on guide. Every concept here maps to a file you can open, read, and
change. By the end you'll know what an orchestrator *is*, how to build one, and
how to turn the simulated agents in this project into real ones.

> 📊 Prefer pictures? **[DIAGRAMS.md](DIAGRAMS.md)** visualizes everything below —
> the system, the tick loop, the agent state machine, skills, dispatch, the
> RPA/custom-skill flows, multi-agent handoff, and how results become files.

---

## 1. What "orchestration" actually means

An **agent** is a worker that can take a task, do some steps, and report back.
On its own, one agent is just a loop. **Orchestration** is everything *around*
the agents that makes a *fleet* of them useful:

- **deciding who does what** (scheduling / dispatch)
- **tracking state** (which agents exist, what they're doing)
- **moving work through stages** (a task board: backlog → in progress → done)
- **letting an operator intervene** (pause, reassign, add work)
- **observing the whole thing** (telemetry, the dashboard)

> Monitoring answers *"what is happening?"* Orchestration answers
> *"what should happen next, and make it so."* This project does both.

A useful mental model — borrowed from Kubernetes, CI runners, and actor systems —
is the **control loop**:

```
        ┌─────────────────────────────────────────────┐
        │                                             │
        ▼                                             │
   1. INTAKE  →  2. DISPATCH  →  3. ADVANCE  →  4. PUBLISH
   (commands)    (scheduler)     (run agents)    (telemetry)
        │                                             ▲
        └──────────────── operator watches ───────────┘
```

You **declare intent** (commands), the orchestrator **reconciles** the world
toward that intent every tick, and you **observe** the result. That loop is the
whole game. Open [`server/orchestrator.js`](../server/orchestrator.js) — the
`tick()` method *is* steps 2–4, literally in that order.

---

## 2. The three layers in this repo

| Layer | Role | Files |
|---|---|---|
| **Agent runtime** | one agent's lifecycle | [`server/agent-runtime.js`](../server/agent-runtime.js) |
| **Orchestrator** | the fleet + task board + scheduler | [`server/orchestrator.js`](../server/orchestrator.js) |
| **Transport + UI** | commands in, telemetry out, 3D view | [`server/index.js`](../server/index.js), [`src/`](../src/) |

These are deliberately separate. The runtime knows nothing about WebSockets; the
transport knows nothing about how an agent thinks. That separation is what lets
you swap any one layer (e.g. replace simulated work with real model calls)
without touching the others.

---

## 3. An agent is a state machine

Open [`server/agent-runtime.js`](../server/agent-runtime.js). An agent moves
through explicit states:

```
IDLE ──assign(task)──▶ WALKING ──arrive──▶ THINKING ⇄ WORKING ──▶ MESSAGING ──▶ done ──▶ IDLE
```

Each `tick()` advances the machine by one step. Why a state machine and not just
"call the model in a loop"? Because orchestration needs to **see and control**
the in-between states: you can't pause, visualize, or reassign a black-box
`while(true)`. Explicit states give you handles.

**The seam that matters:** the `WORKING` state calls `executor.step(agent, task)`.
The default `simulatedExecutor` just advances a progress bar. That is the *one
function* you replace to make agents do real work (§7).

---

## 4. The orchestrator is a scheduler + a ledger

Open [`server/orchestrator.js`](../server/orchestrator.js). It holds two maps:

- `agents` — the fleet (the workers)
- `tasks` — the board (the work)

and it does two jobs every tick:

**Dispatch (the scheduler).** `_dispatch()` matches idle agents to backlog
tasks. The policy here is the simplest possible — *greedy, oldest-task-first*:

```js
const idle = agents.filter(a => a.status === 'idle')
const backlog = tasks.filter(t => t.state === 'backlog')
// give each idle agent the next waiting task
```

This is the single most important place to understand, because **the scheduler
is where orchestration policy lives.** Real systems make this smarter:

- **priority** — sort the backlog by importance before assigning
- **skills / routing** — only give "review PR" tasks to agents whose `model` can
  code; send "summarize" elsewhere
- **fairness** — round-robin so no agent starves
- **locality / cost** — prefer the cheapest capable agent
- **concurrency limits** — cap how many agents run at once (rate/$$ control)

All of those are *just a different `_dispatch()`*. Try it: change the filter to
sort `backlog` by a `priority` field and watch behavior change.

**Advance + publish (the ledger).** It ticks every agent, collects what
happened into an activity feed, and emits a telemetry snapshot. The orchestrator
is the **single source of truth** — the browser never edits state, it only
reflects what the orchestrator publishes.

---

## 5. The control plane vs the data plane

This is *the* distinction that separates a monitor from an orchestrator.

- **Data plane** (orchestrator → browser): a continuous stream of *what is*.
  Events `snapshot` and `tick`. The dashboard is a passive mirror.
- **Control plane** (browser → orchestrator): discrete *requests to change*.
  Commands like `spawn`, `assign`, `pause`, `move`.

Both travel over one WebSocket, but they are different *directions* with
different *semantics*. See [`server/protocol.js`](../server/protocol.js), which
defines both and is imported by **both** the server and the browser so the
contract can't drift. Full message reference: [`PROTOCOL.md`](./PROTOCOL.md).

The golden rule: **the UI never mutates state directly.** Click "pause" → it
sends a `pause` command → the orchestrator applies it → the change comes back in
the next `tick`. This "declare intent, observe reconciled state" pattern is why
the same dashboard works whether you're driving 24 simulated agents or a real
fleet — it's just sending requests and rendering replies.

---

## 6. Follow one click end-to-end

You select an agent and press **pause**. Here's the whole path:

1. **[`src/scene/world.js`](../src/scene/world.js)** raycasts your click to an
   agent and fires `onSelect(record)`.
2. **[`src/ui/controls.js`](../src/ui/controls.js)** shows the command panel;
   pressing pause calls `send('pause', { agentId })`.
3. **[`src/sim/gateway.js`](../src/sim/gateway.js)** (`RemoteGateway.send`) wraps
   it in a command envelope and pushes it over the socket.
4. **[`server/index.js`](../server/index.js)** receives it, validates it's a real
   command, calls `orchestrator.apply('pause', …)`, replies with an `ack`.
5. **[`server/orchestrator.js`](../server/orchestrator.js)** sets the agent's
   status to `paused`.
6. Next **tick**, the new state is broadcast; the avatar turns red and stops.

Nothing skipped a layer. That discipline is what keeps orchestration systems
debuggable as they grow.

---

## 7. Making the agents *real*

Right now "work" is simulated. To make agents actually do something, replace the
executor. The contract (`server/agent-runtime.js`):

```js
export const myExecutor = {
  // called while an agent is WORKING a task; advance progress, return a note
  async step(agent, task) {
    // ...do one unit of real work...
    return { delta: 0.34, note: 'drafted section 2' }
  },
}
```

A real version that calls a model (pseudocode — wire your own SDK/key):

```js
import Anthropic from '@anthropic-ai/sdk'
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export const llmExecutor = {
  async step(agent, task) {
    task.scratch ??= []
    const res = await client.messages.create({
      model: 'claude-opus-4-8',           // or a Hermes endpoint
      max_tokens: 512,
      messages: [
        { role: 'user', content:
          `You are agent ${agent.name}. Task: "${task.title}".\n` +
          `Progress so far: ${task.scratch.join('\n')}\n` +
          `Do the next small step and report it in one line.` },
      ],
    })
    const note = res.content[0].text.trim()
    task.scratch.push(note)
    // decide completion however you like — a tool result, a "DONE" sentinel, etc.
    const done = /\bDONE\b/.test(note) || task.scratch.length >= 5
    return { delta: done ? 1 : 0.25, note }
  },
}
```

Then pass it in: `new Orchestrator({ executor: llmExecutor })`. **Nothing else
changes** — the state machine, scheduler, transport, and dashboard are all
unaffected. That is the payoff of keeping the executor as a seam.

> ⚠️ Real executors are slow and cost money. Keep `step()` doing *one small
> unit* per call so the tick loop stays responsive, and add a concurrency cap in
> `_dispatch()` (e.g. "no more than 4 agents WORKING at once") so you don't fire
> 50 parallel model calls.

### Patterns you can now build

- **Multi-step agents** — keep `task.scratch` as the agent's working memory; the
  `THINKING ⇄ WORKING` loop becomes plan → act → observe (a basic ReAct loop).
- **Multi-agent collaboration** — when an agent finishes, have it *create a new
  task* (`orchestrator.createTask`) for a teammate. The `MESSAGING` state is
  where one agent hands off to another.
- **Supervisor / hierarchy** — add a special "manager" agent whose job is to
  break a big task into subtasks and put them on the backlog; worker agents pick
  them up. This is how planner/worker architectures work.
- **Human-in-the-loop** — add a `needs_review` task state; the dispatcher skips
  it until an operator clicks "approve" (a new command). You already have the
  command plumbing.

---

## 8. Bridging a real Hermes fleet (instead of simulating)

`server/index.js` is the integration point. Two ways to connect real agents:

1. **Server-side bridge.** If your Hermes agents run as processes/services,
   subscribe to their events inside the server and feed them into the
   orchestrator's state (or have the orchestrator's commands call into them).
   The dashboard doesn't change.
2. **Client-side feed.** If something else already emits agent telemetry over a
   socket, point the dashboard straight at it with
   `?feed=ws://your-host:port` and implement the normalization in
   `RemoteGateway._onFrame` / the server's event shape.

Either way, the agent-record and task-record shapes in
[`PROTOCOL.md`](./PROTOCOL.md) are the only contract you must satisfy.

---

## 9. Exercises (learn by changing one thing)

1. **Priority scheduling.** Add a `priority` to `createTask`, sort the backlog by
   it in `_dispatch()`. Watch high-priority work jump the queue.
2. **Skill routing.** Tag tasks with a required capability; only assign to agents
   whose `model` matches. Send the rest back to backlog.
3. **Concurrency cap.** Limit `WORKING` agents to N. Observe the backlog grow and
   drain — this is rate/cost control.
4. **A real executor.** Wire `llmExecutor` from §7 against any model you have a
   key for. Start with one agent so you can read every step.
5. **Agent-to-agent handoff.** On completion, have a "researcher" spawn a
   "writer" task. You've just built a two-stage pipeline.

Each is a few lines in one file. That's the point: once the loop and the layers
are in place, orchestration *behavior* is small, local, and yours to design.
