// gateway.js
// The data + command layer for the dashboard. A "gateway" is the dashboard's
// view of an orchestrator. It emits state DOWN ('snapshot' | 'tick') and
// accepts commands UP (.send(type, payload)).
//
// Two implementations share one interface:
//   - MockGateway   : a self-contained, fully interactive simulation (default).
//                     Runs the orchestration loop in the browser — no backend.
//   - RemoteGateway : connects to the real Node orchestrator over WebSocket
//                     (see server/). Real host metrics, real server-side state.
//
// Interface (used by main.js):
//   gateway.on('snapshot'|'tick', handler)
//   gateway.start() / gateway.stop()
//   gateway.send(type, payload)   // a command — see COMMAND in protocol.js
//   gateway.kind                  // 'simulation' | 'orchestrator'
//
// Both speak the SAME protocol defined once in server/protocol.js, imported by
// both sides so the contract can never drift.

import { COMMAND, EVENT, command as makeCommand } from '../../server/protocol.js'

export const ZONES = [
  { key: 'reception', label: 'reception' },
  { key: 'lounge', label: 'lounge' },
  { key: 'designers', label: 'designers' },
  { key: 'library', label: 'library' },
  { key: 'cafe', label: 'café' },
  { key: 'playroom', label: 'play room' },
  { key: 'jira', label: 'jira floor' },
  { key: 'conference', label: 'conference hall' },
  { key: 'office', label: 'private office' },
  { key: 'courtyard', label: 'courtyard' },
]

const MODELS = ['Hermes-4-405B', 'Hermes-4-70B', 'Hermes-3-8B', 'Hermes-3-70B', 'Hermes-2-Pro']
const PLATFORMS = ['discord', 'api', 'telegram', 'cli', 'web', 'matrix']
const FIRST = ['Atlas','Juno','Echo','Nova','Orion','Vega','Iris','Cyra','Kilo','Pax','Lyra','Onyx','Wren','Zephyr','Mira','Cleo','Dax','Fenn','Sol','Tess','Bram','Yuki','Nico','Rho','Sable','Quill','Indra']
const LAST = ['Quartz','Vela','Marlow','Crane','Ash','Vance','Lark','Reed','Frost','Hale','Vale','Stone','Wilde','North','Cole','Dune','Holt','Rune']
const TASK_TITLES = ['summarize the thread','draft a release note','review PR #482','triage inbox','write the API spec','answer support DM','research competitors','plan the sprint','refactor the parser','compose weekly report','label training data','fix flaky test','design onboarding','audit dependencies','update changelog']
const TASK_ZONE = ['designers', 'jira', 'office', 'conference', 'library']

const r = (n) => Math.floor(Math.random() * n)
const pick = (a) => a[r(a.length)]
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

class Emitter {
  constructor() { this._h = {} }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return this }
  emit(ev, p) { (this._h[ev] || []).forEach((fn) => fn(p)) }
}

// ─────────────────────────────────────────────────────────────────────────────
// MockGateway — the orchestration loop, in the browser. Mirrors the server's
// Orchestrator so the offline demo is fully interactive (click, assign, spawn).
// ─────────────────────────────────────────────────────────────────────────────
export class MockGateway extends Emitter {
  constructor(opts = {}) {
    super()
    this.kind = 'simulation'
    this.total = opts.total ?? 24
    this.tickMs = opts.tickMs ?? 1100
    this.version = 'v0.1.0 · pre-release · sim'
    this.autoAssign = true
    this._timer = null
    this._taskSeq = 0
    this._agents = []
    this._tasks = []
    this._host = { cpu: 30, mem: 70, disk: 24, net: 12 }
    for (let i = 0; i < this.total; i++) this._agents.push(this._newAgent(i))
    for (let i = 0; i < 8; i++) this._newTask()
  }

  _newAgent(i) {
    return {
      id: `a${i.toString().padStart(3, '0')}`,
      name: `${pick(FIRST)} ${pick(LAST)}`,
      model: pick(MODELS), platform: pick(PLATFORMS),
      zone: pick(ZONES).key, status: 'idle', task: 'idle',
      taskId: null, uptime: r(86400), _walk: 0, _beat: 0,
    }
  }

