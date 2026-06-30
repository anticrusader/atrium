# Atrium — How It Works (Diagrams)

Visual companion to [ORCHESTRATION.md](ORCHESTRATION.md) and
[PROTOCOL.md](PROTOCOL.md). Every diagram points at the file that implements it.
Diagrams are [Mermaid](https://mermaid.js.org/) — they render on GitHub and in
most Markdown viewers.

> 🖼️ **Image exports:** every diagram below is also rendered to PNG in
> [`docs/diagrams/`](diagrams/) (e.g. `01-system-architecture.png`) — handy for
> slides, issues, or any viewer that doesn't render Mermaid. After editing any
> Mermaid source below, regenerate the images with **`npm run diagrams`**
> (renders every block via mermaid-cli; see [`diagrams/export.mjs`](diagrams/export.mjs)).

Jump to: [System](#1-system-architecture) ·
[The loop](#2-the-orchestration-loop-one-tick) ·
[Agent](#3-an-agent-is-a-state-machine) ·
[Protocol](#4-one-click-end-to-end-commands--events) ·
[Skills model](#5-what-a-skill-is) ·
[Dispatch](#6-skill-based-dispatch-the-scheduler) ·
[RPA skill](#7-the-rpa-architect-skill-real-2-phase-work) ·
[Custom skills](#8-design-a-skill-on-the-page-custom-prompt-skills) ·
[Handoff](#9-multi-agent-handoff-fact-check--verify) ·
[Deliverables](#10-deliverables-results-become-files)

---

## 1. System architecture

The browser is a **passive mirror**: it sends commands and renders whatever the
orchestrator publishes. The orchestrator is the **single source of truth**. One
WebSocket carries both directions. The shared `protocol.js` is imported by both
sides so message shapes can't drift.

![System architecture](diagrams/01-system-architecture.png)

<details>
<summary>Mermaid source (edit here, then re-export — see top of file)</summary>

```mermaid
flowchart LR
  subgraph Browser["🖥️ Dashboard (src/)"]
    direction TB
    UI["ui/controls.js + ui/hud.js<br/>toolbar · skills panel · task board"]
    World["scene/world.js<br/>3D office + avatars"]
    GW["sim/gateway.js<br/>RemoteGateway / MockGateway"]
    UI --> GW
    World --- GW
  end

  subgraph Server["⚙️ Orchestrator (server/)"]
    direction TB
    Edge["index.js<br/>WebSocket edge"]
    Orch["orchestrator.js<br/>fleet + task board + scheduler"]
    Runtime["agent-runtime.js<br/>Agent state machines"]
    Exec["executor.js<br/>LLM calls + rate limiter"]
    Edge --> Orch --> Runtime --> Exec
  end

  Proto{{"protocol.js<br/>shared contract"}}

  GW -- "▲ COMMANDS<br/>spawn, create_task,<br/>define_skill, …" --> Edge
  Edge -- "▼ EVENTS<br/>snapshot, tick<br/>(agents, tasks, host, skills)" --> GW
  Proto -.imported by.- GW
  Proto -.imported by.- Edge

  Exec --> Tools["real work<br/>research.js · rpa.js<br/>custom-skill.js · email.js"]
```

</details>

---

## 2. The orchestration loop (one tick)

This four-step loop *is* the whole idea — the same shape every orchestrator uses
(k8s, CI runners, actor supervisors). It runs every `TICK_MS` (~1.1s) in
[`Orchestrator.tick()`](../server/orchestrator.js).

![The orchestration loop (one tick)](diagrams/02-orchestration-loop.png)

<details>
<summary>Mermaid source (edit here, then re-export — see top of file)</summary>

```mermaid
flowchart TB
  T["⏱️ tick (every ~1.1s)"] --> D

  subgraph D["2 · DISPATCH — _dispatch(events)"]
    D1["WIP cap: slots = maxConcurrent − busy"]
    D2["rank backlog: stage-2 verify ▸ specialist ▸ research ▸ sim"]
    D3["match each task to an idle agent<br/>that has the required skill"]
    D1 --> D2 --> D3
  end

  D --> A

  subgraph A["3 · ADVANCE — every agent.tick()"]
    A1["agent steps its state machine"]
    A2{"task completed?"}
    A3["💾 saveArtifact() if it has a result"]
    A4["🤝 _maybeHandoff() → stage-2 task"]
    A1 --> A2 -- yes --> A3 --> A4
  end

  A --> P["prune done tasks (keep last 40)<br/>+ trickle new demo work"]
  P --> PUB["4 · PUBLISH<br/>broadcast tick: agents, tasks,<br/>host, completed, skills, events"]
  PUB --> T
```

</details>

---

## 3. An agent is a state machine

Each agent is one worker with a lifecycle ([`agent-runtime.js`](../server/agent-runtime.js)).
The key design point is the **WORKING** state: a real model call takes seconds,
so the agent **fires the call once and stays put** while it's in flight, applying
the result on a later tick — the tick loop never blocks.

![Agent state machine](diagrams/03-agent-state-machine.png)

<details>
<summary>Mermaid source (edit here, then re-export — see top of file)</summary>

```mermaid
stateDiagram-v2
  [*] --> IDLE
  IDLE --> WALKING: assign(task)
  WALKING --> THINKING: arrived (_walk ticks)
  THINKING --> WORKING: planned (_beat ticks)

  state WORKING {
    [*] --> Pending: fire executor.step() once
    Pending --> Pending: call in flight → make no progress
    Pending --> Applied: result lands
    Applied --> [*]: task.progress += delta
  }

  WORKING --> WORKING: more steps needed
  WORKING --> MESSAGING: progress ≥ 1
  MESSAGING --> IDLE: task DONE → drift to a social zone
  IDLE --> PAUSED: operator pause
  PAUSED --> IDLE: resume
```

</details>

> The `executor.step(agent, task)` call is **the seam for real work**. Swap what
> it does and nothing else in the machine changes. See diagram 7.

---

## 4. One click, end-to-end (commands & events)

Declare intent, then observe reconciled state. The browser never mutates
anything directly — it sends a command, gets an `ack`, and sees the change in the
next `tick`. ([PROTOCOL.md](PROTOCOL.md))

![Commands and events](diagrams/04-commands-and-events.png)

<details>
<summary>Mermaid source (edit here, then re-export — see top of file)</summary>

```mermaid
sequenceDiagram
  autonumber
  participant U as You
  participant C as Controls (browser)
  participant WS as WebSocket
  participant O as Orchestrator
  participant Ag as Agent

  U->>C: click "+ RPA" / "+ task"
  C->>WS: command { create_task, … }
  WS->>O: apply(type, payload)
  O-->>WS: ack { id, ok }
  Note over O: next tick…
  O->>O: _dispatch() picks an idle specialist
  O->>Ag: assign(task)
  loop every ~1.1s
    Ag->>Ag: tick() — walk → think → work
    O-->>WS: event { tick: agents, tasks, skills, events }
    WS-->>C: render board, feed, 3D office
  end
```

</details>

---

## 5. What a *skill* is

A **skill = a capability + routing**. The capability is a task `kind` with a real
`step()`; the routing is `requiredSkill(task)` gating *which* agent may take it.
Two flavors:

![What a skill is](diagrams/05-what-is-a-skill.png)

<details>
<summary>Mermaid source (edit here, then re-export — see top of file)</summary>

```mermaid
flowchart TB
  Skill(["A skill"]) --> Cap["Capability<br/>a task kind with a real step()"]
  Skill --> Route["Routing<br/>requiredSkill(task) → only agents<br/>with the skill get the task"]

  Cap --> Built["🔧 BUILT-IN (code-backed)"]
  Cap --> Custom["✨ CUSTOM (prompt-only)"]

  Built --> B1["rpa-architect → kind 'rpa-design'<br/>server/rpa.js"]
  Built --> B2["email → kind 'email'<br/>server/email.js (tools/Graph)"]

  Custom --> C1["authored on the page: name + system prompt"]
  C1 --> C2["stored in Orchestrator.customSkills"]
  C2 --> C3["kind 'custom' → server/custom-skill.js<br/>runs the model with your prompt"]

  Route --> Map["SKILL_FOR_KIND (built-in)<br/>+ task.skill (custom)<br/>— unified by requiredSkill() in protocol.js"]
```

</details>

> Built-in skills need code because they **touch tools** (RPA reasoning, the
> Microsoft Graph API). Custom skills are pure expertise — *just a system
> prompt* — so they can be designed live in the browser.

---

## 6. Skill-based dispatch (the scheduler)

`_dispatch()` is where scheduling policy lives. A skill-gated task only goes to a
capable agent; if none exists, a specialist is **auto-spawned on demand**.

![Skill-based dispatch](diagrams/06-skill-dispatch.png)

<details>
<summary>Mermaid source (edit here, then re-export — see top of file)</summary>

```mermaid
flowchart TB
  Start["for each backlog task (ranked)"] --> R{"requiredSkill(task)?"}
  R -- "none (research/sim)" --> AnyIdle["assign to any idle agent"]
  R -- "a skill" --> Has{"an idle agent<br/>has the skill?"}
  Has -- yes --> Assign["assign to that specialist"]
  Has -- no --> Exists{"does ANY agent<br/>have the skill?"}
  Exists -- yes --> Wait["wait a tick<br/>(specialist is busy)"]
  Exists -- "no" --> Warn["⚠️ feed: 'no agent has skill X'<br/>(_ensureSpecialist already<br/>auto-spawned one at create time)"]
  AnyIdle --> Done([dispatched])
  Assign --> Done
```

</details>

> WIP cap: the loop stops once `maxConcurrent` tasks are in flight, so under a
> rate-limited model a few tasks visibly progress while the rest idle.

---

## 7. The RPA Architect skill (real, 2-phase work)

Skill `rpa-architect`, task kind `rpa-design`
([`server/rpa.js`](../server/rpa.js)). A pure-expertise skill: the value is the
senior-architect **system prompt**. It runs in two real model calls over two
ticks, then the design is saved as a file.

![RPA Architect skill flow](diagrams/07-rpa-architect-flow.png)

<details>
<summary>Mermaid source (edit here, then re-export — see top of file)</summary>

```mermaid
sequenceDiagram
  autonumber
  participant Ag as Sol Architect
  participant RPA as rpaDesignStep (rpa.js)
  participant RL as rate limiter
  participant LLM as model
  participant Art as artifacts.js

  Note over Ag,RPA: phase = (none) → ANALYZE
  Ag->>RPA: step(agent, task)
  RPA->>RL: take() a token
  RPA->>LLM: ANALYZE the process (system: architect persona)
  LLM-->>RPA: steps · systems · rules-vs-judgement · exceptions
  RPA-->>Ag: task._analysis set, phase = design, 🧩 note

  Note over Ag,RPA: next tick → DESIGN
  Ag->>RPA: step(agent, task)
  RPA->>RL: take() a token
  RPA->>LLM: DESIGN solution (grounded in _analysis)
  LLM-->>RPA: feasibility · components · selectors · risks · S/M/L
  RPA-->>Ag: task.result set, phase = done, 🏗️ note

  Note over Ag,Art: on completion (diagram 2)
  Ag->>Art: saveArtifact(task)
  Art-->>Ag: server/outputs/<id>-rpa-design-….md
```

</details>

---

## 8. Design a skill on the page (custom prompt-skills)

The `+ skill` button turns "a name + an expertise prompt" into a working
specialist — no code, no restart. ([`server/custom-skill.js`](../server/custom-skill.js))

![Custom prompt-skill flow](diagrams/08-custom-skill-flow.png)

<details>
<summary>Mermaid source (edit here, then re-export — see top of file)</summary>

```mermaid
sequenceDiagram
  autonumber
  participant U as You
  participant C as Controls
  participant O as Orchestrator
  participant Ag as auto-spawned specialist
  participant CS as customStep
  participant LLM as model

  U->>C: "+ skill" → name + system prompt + first task
  C->>O: define_skill { key, name, system }
  O->>O: customSkills.set(key, …)  (persisted)
  C->>O: spawn { name, skills:[key] }
  C->>O: create_task { kind:'custom', skill:key, brief }
  O->>O: task._system = the authored prompt
  Note over O,Ag: dispatch routes to the specialist
  O->>Ag: assign(task)
  Ag->>CS: step(agent, task)
  CS->>LLM: run model with task._system (your expertise)
  LLM-->>CS: expert output
  CS-->>Ag: task.result → saved to server/outputs/

  Note over U,C: manage live in the SKILLS panel
  U->>C: ✎ edit prompt (define_skill upsert) · ✕ delete (delete_skill)
```

</details>

---

## 9. Multi-agent handoff (fact-check → verify)

Real collaboration on real data: agent A reaches a verdict, then a **different**
agent B independently verifies it against a second source.
([`server/research.js`](../server/research.js), `_maybeHandoff` in orchestrator)

![Fact-check to verify handoff](diagrams/09-handoff-factcheck-verify.png)

<details>
<summary>Mermaid source (edit here, then re-export — see top of file)</summary>

```mermaid
flowchart LR
  subgraph S1["Stage 1 · agent A (jira floor)"]
    F1["factCheckStep<br/>read Wikipedia → verdict"]
  end
  subgraph S2["Stage 2 · agent B (conference hall)"]
    V1["verifyStep<br/>2nd source (DuckDuckGo)<br/>→ CONFIRM / DISPUTE"]
  end
  F1 -- "⚖️ verdict" --> H{"_maybeHandoff"}
  H -- "always; _exclude = A<br/>(dispatch skips A, so a<br/>different agent verifies)" --> V1
  V1 --> Out["✅ / ❌ in the feed"]
```

</details>

> Skill-gated specialist work (rpa-design, email, custom) does **not** get a
> generic narrated handoff — it stands on its own.

---

## 10. Deliverables — results become files

Real work should leave something you can keep. When a **specialist** task
completes with a `task.result`, it's written to a Markdown file *before* the task
is pruned. The ambient research/fact-check churn is **not** filed (it would flood
the folder). ([`server/artifacts.js`](../server/artifacts.js))

![Results become files](diagrams/10-deliverables.png)

<details>
<summary>Mermaid source (edit here, then re-export — see top of file)</summary>

```mermaid
flowchart TB
  Done["task completes with task.result"] --> Q{"requiredSkill(task)?<br/>(rpa-design / email / custom)"}
  Q -- yes --> Save["saveArtifact(task)"]
  Q -- "no (research, sim)" --> Skip["shown in feed only<br/>(not saved)"]
  Save --> File["📄 server/outputs/&lt;id&gt;-&lt;kind&gt;-&lt;subject&gt;.md<br/>header + the full result"]
  File --> Panel["path shown in the task-detail panel:<br/>📄 saved to …"]
```

</details>

---

### Where each diagram lives in code

| Diagram | Primary files |
|---|---|
| System architecture | `server/index.js`, `src/main.js`, `server/protocol.js` |
| The loop | `server/orchestrator.js` → `tick()`, `_dispatch()` |
| Agent state machine | `server/agent-runtime.js` → `Agent.tick()` |
| Commands & events | `server/protocol.js`, `src/sim/gateway.js` |
| What a skill is | `server/protocol.js` (`SKILLS`, `SKILL_FOR_KIND`, `requiredSkill`) |
| Dispatch | `server/orchestrator.js` → `_dispatch()`, `_ensureSpecialist()` |
| RPA skill | `server/rpa.js`, `server/executor.js` |
| Custom skills | `server/custom-skill.js`, `Orchestrator.defineSkill()` |
| Handoff | `server/research.js`, `Orchestrator._maybeHandoff()` |
| Deliverables | `server/artifacts.js` |
