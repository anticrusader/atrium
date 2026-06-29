// orchestrator.js
// The brain. It owns the fleet (agents) and the task board, applies operator
// commands, runs the auto-dispatcher, advances every agent each tick, and
// produces the telemetry the dashboard renders.
//
// THE ORCHESTRATION LOOP (this is the whole idea):
//   1. INTAKE   — accept commands (create tasks, spawn agents, manual assigns)
//   2. DISPATCH — match idle agents to backlog tasks (the scheduler)
//   3. ADVANCE  — tick every agent's state machine one step
//   4. PUBLISH  — emit a snapshot of the reconciled world to all clients
// Real orchestrators (CI schedulers, k8s, actor supervisors) run this same
// loop. Everything else is policy plugged into step 2.

import { Agent, simulatedExecutor } from './agent-runtime.js'
import { STATUS, TASK_STATE, ZONE_KEYS } from './protocol.js'

const TASK_TITLES = [
  'summarize the thread', 'draft a release note', 'review PR #482', 'triage inbox',
  'write the API spec', 'answer support DM', 'research competitors', 'plan the sprint',
  'refactor the parser', 'compose weekly report', 'label training data', 'fix flaky test',
  'design the onboarding', 'audit dependencies', 'update the changelog',
]
// Which zone a task naturally happens in (so agents walk somewhere sensible).
const TASK_ZONE = ['designers', 'jira', 'office', 'conference', 'library']

// Real research topics — these get genuinely looked up on Wikipedia.
const RESEARCH_TOPICS = [
  'the Antikythera mechanism', 'tardigrades', 'the Voyager program', 'black holes',
  'the printing press', 'CRISPR gene editing', 'the Silk Road', 'quantum entanglement',
  'photosynthesis', 'the Apollo program', 'octopus intelligence', 'Roman aqueducts',
  'general relativity', 'the history of coffee', 'mycorrhizal networks', 'the transistor',
]

// Real claims to fact-check (a deliberate mix of true and false). `topic` is the
// Wikipedia subject the stage-1 agent looks up.
const CLAIMS = [
  { claim: 'The Great Wall of China is visible from space with the naked eye', topic: 'Great Wall of China' },
  { claim: 'Honey never spoils', topic: 'Honey' },
  { claim: 'Goldfish have a three-second memory', topic: 'Goldfish' },
  { claim: 'Lightning never strikes the same place twice', topic: 'Lightning' },
  { claim: 'Bananas grow on trees', topic: 'Banana' },
  { claim: 'Sharks are mammals', topic: 'Shark' },
  { claim: 'The Eiffel Tower can grow taller in summer', topic: 'Eiffel Tower' },
  { claim: 'Venus is the hottest planet in the Solar System', topic: 'Venus' },
  { claim: 'Humans use only ten percent of their brains', topic: 'Human brain' },
  { claim: 'The Sahara is the largest desert on Earth', topic: 'Sahara' },
]

const r = (n) => Math.floor(Math.random() * n)
const pick = (a) => a[r(a.length)]

let _taskSeq = 0

export class Orchestrator {
  constructor(opts = {}) {
    this.agents = new Map() // id -> Agent
    this.tasks = new Map()  // id -> task record
    this.executor = opts.executor ?? simulatedExecutor
    this.autoAssign = opts.autoAssign ?? true
    // WIP limit: cap how many tasks run AT ONCE. With a rate-limited model, 18
    // agents all working at once starves everyone and the board looks frozen.
    // Capping concurrency lets a few tasks visibly progress and complete while
    // the rest idle — a core orchestration concept (work-in-progress limits).
    this.maxConcurrent = opts.maxConcurrent ?? 6
    this.version = 'v0.1.0 · pre-release'
    this._feed = []         // recent activity lines

    // Seed an initial fleet so the office isn't empty on first connect.
    const n = opts.fleet ?? 18
    for (let i = 0; i < n; i++) this.spawn(1, { silent: true })
    // Seed a backlog — a mix of simulated work and a few REAL tasks.
    for (let i = 0; i < 6; i++) this.createTask({}, { silent: true })
    for (let i = 0; i < 2; i++) this.createTask({ kind: 'research' }, { silent: true })
    this.createTask({ kind: 'factcheck' }, { silent: true })
  }

  // ── Command handlers (the control plane) ─────────────────────────────────
  spawn(count = 1, opts = {}) {
    const created = []
    for (let i = 0; i < count; i++) {
      const a = new Agent({ executor: this.executor, zone: pick(ZONE_KEYS) })
      this.agents.set(a.id, a)
      created.push(a)
    }
    if (!opts.silent) this._log({ who: 'orchestrator', verb: 'spawned', what: `${count} agent(s)` })
    return created
  }

  kill(agentId) {
    const a = this.agents.get(agentId)
    if (!a) return false
    // return its task to the backlog
    if (a.taskId) {
      const t = this.tasks.get(a.taskId)
      if (t) { t.state = TASK_STATE.BACKLOG; t.agentId = null }
    }
    this.agents.delete(agentId)
    this._log({ who: 'orchestrator', verb: 'removed', what: a.name })
    return true
  }

