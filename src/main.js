// main.js — entry point. Wires the gateway (data + commands) to the world (3D),
// the HUD (telemetry), and the Controls (orchestration).
//
//   gateway --snapshot/tick--> world + hud        (data plane, flows down)
//   controls --send(command)--> gateway           (control plane, flows up)
//
import { World } from './scene/world.js'
import { Hud } from './ui/hud.js'
import { Controls } from './ui/controls.js'
import { createGateway } from './sim/gateway.js'

function boot() {
  const stage = document.getElementById('stage')
  const hudRoot = document.getElementById('hud')
  const veil = document.getElementById('boot')

  const world = new World(stage)
  const hud = new Hud(hudRoot)
  const gateway = createGateway()
  const controls = new Controls(hudRoot, (type, payload) => gateway.send(type, payload))

  let lastRecords = []

  // Hover → floating tooltip (only when nothing is pinned-selected).
  world.onHover((record, screen) => {
    if (!world.selectedId()) hud.showTag(record, screen)
    else hud.showTag(null)
  })

  // Selection is two-way: clicking an agent in 3D highlights its row in the
  // directory, and clicking a directory row highlights the agent in 3D.
  world.onSelect((record) => controls.setSelected(record ? record.id : null))
  controls.onPick((id) => world.select(id))

  // Full snapshot: build avatars + seed HUD.
  gateway.on('snapshot', ({ agents, tasks, host, version, completed, skills }) => {
    if (version) hud.setVersion(version)
    hud.setMode(gateway.kind)
    world.spawn(agents)
    lastRecords = agents
    const active = agents.filter((a) => a.status !== 'idle' && a.status !== 'paused').length
    hud.update({ agents, host, active })
    hud.updateBoard(tasks, completed)
    controls.setTasks(tasks)
    controls.setSkills(skills)
    controls.setRoster(agents)
    requestAnimationFrame(() => veil.classList.add('hidden'))
    setTimeout(() => veil.remove(), 800)
  })

  // Per-tick: reconcile avatars + refresh HUD, board, feed, and the open panel.
  gateway.on('tick', ({ agents, tasks, host, active, events, completed, skills }) => {
    world.sync(agents)
    lastRecords = agents
    hud.setMode(gateway.kind) // kind can flip if a remote feed falls back to sim
    hud.update({ agents, host, active })
    hud.updateBoard(tasks, completed)
    hud.pushEvents(events)
    controls.setTasks(tasks)
    controls.setSkills(skills)
    controls.setRoster(agents) // live roster keeps the directory + selected row fresh
  })

  world.start()
  gateway.start()

  // Console handle for poking at it live, e.g. __agora.gateway.send('spawn', {count:5})
  window.__agora = { world, hud, controls, gateway }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
