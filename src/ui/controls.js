// controls.js
// The operator's control surface — turns clicks into COMMANDS sent up through
// the gateway. It never mutates state directly; it only asks.
//
//   • Toolbar (top-center): fleet-wide actions — spawn agent, add tasks,
//     toggle the auto-dispatcher, reset.
//   • Agent directory (left): a scrollable list of EVERY agent. Click a row to
//     select it (highlights it in the 3D office) and expand its details +
//     actions: pause/resume, rename, assign next task, send-to-zone, remove.

import { COMMAND } from '../../server/protocol.js'
import { ZONES } from '../sim/gateway.js'

const STATUS_COLOR = {
  idle: '#6b7d99', walking: '#5ab8ff', thinking: '#2fe6d6',
  messaging: '#ffcf5c', working: '#57e08a', paused: '#ff6b7a',
}

function el(tag, cls, html) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html != null) n.innerHTML = html
  return n
}

function fmtUptime(sec = 0) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

export class Controls {
  constructor(root, send) {
    this.root = root
    this.send = send
    this._agents = []       // latest roster
    this._tasks = []        // latest task list (for assign)
    this._selectedId = null // expanded/selected agent id
    this._pickCb = null     // tell the 3D world to highlight an agent
    this._auto = true
    this._build()
  }

  // main.js connects this so a list click highlights the agent in 3D.
  onPick(cb) { this._pickCb = cb }

  _build() {
    // ── Toolbar ──
    this.toolbar = el('div', 'hud__panel toolbar')
    this.toolbar.innerHTML = `
      <button data-act="spawn" title="Create a new agent (you can name it)">+ agent</button>
      <button data-act="task" title="Add a simulated task (you can title it)">+ task</button>
      <button data-act="research" title="Add a REAL research task (live Wikipedia lookup + summary)">+ research</button>
      <button data-act="factcheck" title="Add a REAL fact-check (a 2nd agent independently verifies)">+ fact-check</button>
      <button data-act="auto" title="Toggle the auto-dispatcher">auto: <b>on</b></button>
      <button data-act="reset" class="ghost" title="Clear the board">reset</button>
    `
    const ask = (label) => { const v = window.prompt(label); return v && v.trim() ? v.trim() : null }
    this.toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return
      const act = b.dataset.act
      if (act === 'spawn') { const name = ask('Name your new agent (blank = random):'); this.send(COMMAND.SPAWN, name ? { name } : { count: 1 }) }
      else if (act === 'task') { const title = ask('Task title (blank = random):'); this.send(COMMAND.CREATE_TASK, title ? { title } : {}) }
      else if (act === 'research') { const topic = ask('Topic to research on Wikipedia (blank = random):'); this.send(COMMAND.CREATE_TASK, topic ? { kind: 'research', topic } : { kind: 'research' }) }
      else if (act === 'factcheck') { const claim = ask('Claim to fact-check (blank = random):'); this.send(COMMAND.CREATE_TASK, claim ? { kind: 'factcheck', claim } : { kind: 'factcheck' }) }
      else if (act === 'reset') this.send(COMMAND.RESET, {})
      else if (act === 'auto') {
        this._auto = !this._auto
        b.querySelector('b').textContent = this._auto ? 'on' : 'off'
        this.send(COMMAND.SET_AUTO, { enabled: this._auto })
      }
    })

    // ── Agent directory ──
    this.dir = el('div', 'hud__panel directory')
    this.dir.innerHTML = `
      <div class="dir__head">AGENTS <span id="dir-count">0</span></div>
      <ul class="dir__list" id="dir-list"></ul>
    `
    this.list = this.dir.querySelector('#dir-list')

    // Click: a row toggles selection; a button runs an action.
    this.list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]')
      if (btn) { e.stopPropagation(); this._action(btn.dataset.act, btn.closest('[data-id]').dataset.id); return }
      const row = e.target.closest('[data-id]')
      if (row) this._select(row.dataset.id)
    })
    // Send-to-zone dropdown.
    this.list.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-act="move"]')
      if (sel && sel.value) { this.send(COMMAND.MOVE, { agentId: sel.closest('[data-id]').dataset.id, zone: sel.value }); sel.value = '' }
    })

    this.root.append(this.toolbar, this.dir)
  }

  setTasks(tasks) { this._tasks = tasks || [] }

  // Called every tick/snapshot with the live roster.
  setRoster(agents) {
    this._agents = agents || []
    // drop selection if the agent is gone
    if (this._selectedId && !this._agents.some((a) => a.id === this._selectedId)) this._selectedId = null
    this._render()
  }

  // Selection coming FROM the 3D world (don't echo back to avoid a loop).
  setSelected(id) {
    if (id === this._selectedId) return
    this._selectedId = id
    this._render()
    this._scrollToSelected()
  }

  // Selection coming FROM a list click → also highlight in the 3D world.
  _select(id) {
    this._selectedId = this._selectedId === id ? null : id
    this._render()
    this._pickCb?.(this._selectedId)
  }

  _action(act, id) {
    if (act === 'pause') this.send(COMMAND.PAUSE, { agentId: id })
    else if (act === 'resume') this.send(COMMAND.RESUME, { agentId: id })
    else if (act === 'kill') this.send(COMMAND.KILL, { agentId: id })
    else if (act === 'rename') {
      const a = this._agents.find((x) => x.id === id)
      const name = window.prompt('Rename agent:', a?.name || '')
      if (name && name.trim()) this.send(COMMAND.RENAME, { agentId: id, name: name.trim() })
    } else if (act === 'assign') {
      const next = this._tasks.find((t) => t.state === 'backlog')
      if (next) this.send(COMMAND.ASSIGN, { agentId: id, taskId: next.id })
    }
  }

  _scrollToSelected() {
    const row = this.list.querySelector(`[data-id="${this._selectedId}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }

  _render() {
    this.dir.querySelector('#dir-count').textContent = `· ${this._agents.length}`
    const scroll = this.list.scrollTop
    this.list.innerHTML = this._agents.map((a) => this._rowHtml(a)).join('')
    this.list.scrollTop = scroll
  }

  _rowHtml(a) {
    const sel = a.id === this._selectedId
    const color = STATUS_COLOR[a.status] || STATUS_COLOR.idle
    const head = `
      <div class="dir__row">
        <span class="dir__dot" style="background:${color};box-shadow:0 0 6px ${color}"></span>
        <span class="dir__name">${a.name}</span>
        <span class="dir__st" style="color:${color}">${a.status}</span>
      </div>`
    if (!sel) return `<li data-id="${a.id}" class="dir__item">${head}</li>`

    const paused = a.status === 'paused'
    const zones = ZONES.map((z) => `<option value="${z.key}">${z.label}</option>`).join('')
    return `<li data-id="${a.id}" class="dir__item sel">
      ${head}
      <div class="dir__detail">
        <div class="dir__meta">${a.model} · ${a.platform}</div>
        <div class="dir__meta">${a.status} — ${a.task || 'idle'}</div>
        <div class="dir__meta">uptime ${fmtUptime(a.uptime)}</div>
        <div class="dir__acts">
          <button data-act="${paused ? 'resume' : 'pause'}">${paused ? '▶ resume' : '⏸ pause'}</button>
          <button data-act="rename">✎ rename</button>
          <button data-act="assign">assign</button>
          <button data-act="kill" class="danger">✕ remove</button>
        </div>
        <select data-act="move" class="dir__move"><option value="">send to zone…</option>${zones}</select>
      </div>
    </li>`
  }
}
