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

const r = (n) => Math.floor(Math.random() * n)
const pick = (a) => a[r(a.length)]

let _taskSeq = 0

export class Orchestrator {
  constructor(opts = {}) {
    this.agents = new Map() // id -> Agent
    this.tasks = new Map()  // id -> task record
    this.executor = opts.executor ?? simulatedExecutor
    this.autoAssign = opts.autoAssign ?? true
    this.version = 'v0.1.0 · pre-release'
    this._feed = []         // recent activity lines

    // Seed an initial fleet so the office isn't empty on first connect.
    const n = opts.fleet ?? 18
    for (let i = 0; i < n; i++) this.spawn(1, { silent: true })
    // Seed a backlog.
    for (let i = 0; i < 8; i++) this.createTask({}, { silent: true })
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

  createTask({ title, zone } = {}, opts = {}) {
    _taskSeq += 1
    const task = {
      id: `t${_taskSeq.toString().padStart(3, '0')}`,
      title: title || pick(TASK_TITLES),
      zone: (zone && ZONE_KEYS.includes(zone)) ? zone : pick(TASK_ZONE),
      state: TASK_STATE.BACKLOG,
      agentId: null,
      progress: 0,
    }
    this.tasks.set(task.id, task)
    if (!opts.silent) this._log({ who: 'board', verb: 'new task', what: task.title })
    return task
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
    const idle = [...this.agents.values()].filter((a) => a.status === STATUS.IDLE)
    if (!idle.length) return
    const backlog = [...this.tasks.values()].filter((t) => t.state === TASK_STATE.BACKLOG)
    let i = 0
    for (const task of backlog) {
      if (i >= idle.length) break
      idle[i].assign(task)
      this._log({ who: idle[i].name, verb: 'picked up', what: task.title })
      i++
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
      if (line) events.push(line)
    }
    events.forEach((e) => this._log(e))

    // keep a steady trickle of new work so the demo never stalls
    const backlogCount = [...this.tasks.values()].filter((t) => t.state === TASK_STATE.BACKLOG).length
    if (backlogCount < 3 && Math.random() < 0.5) this.createTask({}, { silent: true })

    // 4. PUBLISH payload
    const agents = [...this.agents.values()].map((a) => a.toRecord())
    const active = agents.filter((a) => a.status !== STATUS.IDLE && a.status !== STATUS.PAUSED).length
    const host = this._host(metricsSample, active)
    return {
      agents,
      tasks: [...this.tasks.values()],
      host,
      active,
      events: events.slice(-6),
    }
  }

  snapshot(metricsSample) {
    const agents = [...this.agents.values()].map((a) => a.toRecord())
    const active = agents.filter((a) => a.status !== STATUS.IDLE && a.status !== STATUS.PAUSED).length
    return {
      agents,
      tasks: [...this.tasks.values()],
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
