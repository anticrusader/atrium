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

import { Agent, simulatedExecutor, logTask, setAgentCounter } from './agent-runtime.js'
import { STATUS, TASK_STATE, ZONE_KEYS, SKILLS, SKILL_FOR_KIND, requiredSkill } from './protocol.js'
import { saveArtifact } from './artifacts.js'

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

// Sample business processes for the RPA Solution Architect to design an
// automation for. A real user types their own via the "+ RPA design" button.
const RPA_BRIEFS = [
  'invoice processing: read PDF invoices from a shared mailbox and post them to SAP',
  'employee onboarding: create AD accounts, mailboxes and Jira access from an HR form',
  'monthly bank reconciliation between the ERP and three bank portals',
  'extract data from supplier portals daily and consolidate into one Excel report',
  'process insurance claims: validate, classify, and route to the right queue',
  'sync new Salesforce opportunities into the finance system every hour',
]

const r = (n) => Math.floor(Math.random() * n)
const pick = (a) => a[r(a.length)]

let _taskSeq = 0

export class Orchestrator {
  constructor(opts = {}) {
    this.agents = new Map() // id -> Agent
    this.tasks = new Map()  // id -> task record
    // Custom prompt-skills authored from the dashboard: key -> { key, name, system }.
    // A "skill" with no code — just a name + a system prompt (the expertise). The
    // executor's customStep runs the model with that prompt. See defineSkill().
    this.customSkills = new Map()
    this.executor = opts.executor ?? simulatedExecutor
    this.autoAssign = opts.autoAssign ?? true
    // When false, the orchestrator does NOT generate its own simulated backlog —
    // only tasks you send (e.g. from Memex's Conductor) appear. Toggle via set_sim.
    this.simulate = opts.simulate ?? true
    // WIP limit: cap how many tasks run AT ONCE. With a rate-limited model, 18
    // agents all working at once starves everyone and the board looks frozen.
    // Capping concurrency lets a few tasks visibly progress and complete while
    // the rest idle — a core orchestration concept (work-in-progress limits).
    this.maxConcurrent = opts.maxConcurrent ?? 6
    this.version = 'v0.1.0 · pre-release'
    this._feed = []         // recent activity lines
    this._completed = 0     // cumulative completed count (done objects are pruned)
    // NOTE: seeding is NOT done here — server/index.js calls seed() for a fresh
    // start or hydrate() to restore a saved world (see persistence below).
  }

  // Fresh start: a small fleet + a small backlog.
  seed(fleet = 5) {
    for (let i = 0; i < fleet; i++) this.spawn(1, { silent: true })
    // Two SPECIALISTS so skill-routed work has somewhere to go out of the box.
    this.spawn(1, { silent: true, name: 'Sol · Solution Architect', skills: [SKILLS.RPA_ARCHITECT] })
    this.spawn(1, { silent: true, name: 'Milo · Inbox Assistant', skills: [SKILLS.EMAIL] })
    // Seed backlog only in simulation mode. With simulate off (e.g. launched by
    // Memex), start with an idle fleet and NO tasks — only real work shows up.
    if (this.simulate) {
      for (let i = 0; i < 2; i++) this.createTask({}, { silent: true })
      this.createTask({ kind: 'research' }, { silent: true })
      this.createTask({ kind: 'factcheck' }, { silent: true })
    }
  }

  // ── Persistence ──────────────────────────────────────────────────────────
  // A serializable snapshot of the whole world, and its inverse.
  toState() {
    return {
      v: 1,
      agents: [...this.agents.values()].map((a) => a.toState()),
      tasks: this._wireTasks(),
      completed: this._completed,
      autoAssign: this.autoAssign,
      customSkills: [...this.customSkills.values()],
    }
  }

