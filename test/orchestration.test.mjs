// orchestration.test.mjs — deterministic tests for the orchestration core.
// No network, no model: executors are stubbed. Run with `npm test`.
//
// These cover the FAULT-TOLERANCE contract (the part a demo can't easily show):
//   • a failing step is retried once, then the task is dead-lettered as FAILED
//   • a HUNG executor call trips the agent's watchdog instead of wedging it
//   • manual assign honors the same skill gate as the auto-dispatcher

import test from 'node:test'
import assert from 'node:assert/strict'
import { Orchestrator } from '../server/orchestrator.js'
import { Agent } from '../server/agent-runtime.js'
import { TASK_STATE, SKILLS } from '../server/protocol.js'

// One tick + a microtask flush, so async executor results land like real time.
async function tickFlush(o) {
  const out = o.tick(null)
  await new Promise((r) => setImmediate(r))
  return out
}

test('a failing step is requeued once, then marked FAILED', async () => {
  const failing = { step: async () => ({ failed: true, note: 'boom' }) }
  const o = new Orchestrator({ executor: failing })
  o.spawn(1, { silent: true })
  const t = o.createTask({ title: 'doomed task' }, { silent: true })

  let sawRequeue = false
  for (let i = 0; i < 400 && o.tasks.get(t.id)?.state !== TASK_STATE.FAILED; i++) {
    const { events } = await tickFlush(o)
    if (events.some((e) => e.verb === 'requeued' && e.what.includes('doomed task'))) sawRequeue = true
  }

  const done = o.tasks.get(t.id)
  assert.equal(done.state, TASK_STATE.FAILED, 'task should end FAILED')
  assert.equal(done.attempts, 2, 'exactly two attempts (1 retry)')
  assert.ok(sawRequeue, 'a requeue event should have been published')
  assert.equal(done.agentId, null, 'failed task is not left assigned')
})

test('watchdog: a hung executor call fails the step instead of wedging the agent', async () => {
  const hung = { step: () => new Promise(() => {}) } // never resolves
  const a = new Agent({ executor: hung })
  const task = { id: 't1', title: 'stuck', zone: 'office', state: TASK_STATE.BACKLOG, progress: 0 }
  const board = new Map([[task.id, task]])
  a.assign(task)

  let failedLine = null
  for (let i = 0; i < 200 && !failedLine; i++) {
    const line = a.tick(board)
    if (line?.failed) failedLine = line
    await new Promise((r) => setImmediate(r))
  }

  assert.ok(failedLine, 'agent should report a failure line')
  assert.match(failedLine.what, /timed out/, 'failure should name the watchdog timeout')
  assert.equal(a.status, 'idle', 'agent frees itself after the failure')
  assert.equal(a.taskId, null)
})

test('deleting a skill cancels its pending tasks (no zombies)', () => {
  const o = new Orchestrator({ executor: { step: async () => ({ delta: 1, note: 'ok' }) } })
  o.setAuto(false)
  o.defineSkill({ key: 'zeta', name: 'Zeta', system: 'You are Zeta.' })
  const t = o.createTask({ kind: 'custom', skill: 'zeta', brief: 'pending work' }, { silent: true })
  assert.equal(t.state, TASK_STATE.BACKLOG)

  o.deleteSkill('zeta')
  assert.equal(t.state, TASK_STATE.FAILED, 'pending task is cancelled, not left as a zombie')
  assert.equal([...o.agents.values()].some((a) => a.hasSkill('zeta')), false, 'skill revoked everywhere')
})

test('manual assign honors the skill gate (and the specialist path works)', () => {
  const o = new Orchestrator({ executor: { step: async () => ({ delta: 1, note: 'ok' }) } })
  o.setAuto(false) // keep the dispatcher out of it

  const [generalist] = o.spawn(1, { silent: true })
  const t = o.createTask({ kind: 'rpa-design', brief: 'automate a thing' }, { silent: true })
  // createTask auto-spawned a specialist for the missing skill:
  const architect = [...o.agents.values()].find((a) => a.hasSkill(SKILLS.RPA_ARCHITECT))
  assert.ok(architect, 'a specialist should be auto-spawned on demand')

  assert.equal(o.assign(generalist.id, t.id), false, 'generalist must be refused')
  assert.equal(t.state, TASK_STATE.BACKLOG, 'task untouched after refusal')
  assert.equal(o.assign(architect.id, t.id), true, 'specialist is accepted')
  assert.equal(t.agentId, architect.id)
})