  createTask({ title, zone, stage, parent, kind, topic, claim, finding } = {}, opts = {}) {
    _taskSeq += 1
    // REAL task kinds (see server/research.js):
    //   research  — look up a topic on Wikipedia, summarize it (library)
    //   factcheck — judge a CLAIM against Wikipedia (stage 1, jira floor)
    //   verify    — re-check a claim against an independent 2nd source (stage 2,
    //               conference hall) — created by the fact-check handoff
    let k = kind || 'sim'
    let tp = topic ?? null
    let cl = claim ?? null
    let zn, ti

    if (k === 'research') {
      tp = tp || pick(RESEARCH_TOPICS)
      ti = title || `research: ${tp}`
      zn = 'library'
    } else if (k === 'factcheck') {
      const c = cl ? { claim: cl, topic: tp } : pick(CLAIMS)
      cl = c.claim; tp = c.topic
      ti = title || `fact-check: ${cl}`
      zn = 'jira'
    } else if (k === 'verify') {
      ti = title || `verify: ${cl ?? ''}`
      zn = 'conference'
    } else {
      ti = title || pick(TASK_TITLES)
      zn = (zone && ZONE_KEYS.includes(zone)) ? zone : pick(TASK_ZONE)
    }

    const task = {
      id: `t${_taskSeq.toString().padStart(3, '0')}`,
      title: ti,
      zone: zn,
      state: TASK_STATE.BACKLOG,
      agentId: null,
      progress: 0,
      stage: stage ?? 1,      // 1 = original work, 2 = a follow-up from a handoff
      parent: parent ?? null, // the task this one was handed off from
      kind: k,
      topic: tp,              // real subject (research / factcheck)
      claim: cl,              // the claim under test (factcheck / verify)
      finding: finding ?? null, // stage-1 verdict carried into a verify task
    }
    this.tasks.set(task.id, task)
    if (!opts.silent) this._log({ who: 'board', verb: 'new task', what: task.title })
    return task
  }

  // Agent-to-agent handoff: when a stage-1 task finishes, the agent's output
  // becomes the INPUT to a new follow-up task that a DIFFERENT idle agent will
  // pick up. That is a two-stage pipeline — the essence of multi-agent
  // collaboration. We cap it at stage 2 so chains don't grow forever.
  _maybeHandoff(taskId, events, doer) {
    const t = this.tasks.get(taskId)
    if (!t || (t.stage ?? 1) >= 2) return

    // Fact-check ALWAYS hands off to an independent verifier (a DIFFERENT agent),
    // carrying the claim + stage-1 verdict. This is the real 2-stage pipeline.
    if (t.kind === 'factcheck') {
      const v = this.createTask(
        { kind: 'verify', claim: t.claim, topic: t.topic, finding: t.result, parent: t.id, stage: 2 },
        { silent: true }
      )
      v._exclude = doer // don't let the stage-1 agent verify its own work
      events.push({ who: 'handoff', verb: 'handed off', what: `fact-check → independent verify of "${t.claim}"` })
      return
    }

    if (Math.random() > 0.55) return // ~45% of other finished work gets handed off
    const followTitle = pick([
      `review: ${t.title}`,
      `write up: ${t.title}`,
      `QA: ${t.title}`,
      `summarize results of: ${t.title}`,
    ])
    const follow = this.createTask(
      { title: followTitle, zone: pick(['conference', 'jira', 'office']), stage: 2, parent: t.id },
      { silent: true }
    )
    events.push({ who: 'handoff', verb: 'handed off', what: `${t.title} → ${follow.title}` })
  }

  assign(agentId, taskId) {
    const a = this.agents.get(agentId)
    const t = this.tasks.get(taskId)
    if (!a || !t) return false
    if (a.busy) return false               // don't stomp an in-flight agent
    if (t.state !== TASK_STATE.BACKLOG) return false
    a.assign(t)
    this._log({ who: a.name, verb: 'assigned', what: t.title })
    return true
  }

  pause(agentId) { const a = this.agents.get(agentId); if (a) { a.pause(); return true } return false }
  resume(agentId) { const a = this.agents.get(agentId); if (a) { a.resume(); return true } return false }

  move(agentId, zone) {
    const a = this.agents.get(agentId)
    if (!a || !ZONE_KEYS.includes(zone)) return false
    a.moveTo(zone)
    this._log({ who: a.name, verb: 'moved to', what: zone })
    return true
  }

  setAuto(enabled) { this.autoAssign = !!enabled }

  reset() {
    this.tasks.clear()
    _taskSeq = 0
    for (const a of this.agents.values()) {
      a.taskId = null; a.task = 'idle'; a.status = STATUS.IDLE
    }
    this._log({ who: 'orchestrator', verb: 'reset', what: 'board cleared' })
  }