  hydrate(state) {
    this.agents.clear()
    this.tasks.clear()
    for (const rec of state.agents || []) {
      const a = new Agent({
        id: rec.id, name: rec.name, model: rec.model,
        platform: rec.platform, zone: rec.zone, skills: rec.skills,
        autoFor: rec.autoFor, executor: this.executor,
      })
      a.status = rec.status || STATUS.IDLE
      a.taskId = rec.taskId ?? null
      a.task = rec.task || 'idle'
      a.uptime = rec.uptime || 0
      this.agents.set(a.id, a)
    }
    let gc = 0
    for (const t of state.tasks || []) {
      // A persisted custom task lost its `_system` (stripped from the wire/state);
      // re-attach it from the restored skill registry so it can still run.
      if (t.kind === 'custom' && t.skill && !t._system) {
        t._system = (state.customSkills || []).find((s) => s.key === t.skill)?.system
      }
      // Boot-time GC: a pending custom task whose skill no longer exists in the
      // registry can never dispatch (its deleteSkill happened in a past run, or
      // predates the cancel-on-delete fix). Drop it quietly — it's stale junk,
      // not a live event worth a FAILED tombstone.
      if (
        t.kind === 'custom' && t.state === TASK_STATE.BACKLOG &&
        !(state.customSkills || []).some((s) => s.key === t.skill)
      ) { gc++; continue }
      this.tasks.set(t.id, t)
    }
    if (gc) console.log(`  [state] dropped ${gc} orphaned custom task(s) (their skill was deleted)`)
    for (const s of state.customSkills || []) this.customSkills.set(s.key, s)
    this._completed = state.completed || 0
    if (typeof state.autoAssign === 'boolean') this.autoAssign = state.autoAssign

    // Restore id counters so newly created ids can't collide with restored ones.
    const maxNum = (keys, re) => keys.reduce((m, k) => {
      const x = parseInt((String(k).match(re) || [])[1] ?? '-1', 10)
      return x > m ? x : m
    }, -1)
    const aMax = maxNum([...this.agents.keys()], /a0*(\d+)/)
    if (aMax >= 0) setAgentCounter(aMax)
    const tMax = maxNum([...this.tasks.keys()], /t0*(\d+)/)
    if (tMax >= 0) _taskSeq = tMax
  }

  // ── Command handlers (the control plane) ─────────────────────────────────
  spawn(count = 1, opts = {}) {
    const created = []
    for (let i = 0; i < count; i++) {
      // A name + skills are only applied when spawning a single agent.
      const name = opts.name && count === 1 ? opts.name : undefined
      const skills = count === 1 ? opts.skills : undefined
      const autoFor = count === 1 ? opts.autoFor : undefined
      const a = new Agent({ executor: this.executor, zone: pick(ZONE_KEYS), name, skills, autoFor })
      this.agents.set(a.id, a)
      created.push(a)
    }
    if (!opts.silent) {
      const what = opts.name && count === 1 ? opts.name : `${count} agent(s)`
      const tag = created[0]?.skills?.length ? ` [${created[0].skills.join(', ')}]` : ''
      this._log({ who: 'orchestrator', verb: 'spawned', what: `${what}${tag}` })
    }
    return created
  }

