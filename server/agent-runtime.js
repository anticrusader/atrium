// agent-runtime.js
// One agent = one worker with a lifecycle. This is the unit the orchestrator
// schedules. It is deliberately a small STATE MACHINE so the orchestration
// concepts stay visible:
//
//   IDLE ──assign(task)──▶ WALKING ──arrive──▶ THINKING ⇄ WORKING ──▶ MESSAGING ──▶ done ──▶ IDLE
//                                                  ▲                                          │
//                                                  └──────────── more steps ──────────────────┘
//
// "Doing work" here is SIMULATED by advancing a task through N steps. The point
// that matters for learning is the *seam*: `executor.step()` is where real work
// would happen. Swap the default simulated executor for one that calls a model
// (see executor.js notes in docs/ORCHESTRATION.md) and nothing else changes.

import { STATUS, TASK_STATE } from './protocol.js'

const FIRST = ['Atlas','Juno','Echo','Nova','Orion','Vega','Iris','Cyra','Kilo','Pax','Lyra','Onyx','Wren','Zephyr','Mira','Cleo','Dax','Fenn','Sol','Tess','Bram','Yuki','Nico','Rho','Sable','Quill','Indra']
const LAST = ['Quartz','Vela','Marlow','Crane','Ash','Vance','Lark','Reed','Frost','Hale','Vale','Stone','Wilde','North','Cole','Dune','Holt','Rune']
const MODELS = ['Hermes-4-405B','Hermes-4-70B','Hermes-3-8B','Hermes-3-70B','Hermes-2-Pro']
const PLATFORMS = ['discord','api','telegram','cli','web','matrix']

const r = (n) => Math.floor(Math.random() * n)
const pick = (a) => a[r(a.length)]

// The default executor: pretends to do one unit of work per call and returns a
// short human-readable line describing what "happened". Replace `step` to do
// real work (call a model, run a tool, hit an API). It must stay non-blocking
// per tick — if real work is slow, kick it off and resolve progress over ticks.
export const simulatedExecutor = {
  // Called once per tick while an agent is working a task.
  // Returns { delta, note } — delta advances task.progress (0..1).
  step(agent, task) {
    const verbs = ['parsed', 'drafted', 'checked', 'refined', 'queried', 'summarized', 'validated']
    return {
      delta: 0.18 + Math.random() * 0.22,
      note: `${pick(verbs)} "${task.title}"`,
    }
  },
}

let _counter = 0

export class Agent {
  constructor(opts = {}) {
    _counter += 1
    this.id = opts.id ?? `a${(_counter).toString().padStart(3, '0')}`
    this.name = opts.name ?? `${pick(FIRST)} ${pick(LAST)}`
    this.model = opts.model ?? pick(MODELS)
    this.platform = opts.platform ?? pick(PLATFORMS)
    this.zone = opts.zone ?? 'lounge'
    this.status = STATUS.IDLE
    this.taskId = null
    this.task = 'idle'          // human-readable current activity
    this.uptime = 0
    this.executor = opts.executor ?? simulatedExecutor

    // internal timers
    this._walk = 0              // ticks left before "arriving"
    this._beat = 0             // ticks until next think/work flip
  }

  get busy() {
    return this.status !== STATUS.IDLE && this.status !== STATUS.PAUSED
  }

  // Operator controls -------------------------------------------------------
  pause() {
    if (this.status === STATUS.PAUSED) return
    this._resumeStatus = this.status
    this.status = STATUS.PAUSED
  }

  resume() {
    if (this.status !== STATUS.PAUSED) return
    this.status = this._resumeStatus ?? STATUS.IDLE
  }

  moveTo(zone) {
    this.zone = zone
    if (!this.busy) this.status = STATUS.IDLE
  }

  // Orchestrator hands a task to this agent.
  assign(task) {
    this.taskId = task.id
    this.task = task.title
    this.zone = task.zone
    this.status = STATUS.WALKING
    this._walk = 2 + r(2)
    task.state = TASK_STATE.ASSIGNED
    task.agentId = this.id
  }

  // Advance one tick. `board` lets the agent update its task + report a feed
  // line. Returns an event line (or null) for the activity feed.
  tick(board) {
    this.uptime += 1
    if (this.status === STATUS.PAUSED) return null

    const task = this.taskId ? board.get(this.taskId) : null

    // No task → idle drift.
    if (!task) {
      this.status = STATUS.IDLE
      this.task = 'idle'
      this.taskId = null
      return null
    }

    switch (this.status) {
      case STATUS.WALKING: {
        if (--this._walk > 0) return null
        this.status = STATUS.THINKING
        this._beat = 1 + r(1)
        task.state = TASK_STATE.IN_PROGRESS
        return { who: this.name, verb: 'started', what: task.title }
      }

      case STATUS.THINKING: {
        if (--this._beat > 0) return null
        this.status = STATUS.WORKING
        this._beat = 1 + r(2)
        return null
      }

      case STATUS.WORKING: {
        // Do one unit of work via the (pluggable) executor.
        const { delta, note } = this.executor.step(this, task)
        task.progress = Math.min(1, task.progress + delta)
        if (task.progress >= 1) {
          this.status = STATUS.MESSAGING
          this._beat = 1
          return { who: this.name, verb: 'finishing', what: task.title }
        }
        if (--this._beat <= 0) {
          this.status = STATUS.THINKING
          this._beat = 1
        }
        return { who: this.name, verb: 'working', what: note }
      }

      case STATUS.MESSAGING: {
        if (--this._beat > 0) return null
        // Complete the task and free up.
        task.state = TASK_STATE.DONE
        task.agentId = null
        const title = task.title
        this.taskId = null
        this.task = 'idle'
        this.status = STATUS.IDLE
        // idle agents drift to a social zone
        this.zone = pick(['lounge', 'cafe', 'playroom', 'courtyard'])
        return { who: this.name, verb: 'completed', what: title }
      }

      default:
        this.status = STATUS.IDLE
        return null
    }
  }

  // Serializable record for the wire.
  toRecord() {
    return {
      id: this.id,
      name: this.name,
      model: this.model,
      platform: this.platform,
      zone: this.zone,
      status: this.status,
      task: this.task,
      taskId: this.taskId,
      uptime: this.uptime,
    }
  }
}
