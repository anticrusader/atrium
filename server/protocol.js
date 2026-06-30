// protocol.js
// The shared contract between the orchestrator (server) and the dashboard
// (browser). This file is imported by BOTH sides so the message shapes can
// never drift apart. It is plain data + tiny validators — no logic.
//
// ───────────────────────────────────────────────────────────────────────────
// MENTAL MODEL (read this first)
//
// Orchestration is a CONTROL PLANE and a DATA PLANE talking over one channel:
//
//   browser  ──────  COMMANDS (control plane)  ──────▶  orchestrator
//   browser  ◀─────  EVENTS   (data plane)     ──────   orchestrator
//
//   • EVENTS flow DOWN: the orchestrator continuously publishes the state of
//     the world (which agents exist, what they're doing, the task board, host
//     load). The dashboard is a passive mirror of this.
//   • COMMANDS flow UP: the dashboard asks the orchestrator to CHANGE the
//     world (spawn an agent, create a task, assign work, pause, move…).
//
// The orchestrator is the single source of truth. The browser never mutates
// state directly — it sends a command, the orchestrator applies it, and the
// resulting change comes back as the next EVENT. This is the same loop real
// systems use (Kubernetes, CI runners, actor systems): *declare intent, then
// observe reconciled state.*
// ───────────────────────────────────────────────────────────────────────────

// The ten office zones (must match the front-end ZONE_LAYOUT keys).
export const ZONE_KEYS = [
  'reception', 'lounge', 'designers', 'library', 'cafe',
  'playroom', 'jira', 'conference', 'office', 'courtyard',
]

// Agent lifecycle states. The dashboard maps each to a color/animation.
export const STATUS = Object.freeze({
  IDLE: 'idle',         // alive, no task
  WALKING: 'walking',   // moving toward a zone to start work
  THINKING: 'thinking', // planning a step
  WORKING: 'working',   // executing a step
  MESSAGING: 'messaging', // emitting a result / talking to another agent
  PAUSED: 'paused',     // suspended by an operator
})

// Task lifecycle states (the "Jira Floor" board columns).
export const TASK_STATE = Object.freeze({
  BACKLOG: 'backlog',         // created, not yet assigned
  ASSIGNED: 'assigned',       // handed to an agent, not started
  IN_PROGRESS: 'in_progress', // an agent is actively working it
  DONE: 'done',               // completed
  FAILED: 'failed',           // gave up / errored
})

// ── EVENTS: orchestrator → browser ──────────────────────────────────────────
export const EVENT = Object.freeze({
  SNAPSHOT: 'snapshot', // full world state on connect: { agents, tasks, host, version }
  TICK: 'tick',         // incremental update: { agents, tasks, host, active, events }
  ACK: 'ack',           // command accepted: { id, ok, message? }
})

// ── COMMANDS: browser → orchestrator ────────────────────────────────────────
export const COMMAND = Object.freeze({
  SPAWN: 'spawn',           // { count?, name?, skills? } create new agent(s)
  KILL: 'kill',             // { agentId }           remove an agent
  ASSIGN: 'assign',         // { agentId, taskId }   give a specific task to an agent
  CREATE_TASK: 'create_task', // { title?, zone? }   add a task to the backlog
  PAUSE: 'pause',           // { agentId }
  RESUME: 'resume',         // { agentId }
  MOVE: 'move',             // { agentId, zone }     send an agent to a zone
  RENAME: 'rename',         // { agentId, name }     rename an agent
  SET_SKILLS: 'set_skills', // { agentId, skills }   set an agent's skills (capabilities)
  DEFINE_SKILL: 'define_skill', // { key, name, system } author/edit a custom prompt-skill
  DELETE_SKILL: 'delete_skill', // { key }            remove a custom prompt-skill
  SET_AUTO: 'set_auto',     // { enabled }           toggle the auto-dispatcher
  RESET: 'reset',           // {}                    clear tasks, idle everyone
})

// ── SKILLS (agent capabilities) ──────────────────────────────────────────────
// A "skill" is a capability an agent has. A task whose `kind` appears here may
// ONLY be dispatched to an agent that owns the matching skill — this is how the
// scheduler stops handing specialist work to a generalist. Task kinds NOT listed
// here (research, factcheck, verify, sim) have no requirement: anyone can do them.
//
//   skill key      what the agent can do
//   ───────────    ─────────────────────────────────────────────────────────
//   rpa-architect  design UiPath/RPA automation solutions (solution architect)
//   email          read the Outlook inbox + draft replies (never auto-sends)
export const SKILLS = Object.freeze({
  RPA_ARCHITECT: 'rpa-architect',
  EMAIL: 'email',
})

// Which skill a BUILT-IN task kind REQUIRES (kind → skill). Used by the
// dispatcher. Custom prompt-skills authored from the page use kind `custom` and
// carry their required skill on `task.skill` instead (see Orchestrator).
export const SKILL_FOR_KIND = Object.freeze({
  'rpa-design': SKILLS.RPA_ARCHITECT,
  email: SKILLS.EMAIL,
})

// The required skill for ANY task: built-in map, or a custom task's own skill.
export function requiredSkill(task) {
  return SKILL_FOR_KIND[task.kind] || (task.kind === 'custom' ? task.skill : undefined)
}

// Build a command envelope. `id` lets the UI correlate the ACK.
let _seq = 0
export function command(type, payload = {}) {
  _seq += 1
  return { kind: 'command', id: `c${_seq}`, type, payload }
}

// Build an event envelope.
export function event(type, payload = {}) {
  return { kind: 'event', type, payload }
}

// Minimal runtime validation so a malformed frame is rejected, not crashed on.
export function isCommand(msg) {
  return msg && msg.kind === 'command' &&
    typeof msg.type === 'string' &&
    Object.values(COMMAND).includes(msg.type)
}

export function isZone(z) { return ZONE_KEYS.includes(z) }

// The canonical agent record shape (documented here, produced by the runtime).
//   { id, name, model, platform, zone, status, task, taskId, uptime, skills }
// The canonical task record shape:
//   { id, title, zone, state, agentId, progress (0..1) }
