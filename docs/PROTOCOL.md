# Wire Protocol Reference

The single contract between the orchestrator (server) and the dashboard
(browser). Defined once in [`server/protocol.js`](../server/protocol.js) and
imported by **both** sides so it can never drift. Transport is a single
WebSocket; every frame is JSON.

There are two frame kinds: **events** (server → browser) and **commands**
(browser → server).

---

## Frame envelopes

```jsonc
// event  (server → browser)
{ "kind": "event",   "type": "snapshot|tick|ack", "payload": { ... } }

// command (browser → server)
{ "kind": "command", "id": "c12", "type": "spawn|assign|...", "payload": { ... } }
```

`command.id` is echoed back in an `ack` so the UI can correlate a reply.

---

## Events (server → browser)

### `snapshot` — sent once, on connect
Full state of the world.

```jsonc
{
  "agents":  [ /* agent records, see below */ ],
  "tasks":   [ /* task records, see below */ ],
  "host":    { "cpu": 31, "mem": 68, "disk": 24, "net": 18 },
  "version": "v0.1.0 · pre-release"
}
```

### `tick` — sent every heartbeat (~1.1s)
Incremental world state + what just happened.

```jsonc
{
  "agents": [ ... ],
  "tasks":  [ ... ],
  "host":   { "cpu": 42, "mem": 70, "disk": 24, "net": 33 },
  "active": 11,                       // agents not idle/paused
  "events": [ { "who": "Atlas Quartz", "verb": "completed", "what": "triage inbox" } ]
}
```

### `ack` — reply to a command
```jsonc
{ "id": "c12", "ok": true }
```

---

## Commands (browser → server)

| `type` | `payload` | Effect |
|---|---|---|
| `spawn` | `{ count? }` | Create N agents (default 1) |
| `kill` | `{ agentId }` | Remove an agent; its task returns to backlog |
| `create_task` | `{ title?, zone? }` | Add a task to the backlog |
| `assign` | `{ agentId, taskId }` | Manually give a backlog task to an idle agent |
| `pause` | `{ agentId }` | Suspend an agent |
| `resume` | `{ agentId }` | Resume a paused agent |
| `move` | `{ agentId, zone }` | Send an agent to a zone |
| `set_auto` | `{ enabled }` | Toggle the auto-dispatcher |
| `reset` | `{}` | Clear the board, idle all agents |

Unknown or malformed commands are ignored (the server validates with
`isCommand`). Commands are idempotent-ish: applying one to a missing agent/task
is a no-op that returns `ok:false`.

---

## Records

### Agent record
```jsonc
{
  "id":       "a003",
  "name":     "Atlas Quartz",
  "model":    "Hermes-4-405B",
  "platform": "discord",        // a.k.a. "source" — where the agent is reachable
  "zone":     "designers",      // one of the zone keys below
  "status":   "working",        // idle | walking | thinking | working | messaging | paused
  "task":     "review PR #482", // human-readable current activity
  "taskId":   "t007",           // or null
  "uptime":   38211             // seconds
}
```

### Task record
```jsonc
{
  "id":       "t007",
  "title":    "review PR #482",
  "zone":     "jira",
  "state":    "in_progress",    // backlog | assigned | in_progress | done | failed
  "agentId":  "a003",           // or null
  "progress": 0.62              // 0..1
}
```

### Zone keys
`reception` · `lounge` · `designers` · `library` · `cafe` · `playroom` ·
`jira` · `conference` · `office` · `courtyard`

---

## Connecting your own backend

Anything that speaks these frames works. Minimal server obligations:

1. On connect, send one `snapshot`.
2. Periodically send `tick`.
3. Accept commands and apply them (or ignore the ones you don't support).

To attach a real agent fleet, map your telemetry into the **agent/task records**
above inside the orchestrator (server-side bridge) and forward commands to your
agents. See [`ORCHESTRATION.md` §8](./ORCHESTRATION.md#8-bridging-a-real-hermes-fleet-instead-of-simulating).
