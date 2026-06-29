// controls.js
// The operator's control surface — the part that makes this an ORCHESTRATOR
// rather than just a viewer. It turns clicks into COMMANDS and sends them up
// through the gateway. It never mutates state directly; it only asks.
//
//   • Toolbar (top-center): fleet-wide actions — spawn agent, add task,
//     toggle the auto-dispatcher, reset the board.
//   • Agent panel (left, below brand): appears when an agent is selected —
//     pause/resume, send-to-zone, assign next task, remove.

import { COMMAND } from '../../server/protocol.js'
import { ZONES } from '../sim/gateway.js'

function el(tag, cls, html) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html != null) n.innerHTML = html
  return n
}

export class Controls {
  /**
   * @param {HTMLElement} root  the #hud overlay
   * @param {(type, payload) => void} send  gateway.send
   * @param {{ onSelectNone:Function }} hooks
   */
  constructor(root, send, hooks = {}) {
    this.root = root
    this.send = send
    this.hooks = hooks
    this._selected = null   // current agent record
    this._tasks = []        // latest task list (for the assign menu)
    this._build()
  }

  _build() {
    // ── Toolbar ──
    this.toolbar = el('div', 'hud__panel toolbar')
    this.toolbar.innerHTML = `
      <button data-act="spawn" title="Create a new agent">+ agent</button>
      <button data-act="task" title="Add a simulated task to the backlog">+ task</button>
      <button data-act="research" title="Add a REAL research task (live Wikipedia lookup + summary)">+ research</button>
      <button data-act="auto" title="Toggle the auto-dispatcher">auto: <b>on</b></button>
      <button data-act="reset" class="ghost" title="Clear the board">reset</button>
    `
    this.toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return
      const act = b.dataset.act
      if (act === 'spawn') this.send(COMMAND.SPAWN, { count: 1 })
      else if (act === 'task') this.send(COMMAND.CREATE_TASK, {})
      else if (act === 'research') this.send(COMMAND.CREATE_TASK, { kind: 'research' })
      else if (act === 'reset') this.send(COMMAND.RESET, {})
      else if (act === 'auto') {
        this._auto = !this._auto
        b.querySelector('b').textContent = this._auto ? 'on' : 'off'
        this.send(COMMAND.SET_AUTO, { enabled: this._auto })
      }
    })
    this._auto = true

    // ── Agent command panel ──
    this.panel = el('div', 'hud__panel agentctl')
    this.panel.style.display = 'none'
    this.root.append(this.toolbar, this.panel)
  }

  setTasks(tasks) { this._tasks = tasks || [] }

  // Called when selection changes (record or null).
  select(record) {
    this._selected = record
    if (!record) { this.panel.style.display = 'none'; return }
    this._render()
  }

  // Refresh the panel contents for the current selection (status may have moved).
  refresh(record) {
    if (record && this._selected && record.id === this._selected.id) {
      this._selected = record
      this._render()
    }
  }

  _render() {
    const a = this._selected
    if (!a) return
    const paused = a.status === 'paused'
    const zoneBtns = ZONES.map((z) =>
      `<button class="mini" data-move="${z.key}">${z.label}</button>`).join('')

    this.panel.style.display = 'block'
    this.panel.innerHTML = `
      <div class="agentctl__name">${a.name}</div>
      <div class="agentctl__meta">${a.model} · ${a.platform}</div>
      <div class="agentctl__meta">${a.status} — ${a.task}</div>
      <div class="agentctl__row">
        <button data-act="${paused ? 'resume' : 'pause'}">${paused ? '▶ resume' : '⏸ pause'}</button>
        <button data-act="assign">assign task</button>
        <button data-act="kill" class="danger">remove</button>
      </div>
      <div class="agentctl__label">send to zone</div>
      <div class="agentctl__zones">${zoneBtns}</div>
    `

    this.panel.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return
      const id = a.id
      if (b.dataset.move) this.send(COMMAND.MOVE, { agentId: id, zone: b.dataset.move })
      else if (b.dataset.act === 'pause') this.send(COMMAND.PAUSE, { agentId: id })
      else if (b.dataset.act === 'resume') this.send(COMMAND.RESUME, { agentId: id })
      else if (b.dataset.act === 'kill') { this.send(COMMAND.KILL, { agentId: id }); this.hooks.onSelectNone?.() }
      else if (b.dataset.act === 'assign') {
        const next = this._tasks.find((t) => t.state === 'backlog')
        if (next) this.send(COMMAND.ASSIGN, { agentId: id, taskId: next.id })
      }
    }
  }
}