  _newTask(opts = {}) {
    this._taskSeq += 1
    // Note: the offline sim can't make real network calls, so a 'research' task
    // here is just labeled like one and narrated. Real research needs the
    // orchestrator backend (?feed=ws://...).
    const isResearch = opts.kind === 'research'
    const topic = isResearch ? pick(['tardigrades', 'black holes', 'the Silk Road', 'CRISPR', 'photosynthesis']) : null
    const t = {
      id: `t${this._taskSeq.toString().padStart(3, '0')}`,
      title: opts.title || (isResearch ? `research: ${topic}` : pick(TASK_TITLES)),
      zone: isResearch ? 'library' : (ZONES.find((z) => z.key === opts.zone) ? opts.zone : pick(TASK_ZONE)),
      state: 'backlog', agentId: null, progress: 0,
    }
    this._tasks.push(t)
    return t
  }

  roster() { return this._agents }
  host() { return this._host }

  start() {
    if (this._timer) return
    this.emit('snapshot', { agents: this._agents, tasks: this._tasks, host: this._host, version: this.version })
    this._timer = setInterval(() => this._tick(), this.tickMs)
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null }

  // Command channel (control plane). Mirrors Orchestrator.apply().
  send(type, payload = {}) {
    switch (type) {
      case COMMAND.SPAWN: {
        const n = payload.count ?? 1
        for (let i = 0; i < n; i++) this._agents.push(this._newAgent(this._agents.length))
        break
      }
      case COMMAND.KILL: {
        const a = this._agents.find((x) => x.id === payload.agentId)
        if (a?.taskId) { const t = this._task(a.taskId); if (t) { t.state = 'backlog'; t.agentId = null } }
        this._agents = this._agents.filter((x) => x.id !== payload.agentId)
        break
      }
      case COMMAND.ASSIGN: return this._assign(payload.agentId, payload.taskId)
      case COMMAND.CREATE_TASK: this._newTask(payload); break
      case COMMAND.PAUSE: { const a = this._agent(payload.agentId); if (a && a.status !== 'paused') { a._resume = a.status; a.status = 'paused' } break }
      case COMMAND.RESUME: { const a = this._agent(payload.agentId); if (a && a.status === 'paused') a.status = a._resume ?? 'idle'; break }
      case COMMAND.MOVE: { const a = this._agent(payload.agentId); if (a) { a.zone = payload.zone; if (a.status === 'idle') a.status = 'idle' } break }
      case COMMAND.SET_AUTO: this.autoAssign = !!payload.enabled; break
      case COMMAND.RESET: this._tasks = []; this._taskSeq = 0; this._agents.forEach((a) => { a.taskId = null; a.task = 'idle'; a.status = 'idle' }); break
    }
  }

  _agent(id) { return this._agents.find((a) => a.id === id) }
  _task(id) { return this._tasks.find((t) => t.id === id) }

  _assign(agentId, taskId) {
    const a = this._agent(agentId); const t = this._task(taskId)
    if (!a || !t || t.state !== 'backlog') return false
    if (a.status !== 'idle' && a.status !== 'paused') return false
    a.taskId = t.id; a.task = t.title; a.zone = t.zone
    a.status = 'walking'; a._walk = 2 + r(2)
    t.state = 'assigned'; t.agentId = a.id
    return true
  }

  _dispatch() {
    if (!this.autoAssign) return
    const idle = this._agents.filter((a) => a.status === 'idle')
    const backlog = this._tasks.filter((t) => t.state === 'backlog')
    for (let i = 0; i < Math.min(idle.length, backlog.length); i++) {
      this._assign(idle[i].id, backlog[i].id)
    }
  }

