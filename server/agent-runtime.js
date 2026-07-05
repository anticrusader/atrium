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

const FIRST = ['Atlas','Orion','Pax','Onyx','Dax','Fenn','Sol','Bram','Nico','Kilo','Rho','Cass','Ronan','Silas','Idris','Ezra','Milo','Cyrus','Dorian','Arlo','Zane','Kai','Jax','Flynn','Rex','Dex','Cole','Reid']
const LAST = ['Quartz','Vela','Marlow','Crane','Ash','Vance','Lark','Reed','Frost','Hale','Vale','Stone','Wilde','North','Cole','Dune','Holt','Rune']
const MODELS = ['Hermes-4-405B','Hermes-4-70B','Hermes-3-8B','Hermes-3-70B','Hermes-2-Pro']
const PLATFORMS = ['discord','api','telegram','cli','web','matrix']

const r = (n) => Math.floor(Math.random() * n)
const pick = (a) => a[r(a.length)]

// Append an entry to a task's activity log (a per-task timeline of who did what).
export function logTask(task, who, verb, what = '') {
  ;(task.log ??= []).push({ who, verb, what })
  if (task.log.length > 16) task.log.shift()
}

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

// Watchdog: if one executor call is in flight for this many ticks (~50s at the
// default TICK_MS), give up on it — otherwise a hung model call would leave the
// agent stuck in WORKING forever. The late result (if it ever lands) is
// discarded via a generation counter.
const STEP_TIMEOUT_TICKS = 45

let _counter = 0

// Restore the id counter after loading saved agents, so newly spawned agents
// don't reuse an existing id.
export function setAgentCounter(n) { _counter = n }

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
    // Skills = capabilities this agent has (e.g. 'rpa-architect', 'email'). The
    // dispatcher uses them to route specialist work; see Orchestrator._dispatch.
    this.skills = Array.isArray(opts.skills) ? [...new Set(opts.skills)] : []
    // If this agent was AUTO-spawned to cover a skill on demand, remember which
    // one. Cleared the moment an operator renames it (i.e. makes it "theirs"), so
    // deleting that skill only cleans up untouched, single-purpose specialists.
    this.autoFor = opts.autoFor ?? null
    this.executor = opts.executor ?? simulatedExecutor

    // internal timers
    this._walk = 0              // ticks left before "arriving"
    this._beat = 0             // ticks until next think/work flip
    this._pending = false       // an async executor call is in flight
    this._result = null         // a resolved executor result awaiting apply
    this._pendingTicks = 0      // how long the in-flight call has been pending
    this._gen = 0               // bumping this discards any in-flight result
  }

  get busy() {
    return this.status !== STATUS.IDLE && this.status !== STATUS.PAUSED
  }

  hasSkill(skill) { return !skill || this.skills.includes(skill) }

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
    this._pending = false
    this._result = null
    this._pendingTicks = 0
    this._gen++ // discard any still-in-flight result from a previous task
    task.state = TASK_STATE.ASSIGNED
    task.agentId = this.id
    logTask(task, this.name, 'picked up the task')
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
        // The executor may be ASYNC (a real model call takes seconds). We must
        // not block the tick loop, so we fire the call once and let it resolve
        // over future ticks: while a call is in flight the agent simply stays
        // in WORKING. When the result lands we apply it on the next tick.
        if (this._result) {
          const res = this._result
          this._result = null

          // A HARD FAILURE (executor threw, or the watchdog fired). The agent
          // frees itself; the ORCHESTRATOR owns the retry-or-give-up policy —
          // it sees the `failed` flag on this event line and decides.
          if (res.failed) {
            logTask(task, this.name, 'step failed —', res.note)
            const failedId = task.id
            this.taskId = null
            this.task = 'idle'
            this.status = STATUS.IDLE
            this._pending = false
            return { who: this.name, verb: 'hit a failure', what: res.note, taskId: failedId, failed: true }
          }

          const { delta, note } = res
          if (delta > 0) {
            task.progress = Math.min(1, task.progress + delta)
            logTask(task, this.name, '—', note) // record what the agent just did
          }
          if (task.progress >= 1) {
            this.status = STATUS.MESSAGING
            this._beat = 1
            // Surface the final note (e.g. a research task's 📚 grounded summary)
            // instead of discarding it behind a generic label.
            return { who: this.name, verb: 'finishing', what: note || task.title }
          }
          // suppress the feed line when nothing happened (e.g. rate-limited)
          return delta > 0 ? { who: this.name, verb: 'working', what: note } : null
        }

        if (this._pending) {
          // Watchdog: a call has been in flight too long — declare it failed and
          // bump the generation so the late result (if any) is discarded.
          if (++this._pendingTicks > STEP_TIMEOUT_TICKS) {
            this._gen++
            this._pending = false
            this._result = { failed: true, note: `step timed out after ${STEP_TIMEOUT_TICKS} ticks (hung executor call)` }
          }
          return null
        }

        this._pending = true
        this._pendingTicks = 0
        const gen = this._gen // capture: results from a stale generation are dropped
        // Promise.resolve(...) handles both sync and async executors uniformly.
        Promise.resolve()
          .then(() => this.executor.step(this, task))
          .then((res) => { if (gen !== this._gen) return; this._result = res; this._pending = false })
          .catch((err) => { if (gen !== this._gen) return; this._result = { failed: true, note: `executor error: ${err.message}` }; this._pending = false })
        return null
      }

      case STATUS.MESSAGING: {
        if (--this._beat > 0) return null
        // Complete the task and free up.
        task.state = TASK_STATE.DONE
        task.doneBy = this.name // remember who finished it (for the task detail)
        task.agentId = null
        logTask(task, this.name, 'completed the task')
        const title = task.title
        const doneId = task.id
        this.taskId = null
        this.task = 'idle'
        this.status = STATUS.IDLE
        this._pending = false
        this._result = null
        // idle agents drift to a social zone
        this.zone = pick(['lounge', 'cafe', 'playroom', 'courtyard'])
        // taskId lets the orchestrator decide on an agent-to-agent handoff.
        return { who: this.name, verb: 'completed', what: title, taskId: doneId }
      }

      default:
        this.status = STATUS.IDLE
        return null
    }
  }

  // Serializable record for the wire.
  toRecord() {
    // Report the REAL active model when running on a live LLM executor (the
    // whole fleet shares it); fall back to the cosmetic label when simulated.
    const realModel = typeof this.executor?.current === 'function'
      ? this.executor.current().split('/').pop()
      : this.model
    return {
      id: this.id,
      name: this.name,
      model: realModel,
      platform: this.platform,
      zone: this.zone,
      status: this.status,
      task: this.task,
      taskId: this.taskId,
      uptime: this.uptime,
      skills: this.skills,
    }
  }

  // Persistable snapshot (raw fields — keeps the cosmetic model label, not the
  // executor-derived one; excludes transient in-flight call state).
  toState() {
    return {
      id: this.id,
      name: this.name,
      model: this.model,
      platform: this.platform,
      zone: this.zone,
      status: this.status,
      taskId: this.taskId,
      task: this.task,
      uptime: this.uptime,
      skills: this.skills,
      autoFor: this.autoFor,
    }
  }
}