  // Generic dispatch entry used by the WS layer.
  apply(type, payload = {}) {
    switch (type) {
      case 'spawn': this.spawn(payload.count ?? 1); return true
      case 'kill': return this.kill(payload.agentId)
      case 'assign': return this.assign(payload.agentId, payload.taskId)
      case 'create_task': this.createTask(payload); return true
      case 'pause': return this.pause(payload.agentId)
      case 'resume': return this.resume(payload.agentId)
      case 'move': return this.move(payload.agentId, payload.zone)
      case 'set_auto': this.setAuto(payload.enabled); return true
      case 'reset': this.reset(); return true
      default: return false
    }
  }

  // ── The dispatcher (the scheduler) ───────────────────────────────────────
  // Policy: greedily match the oldest backlog task to any idle agent. This is
  // the simplest possible scheduler. Smarter policies would weigh agent skills,
  // task priority, locality, fairness — but they all slot in right here.
  _dispatch() {
    if (!this.autoAssign) return
    // WIP limit: don't exceed maxConcurrent tasks in flight at once.
    const busy = [...this.agents.values()].filter((a) => a.taskId).length
    let slots = this.maxConcurrent - busy
    if (slots <= 0) return
    const idlePool = [...this.agents.values()].filter((a) => a.status === STATUS.IDLE)
    if (!idlePool.length) return
    // Priority: stage-2 verify first (finish pipelines), then real work
    // (research/factcheck) so it's promptly visible, then simulated tasks.
    const rank = (t) =>
      (t.stage ?? 1) * 10 +
      (t.kind === 'verify' ? 5 : t.kind === 'factcheck' || t.kind === 'research' ? 3 : 0)
    const backlog = [...this.tasks.values()]
      .filter((t) => t.state === TASK_STATE.BACKLOG)
      .sort((a, b) => rank(b) - rank(a))
    for (const task of backlog) {
      if (slots <= 0 || !idlePool.length) break
      // Honor _exclude (e.g. a verify task must not go to the stage-1 agent).
      const idx = idlePool.findIndex((a) => !task._exclude || a.name !== task._exclude)
      if (idx === -1) continue // only the excluded agent is free — wait a tick
      const a = idlePool.splice(idx, 1)[0]
      a.assign(task)
      this._log({ who: a.name, verb: 'picked up', what: task.title })
      slots--
    }
  }

  // ── The loop: one tick ───────────────────────────────────────────────────
  tick(metricsSample) {
    // 2. DISPATCH
    this._dispatch()

    // 3. ADVANCE
    const events = []
    for (const a of this.agents.values()) {
      const line = a.tick(this.tasks)
      if (line) {
        events.push(line)
        // When a task completes, maybe hand its result to a teammate. Pass the
        // doer's name so a verify task goes to a DIFFERENT agent.
        if (line.verb === 'completed' && line.taskId) this._maybeHandoff(line.taskId, events, line.who)
      }
    }
    events.forEach((e) => this._log(e))

    // keep a steady trickle of new work so the demo never stalls
    const backlogCount = [...this.tasks.values()].filter((t) => t.state === TASK_STATE.BACKLOG).length
    if (backlogCount < 3 && Math.random() < 0.5) {
      // Mix in real work: ~25% research, ~15% fact-check, rest simulated.
      const roll = Math.random()
      const kind = roll < 0.25 ? 'research' : roll < 0.4 ? 'factcheck' : undefined
      this.createTask(kind ? { kind } : {}, { silent: true })
    }

    // 4. PUBLISH payload
    const agents = [...this.agents.values()].map((a) => a.toRecord())
    const active = agents.filter((a) => a.status !== STATUS.IDLE && a.status !== STATUS.PAUSED).length
    const host = this._host(metricsSample, active)
    return {
      agents,
      tasks: this._wireTasks(),
      host,
      active,
      // Keep a generous window: with up to maxConcurrent agents emitting a line
      // per tick (plus board/handoff lines), a small slice would silently drop
      // the earliest agents' events (e.g. a fact-check verdict).
      events: events.slice(-16),
    }
  }

  // Serialize tasks for the wire, dropping bulky internal fields (e.g. the
  // fetched Wikipedia extract stored on research tasks as `_extract`).
  _wireTasks() {
    return [...this.tasks.values()].map((t) => {
      const o = {}
      for (const k in t) if (!k.startsWith('_')) o[k] = t[k]
      return o
    })
  }

  snapshot(metricsSample) {
    const agents = [...this.agents.values()].map((a) => a.toRecord())
    const active = agents.filter((a) => a.status !== STATUS.IDLE && a.status !== STATUS.PAUSED).length
    return {
      agents,
      tasks: this._wireTasks(),
      host: this._host(metricsSample, active),
      version: this.version,
    }
  }

  _host(sample, active) {
    // net is derived from fleet load; cpu/mem/disk are real (from Metrics).
    const load = this.agents.size ? active / this.agents.size : 0
    return {
      cpu: sample?.cpu ?? 0,
      mem: sample?.mem ?? 0,
      disk: sample?.disk ?? 0,
      net: Math.round(8 + load * 60),
    }
  }

  _log(line) {
    this._feed.push({ ...line, t: this.tick._n ?? 0 })
    if (this._feed.length > 40) this._feed.shift()
  }
}