  // Author OR EDIT a CUSTOM prompt-skill from the dashboard: a name + a system
  // prompt (the expertise). No code — the executor's customStep runs the model
  // with it. Upserts by key: editing an existing skill may omit name/system to
  // keep the current value (e.g. tweak the prompt without retyping the name).
  // Returns the stored skill record, or null if invalid.
  defineSkill({ key, name, system } = {}) {
    let k = String(key || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    if (!k) k = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    if (!k) return null
    const existing = this.customSkills.get(k)
    const nm = String(name || '').trim() || existing?.name
    const sys = String(system || '').trim() || existing?.system
    if (!nm || !sys) return null // a brand-new skill needs both
    const rec = { key: k, name: nm, system: sys }
    this.customSkills.set(k, rec)
    // Keep any in-flight/backlog custom tasks for this skill in sync with the
    // edited prompt (their server-side `_system` snapshot would otherwise stale).
    for (const t of this.tasks.values()) if (t.kind === 'custom' && t.skill === k) t._system = sys
    this._log({ who: 'orchestrator', verb: existing ? 'skill updated' : 'skill defined', what: `${nm} (${k})` })
    return rec
  }

  // Remove a custom prompt-skill. For each agent that held it:
  //   • if it was AUTO-spawned solely for this skill and never customized
  //     (autoFor === key, no other skills, not renamed → autoFor still set),
  //     remove the agent — it has no remaining purpose;
  //   • otherwise keep the agent and just revoke the capability.
  // Tasks already done are untouched; their saved files remain.
  deleteSkill(key) {
    const k = String(key || '').trim()
    const rec = this.customSkills.get(k)
    if (!rec) return false
    this.customSkills.delete(k)
    const removeIds = []
    for (const a of this.agents.values()) {
      if (!a.skills.includes(k)) continue
      if (a.autoFor === k && a.skills.length === 1) removeIds.push(a.id) // sole-purpose, untouched
      else a.skills = a.skills.filter((s) => s !== k)                    // keep agent, revoke skill
    }
    for (const id of removeIds) this.kill(id) // returns any in-flight task to the backlog
    // Cancel PENDING work for the deleted skill — a backlog task gated on a
    // skill that no longer exists can never dispatch and would sit as a zombie
    // (with the dispatcher warning about it forever). In-flight tasks finish:
    // their agent already carries the prompt on task._system.
    let cancelled = 0
    for (const t of this.tasks.values()) {
      if (t.kind === 'custom' && t.skill === k && t.state === TASK_STATE.BACKLOG) {
        t.state = TASK_STATE.FAILED
        logTask(t, 'orchestrator', 'cancelled —', `skill "${k}" was deleted`)
        cancelled++
      }
    }
    const tail =
      (removeIds.length ? ` · removed ${removeIds.length} auto-specialist(s)` : '') +
      (cancelled ? ` · cancelled ${cancelled} pending task(s)` : '')
    this._log({ who: 'orchestrator', verb: 'skill removed', what: `${rec.name} (${k})${tail}` })
    return true
  }

  // Make sure SOME agent can do `skill`; if none can, spawn a specialist for it.
  // This is what lets "+ task" work even before you've spawned a specialist —
  // the capability appears on demand. No-op for tasks that need no skill.
  _ensureSpecialist(skill) {
    if (!skill) return
    if ([...this.agents.values()].some((a) => a.hasSkill(skill))) return
    const label = this.customSkills.get(skill)?.name ||
      ({ [SKILLS.RPA_ARCHITECT]: 'RPA Architect', [SKILLS.EMAIL]: 'Inbox Assistant' })[skill] ||
      skill
    this.spawn(1, { silent: true, name: label, skills: [skill], autoFor: skill })
    this._log({ who: 'orchestrator', verb: 'auto-spawned', what: `${label} for skill "${skill}"` })
  }

  // Grant/replace an agent's skills (capabilities). Lets an operator turn an
  // existing generalist into a specialist without re-spawning.
  setSkills(agentId, skills) {
    const a = this.agents.get(agentId)
    if (!a || !Array.isArray(skills)) return false
    a.skills = [...new Set(skills.filter((s) => typeof s === 'string' && s.trim()))]
    a.autoFor = null // operator deliberately set its skills — it's no longer a disposable auto-specialist
    this._log({ who: 'orchestrator', verb: 'skills set', what: `${a.name} → ${a.skills.join(', ') || '(none)'}` })
    return true
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

  createTask({ title, zone, stage, parent, kind, topic, claim, finding, brief, skill } = {}, opts = {}) {
    _taskSeq += 1
    // REAL task kinds (see server/research.js):
    //   research  — look up a topic on Wikipedia, summarize it (library)
    //   factcheck — judge a CLAIM against Wikipedia (stage 1, jira floor)
    //   verify    — re-check a claim against an independent 2nd source (stage 2,
    //               conference hall) — created by the fact-check handoff
    // SKILL-GATED kinds (require a matching specialist — see SKILL_FOR_KIND):
    //   rpa-design — design a UiPath/RPA automation for a process (server/rpa.js)
    //   email      — read the Outlook inbox + draft a reply (server/email.js)
    let k = kind || 'sim'
    let tp = topic ?? null
    let cl = claim ?? null
    let br = brief ?? null
    let zn, ti

    if (k === 'research') {
      tp = tp || pick(RESEARCH_TOPICS)
      ti = title || `research: ${tp}`
      zn = 'library'
    } else if (k === 'factcheck') {
      // A user-typed claim without a subject: search Wikipedia by the claim text.
      const c = cl ? { claim: cl, topic: tp || cl } : pick(CLAIMS)
      cl = c.claim; tp = c.topic
      ti = title || `fact-check: ${cl}`
      zn = 'jira'
    } else if (k === 'verify') {
      ti = title || `verify: ${cl ?? ''}`
      zn = 'conference'
    } else if (k === 'rpa-design') {
      br = br || pick(RPA_BRIEFS)
      ti = title || `RPA design: ${br}`
      zn = 'conference' // the solution architect works in the conference hall
    } else if (k === 'email') {
      ti = title || 'email: triage inbox + draft a reply'
      zn = 'office'
    } else if (k === 'custom') {
      // A task for a user-authored prompt-skill. Route by its skill key; carry
      // the skill's system prompt on the (wire-stripped) `_system` field so the
      // executor is self-contained.
      const sk = this.customSkills.get(skill)
      br = br || 'do your specialist work'
      ti = title || `${sk ? sk.name : skill}: ${br}`
      zn = (zone && ZONE_KEYS.includes(zone)) ? zone : 'office'
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
      brief: br,              // the process to automate (rpa-design / custom)
      // required skill routes the task to a matching specialist (custom/external)
      skill: (k === 'custom' || k === 'external') ? skill : undefined,
    }
    // The custom skill's system prompt rides server-side only (`_` → stripped
    // from the wire by _wireTasks); the executor reads it in customStep.
    if (k === 'custom') task._system = this.customSkills.get(skill)?.system
    this.tasks.set(task.id, task)
    // If this task needs a skill nobody has yet, conjure a specialist on demand
    // (so "+ task" works before you've spawned one).
    this._ensureSpecialist(requiredSkill(task))
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
      logTask(t, 'system', 'handed off →', v.title)
      events.push({ who: 'handoff', verb: 'handed off', what: `fact-check → independent verify of "${t.claim}"` })
      return
    }

    // Skill-gated specialist work (rpa-design, email, custom) stands on its own —
    // don't tack on a generic narrated "review:" follow-up that a generalist fakes.
    if (requiredSkill(t)) return

    if (Math.random() > 0.55) return // ~45% of other finished work gets handed off
    // Strip a "research:"/"fact-check:" prefix so we don't get "QA: research: X".
    const base = t.title.replace(/^(research|fact-check):\s*/i, '')
    const followTitle = pick([
      `review: ${base}`,
      `write up: ${base}`,
      `QA: ${base}`,
      `summarize: ${base}`,
    ])
    const follow = this.createTask(
      { title: followTitle, zone: pick(['conference', 'jira', 'office']), stage: 2, parent: t.id },
      { silent: true }
    )
    logTask(t, 'system', 'handed off →', follow.title)
    events.push({ who: 'handoff', verb: 'handed off', what: `${t.title} → ${follow.title}` })
  }

  assign(agentId, taskId) {
    const a = this.agents.get(agentId)
    const t = this.tasks.get(taskId)
    if (!a || !t) return false
    if (a.busy) return false               // don't stomp an in-flight agent
    if (t.state !== TASK_STATE.BACKLOG) return false
    // Manual assigns honor the same skill gate as the dispatcher — otherwise the
    // dropdown could quietly hand specialist work to a generalist.
    const req = requiredSkill(t)
    if (req && !a.hasSkill(req)) {
      this._log({ who: 'orchestrator', verb: 'refused', what: `${a.name} lacks skill "${req}" for "${t.title}"` })
      return false
    }
    a.assign(t)
    if (!t.startedAt) t.startedAt = Date.now()
    this._log({ who: a.name, verb: 'assigned', what: t.title })
    return true
  }

  pause(agentId) { const a = this.agents.get(agentId); if (a) { a.pause(); return true } return false }
  resume(agentId) { const a = this.agents.get(agentId); if (a) { a.resume(); return true } return false }

  rename(agentId, name) {
    const a = this.agents.get(agentId)
    if (!a || !name || !String(name).trim()) return false
    const old = a.name
    a.name = String(name).trim().slice(0, 40)
    a.autoFor = null // you've customized it — it's no longer a disposable auto-specialist
    this._log({ who: 'orchestrator', verb: 'renamed', what: `${old} → ${a.name}` })
    return true
  }

  move(agentId, zone) {
    const a = this.agents.get(agentId)
    if (!a || !ZONE_KEYS.includes(zone)) return false
    a.moveTo(zone)
    this._log({ who: a.name, verb: 'moved to', what: zone })
    return true
  }

  setAuto(enabled) { this.autoAssign = !!enabled }
  setSim(enabled) { this.simulate = !!enabled }

  // Externally complete a task with a REAL result (e.g. Claude's Conductor output
  // from Memex), overwriting any simulated result. Matched by title substring.
  completeTask(match, result) {
    const m = String(match || '').toLowerCase()
    if (!m) return false
    let target = null
    for (const t of this.tasks.values()) {
      if (String(t.title || '').toLowerCase().includes(m)) {
        // prefer a task still in flight; otherwise the most recent match
        if (!target || t.state !== TASK_STATE.DONE) target = t
      }
    }
    if (!target) return false
    target.state = TASK_STATE.DONE
    target.result = result || target.result
    target.progress = 1
    target.doneBy = 'Claude · Memex'
    target.doneAt = Date.now()
    target.elapsedMs = target.startedAt ? target.doneAt - target.startedAt : null
    this._completed += 1 // count it on the "done" tally (agent-completed tasks bump this elsewhere)
    for (const a of this.agents.values()) {
      if (a.taskId === target.id) { a.taskId = null; a.task = 'idle'; a.status = STATUS.IDLE }
    }
    this._log({ who: 'Claude · Memex', verb: 'completed', what: target.title, taskId: target.id })
    return true
  }

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
      case 'spawn': this.spawn((payload.name || payload.skills) ? 1 : (payload.count ?? 1), { name: payload.name, skills: payload.skills }); return true
      case 'kill': return this.kill(payload.agentId)
      case 'assign': return this.assign(payload.agentId, payload.taskId)
      case 'create_task': this.createTask(payload); return true
      case 'pause': return this.pause(payload.agentId)
      case 'resume': return this.resume(payload.agentId)
      case 'move': return this.move(payload.agentId, payload.zone)
      case 'rename': return this.rename(payload.agentId, payload.name)
      case 'set_skills': return this.setSkills(payload.agentId, payload.skills)
      case 'define_skill': return !!this.defineSkill(payload)
      case 'delete_skill': return this.deleteSkill(payload.key)
      case 'set_auto': this.setAuto(payload.enabled); return true
      case 'set_sim': this.setSim(payload.enabled); return true
      case 'complete_task': return this.completeTask(payload.match, payload.result)
      case 'reset': this.reset(); return true
      default: return false
    }
  }

  // ── The dispatcher (the scheduler) ───────────────────────────────────────
  // Policy: greedily match the oldest backlog task to any idle agent. This is
  // the simplest possible scheduler. Smarter policies would weigh agent skills,
  // task priority, locality, fairness — but they all slot in right here.
  _dispatch(events = []) {
    if (!this.autoAssign) return
    // WIP limit: don't exceed maxConcurrent tasks in flight at once.
    const busy = [...this.agents.values()].filter((a) => a.taskId).length
    let slots = this.maxConcurrent - busy
    if (slots <= 0) return
    const idlePool = [...this.agents.values()].filter((a) => a.status === STATUS.IDLE)
    if (!idlePool.length) return
    // Priority: stage-2 verify first (finish pipelines), then real/specialist
    // work so it's promptly visible, then simulated tasks.
    const rank = (t) =>
      (t.stage ?? 1) * 10 +
      (t.kind === 'verify' ? 5
        : requiredSkill(t) ? 4                    // skill-gated specialist work
        : t.kind === 'factcheck' || t.kind === 'research' ? 3
        : 0)
    const backlog = [...this.tasks.values()]
      .filter((t) => t.state === TASK_STATE.BACKLOG)
      .sort((a, b) => rank(b) - rank(a))
    for (const task of backlog) {
      if (slots <= 0 || !idlePool.length) break
      // A skill-gated task may ONLY go to an agent that owns the skill. Honor
      // _exclude too (e.g. a verify task must not go to the stage-1 agent).
      const reqSkill = requiredSkill(task)
      const idx = idlePool.findIndex(
        (a) => a.hasSkill(reqSkill) && (!task._exclude || a.name !== task._exclude),
      )
      if (idx === -1) {
        // No eligible idle agent. If it's a skill the WHOLE fleet lacks, say so
        // once so the board doesn't look mysteriously stuck.
        if (reqSkill && ![...this.agents.values()].some((a) => a.hasSkill(reqSkill))) {
          this._warnMissingSkill(reqSkill, events)
        }
        continue
      }
      const a = idlePool.splice(idx, 1)[0]
      a.assign(task)
      if (!task.startedAt) task.startedAt = Date.now()
      this._log({ who: a.name, verb: 'picked up', what: task.title })
      slots--
    }
  }

  // ── Fault tolerance ──────────────────────────────────────────────────────
  // When an agent reports a hard failure (executor threw / watchdog timed out),
  // the RETRY POLICY lives here, not in the agent: requeue the task once for a
  // fresh attempt (any agent may pick it up), and if it fails again, dead-letter
  // it as FAILED so the board shows the truth instead of a fake "done".
  _handleFailure(taskId, note, events) {
    const t = this.tasks.get(taskId)
    if (!t) return
    t.agentId = null
    t.attempts = (t.attempts || 0) + 1
    if (t.attempts < 2) {
      // Reset transient progress so the retry starts clean.
      t.state = TASK_STATE.BACKLOG
      t.progress = 0
      delete t.phase
      logTask(t, 'orchestrator', 'requeued for retry —', note)
      events.push({ who: 'orchestrator', verb: 'requeued', what: `${t.title} (attempt ${t.attempts + 1}/2) — ${note}` })
    } else {
      t.state = TASK_STATE.FAILED
      logTask(t, 'orchestrator', 'gave up —', note)
      events.push({ who: 'orchestrator', verb: 'marked FAILED', what: `${t.title} — ${note}` })
    }
  }

  // Log a "no agent has skill X" warning at most once per ~30 ticks per skill,
  // so a backlog of specialist work with no specialist is visible but not spammy.
  _warnMissingSkill(skill, events) {
    this._skillWarn ??= {}
    const n = this.tick._n ?? 0
    if (this._skillWarn[skill] != null && n - this._skillWarn[skill] < 30) return
    this._skillWarn[skill] = n
    const line = { who: 'orchestrator', verb: 'waiting', what: `no agent has skill "${skill}" — spawn or grant one` }
    this._log(line)
    events?.push(line) // also surface it on the wire so the UI feed shows it
  }

  // ── The loop: one tick ───────────────────────────────────────────────────
  tick(metricsSample) {
    // 3. ADVANCE (declare the event buffer first so DISPATCH can add to it)
    const events = []

    // 2. DISPATCH (may push "no agent has skill X" warnings into events)
    this._dispatch(events)

    for (const a of this.agents.values()) {
      const line = a.tick(this.tasks)
      if (line) {
        events.push(line)
        // A hard step failure: the agent freed itself; apply the retry policy.
        if (line.failed && line.taskId) this._handleFailure(line.taskId, line.what, events)
        if (line.verb === 'completed') {
          this._completed += 1
          const dt = line.taskId ? this.tasks.get(line.taskId) : null
          if (dt && !dt.doneAt) { dt.doneAt = Date.now(); dt.elapsedMs = dt.startedAt ? dt.doneAt - dt.startedAt : null }
        }
        if (line.verb === 'completed' && line.taskId) {
          // Deliberate SPECIALIST work (RPA designs, email drafts) leaves a real
          // file, saved before the task is pruned so the deliverable isn't lost.
          // We DON'T file the ambient research/fact-check trickle — that would
          // flood server/outputs/ with dozens of demo artifacts nobody asked for.
          // (They still show in the UI feed + task detail; they're just not saved.)
          const t = this.tasks.get(line.taskId)
          if (t && !t.artifact && requiredSkill(t)) {
            try {
              const path = saveArtifact(t)
              if (path) { t.artifact = path; events.push({ who: 'archive', verb: 'saved', what: `${t.title} → ${path}` }) }
            } catch (err) { this._log({ who: 'archive', verb: 'save failed', what: err.message }) }
          }
          // Then maybe hand the result to a teammate. Pass the doer's name so a
          // verify task goes to a DIFFERENT agent.
          this._maybeHandoff(line.taskId, events, line.who)
        }
      }
    }
    events.forEach((e) => this._log(e))

    // Keep the wire bounded: retain only the most recent done tasks (the true
    // cumulative count lives in this._completed), and the most recent failures.
    const doneTasks = [...this.tasks.values()].filter((t) => t.state === TASK_STATE.DONE)
    if (doneTasks.length > 40) for (const t of doneTasks.slice(0, doneTasks.length - 40)) this.tasks.delete(t.id)
    const failedTasks = [...this.tasks.values()].filter((t) => t.state === TASK_STATE.FAILED)
    if (failedTasks.length > 10) for (const t of failedTasks.slice(0, failedTasks.length - 10)) this.tasks.delete(t.id)

    // keep a steady trickle of new work so the demo never stalls (simulation only)
    const backlogCount = [...this.tasks.values()].filter((t) => t.state === TASK_STATE.BACKLOG).length
    if (this.simulate && backlogCount < 3 && Math.random() < 0.5) {
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
      completed: this._completed,
      simulate: this.simulate,
      skills: this._skillCatalog(), // custom prompt-skills, so the UI can list them
      llm: this._llmInfo(),         // live model + shared-limiter counters for the HUD
      // Keep a generous window: with up to maxConcurrent agents emitting a line
      // per tick (plus board/handoff lines), a small slice would silently drop
      // the earliest agents' events (e.g. a fact-check verdict).
      events: events.slice(-16),
    }
  }

  // Live LLM telemetry for the HUD: the ACTIVE model (post-rotation) and the
  // shared executor's counters — so you can literally watch the whole fleet
  // bottleneck on the rate limit. null when running the simulated executor.
  _llmInfo() {
    const ex = this.executor
    if (!ex || typeof ex.current !== 'function' || !ex.stats) return null
    return {
      model: ex.current().split('/').pop(),
      calls: ex.stats.calls,
      errors: ex.stats.errors,
      throttled: ex.stats.rateLimited,
    }
  }

  // The full skill catalog for the wire: BUILT-IN skills (code-backed — rpa,
  // email — shown so the panel is complete, but not editable) followed by the
  // user's CUSTOM prompt-skills (with their system prompt, so the UI can edit
  // them). `kind` tells the UI which task kind a "+ task" should create.
  _skillCatalog() {
    const builtins = [
      { key: SKILLS.RPA_ARCHITECT, name: 'RPA Architect', kind: 'rpa-design', builtin: true },
      { key: SKILLS.EMAIL, name: 'Inbox Assistant', kind: 'email', builtin: true },
    ]
    const customs = [...this.customSkills.values()].map((s) => ({
      key: s.key, name: s.name, system: s.system, kind: 'custom', builtin: false,
    }))
    return [...builtins, ...customs]
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
      completed: this._completed,
      simulate: this.simulate,
      skills: this._skillCatalog(),
      llm: this._llmInfo(),
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