  _tick() {
    const events = []
    this._dispatch()

    for (const a of this._agents) {
      a.uptime += 1
      if (a.status === 'paused') continue
      const t = a.taskId ? this._task(a.taskId) : null
      if (!t) { a.status = 'idle'; a.task = 'idle'; a.taskId = null; continue }

      if (a.status === 'walking') {
        if (--a._walk > 0) continue
        a.status = 'thinking'; a._beat = 1 + r(1); t.state = 'in_progress'
        events.push({ who: a.name, verb: 'started', what: t.title })
      } else if (a.status === 'thinking') {
        if (--a._beat > 0) continue
        a.status = 'working'; a._beat = 1 + r(2)
      } else if (a.status === 'working') {
        t.progress = Math.min(1, t.progress + 0.18 + Math.random() * 0.2)
        if (t.progress >= 1) { a.status = 'messaging'; a._beat = 1 }
        else if (--a._beat <= 0) { a.status = 'thinking'; a._beat = 1 }
      } else if (a.status === 'messaging') {
        if (--a._beat > 0) continue
        t.state = 'done'; t.agentId = null
        events.push({ who: a.name, verb: 'completed', what: t.title })
        a.taskId = null; a.task = 'idle'; a.status = 'idle'
        a.zone = pick(['lounge', 'cafe', 'playroom', 'courtyard'])
      }
    }

    // keep work flowing
    const backlog = this._tasks.filter((t) => t.state === 'backlog').length
    if (backlog < 3 && Math.random() < 0.5) this._newTask()
    // cap completed tasks so the array doesn't grow forever
    const done = this._tasks.filter((t) => t.state === 'done')
    if (done.length > 12) this._tasks = this._tasks.filter((t) => t.state !== 'done').concat(done.slice(-12))

    const active = this._agents.filter((a) => a.status !== 'idle' && a.status !== 'paused').length
    const load = active / Math.max(1, this._agents.length)
    this._host.cpu = clamp(Math.round(20 + load * 60 + (Math.random() * 8 - 4)), 4, 99)
    this._host.mem = clamp(Math.round(60 + load * 30 + (Math.random() * 5 - 2)), 30, 98)
    this._host.disk = clamp(Math.round(this._host.disk + (Math.random() * 2 - 1)), 10, 95)
    this._host.net = clamp(Math.round(8 + load * 55 + (Math.random() * 10 - 5)), 0, 99)

    this.emit('tick', { agents: this._agents, tasks: this._tasks, host: this._host, active, events: events.slice(-6) })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RemoteGateway — talks to the real Node orchestrator over WebSocket.
// ─────────────────────────────────────────────────────────────────────────────
export class RemoteGateway extends Emitter {
  constructor(url) {
    super()
    this.kind = 'orchestrator'
    this.url = url
    this.version = 'v0.1.0 · pre-release'
    this._ws = null
    this._fallback = null
    this._connected = false
  }

  start() {
    try {
      this._ws = new WebSocket(this.url)
      this._ws.onopen = () => { this._connected = true }
      this._ws.onmessage = (m) => this._onFrame(JSON.parse(m.data))
      this._ws.onerror = () => this._useFallback()
      this._ws.onclose = () => { if (!this._connected) this._useFallback() }
      // if it never opens within 2.5s, fall back
      setTimeout(() => { if (!this._connected) this._useFallback() }, 2500)
    } catch { this._useFallback() }
  }

  stop() { this._ws?.close(); this._fallback?.stop() }

  // Send a command up to the orchestrator using the shared envelope builder.
  send(type, payload = {}) {
    if (this._fallback) return this._fallback.send(type, payload)
    if (this._ws?.readyState === 1) this._ws.send(JSON.stringify(makeCommand(type, payload)))
  }

  _onFrame(frame) {
    if (frame?.kind !== 'event') return
    if (frame.type === EVENT.SNAPSHOT) {
      if (frame.payload.version) this.version = frame.payload.version
      this.emit('snapshot', frame.payload)
    } else if (frame.type === EVENT.TICK) {
      this.emit('tick', frame.payload)
    }
    // ACK frames are available here if the UI wants to confirm commands.
  }

  _useFallback() {
    if (this._fallback || this._connected) return
    console.warn('[gateway] orchestrator unreachable — running local simulation')
    this.kind = 'simulation'
    this._fallback = new MockGateway()
    this._fallback.on('snapshot', (p) => this.emit('snapshot', p))
    this._fallback.on('tick', (p) => this.emit('tick', p))
    this._fallback.start()
  }
}

// Factory: ?feed=ws://host:port → real orchestrator; otherwise the simulation.
export function createGateway() {
  const feed = new URLSearchParams(location.search).get('feed')
  if (feed) return new RemoteGateway(feed)
  return new MockGateway({ total: 24 })
}
