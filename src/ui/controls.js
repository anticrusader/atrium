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

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

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
    this._rowEls = new Map() // id -> <li>, so we UPDATE rows in place (never
                             // rebuild) — otherwise the per-tick refresh would
                             // destroy an open "send to zone" dropdown.
    this._build()
  }

  // main.js connects this so a list click highlights the agent in 3D.
  onPick(cb) { this._pickCb = cb }

  _build() {
    // ── Toolbar ──
    this.toolbar = el('div', 'hud__panel toolbar')
    this.toolbar.innerHTML = `
      <button data-act="spawn" title="Create a new agent (you can name it)">+ agent</button>
      <button data-act="specialist" title="Spawn a SPECIALIST agent with a skill (rpa-architect / email)">+ specialist</button>
      <button data-act="skill" title="Design a NEW skill from a name + expertise prompt, then put a specialist on it">+ skill</button>
      <button data-act="task" title="Add a simulated task (you can title it)">+ task</button>
      <button data-act="research" title="Add a REAL research task (live Wikipedia lookup + summary)">+ research</button>
      <button data-act="factcheck" title="Add a REAL fact-check (a 2nd agent independently verifies)">+ fact-check</button>
      <button data-act="rpa" title="Ask the RPA Solution Architect to design an automation">+ RPA</button>
      <button data-act="email" title="Email agent: read your Outlook inbox + draft a reply (never sends)">+ email</button>
      <button data-act="auto" title="Toggle the auto-dispatcher">auto: <b>on</b></button>
      <button data-act="reset" class="ghost" title="Clear the board">reset</button>
    `
    const ask = (label) => { const v = window.prompt(label); return v && v.trim() ? v.trim() : null }
    this.toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return
      const act = b.dataset.act
      if (act === 'spawn') { const name = ask('Name your new agent (blank = random):'); this.send(COMMAND.SPAWN, name ? { name } : { count: 1 }) }
      else if (act === 'specialist') {
        const skill = ask('Skill for the new specialist (rpa-architect or email):')
        if (skill) {
          const s = skill.trim().toLowerCase()
          const name = ask('Name this specialist (blank = auto):')
          this.send(COMMAND.SPAWN, { name: name || `Specialist · ${s}`, skills: [s] })
        }
      }
      else if (act === 'skill') {
        // Design a brand-new skill from the page: a name + the expertise (system
        // prompt). We define it, put a fresh specialist on it, and optionally
        // give that specialist a first task — no code required.
        const name = ask('Name the new skill (e.g. "SQL Expert", "Legal Reviewer"):'); if (!name) return
        const system = ask('Describe its expertise / instructions (this becomes the agent\'s system prompt):'); if (!system) return
        const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
        this.send(COMMAND.DEFINE_SKILL, { key, name: name.trim(), system })
        this.send(COMMAND.SPAWN, { name: name.trim(), skills: [key] })
        const brief = ask(`Give "${name.trim()}" a first task now (blank = skip):`)
        if (brief) this.send(COMMAND.CREATE_TASK, { kind: 'custom', skill: key, brief })
      }
      else if (act === 'task') { const title = ask('Task title (blank = random):'); this.send(COMMAND.CREATE_TASK, title ? { title } : {}) }
      else if (act === 'research') { const topic = ask('Topic to research on Wikipedia (blank = random):'); this.send(COMMAND.CREATE_TASK, topic ? { kind: 'research', topic } : { kind: 'research' }) }
      else if (act === 'factcheck') { const claim = ask('Claim to fact-check (blank = random):'); this.send(COMMAND.CREATE_TASK, claim ? { kind: 'factcheck', claim } : { kind: 'factcheck' }) }
      else if (act === 'rpa') { const brief = ask('Describe the business process to automate (blank = sample):'); this.send(COMMAND.CREATE_TASK, brief ? { kind: 'rpa-design', brief } : { kind: 'rpa-design' }) }
      else if (act === 'email') { this.send(COMMAND.CREATE_TASK, { kind: 'email' }) }
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
      <div class="skills" id="skills-panel"></div>
      <div class="dir__head">AGENTS <span id="dir-count">0</span></div>
      <ul class="dir__list" id="dir-list"></ul>
    `
    this.list = this.dir.querySelector('#dir-list')
    this.skillsPanel = this.dir.querySelector('#skills-panel')

    // Skills panel: one row per user-defined skill, each with a one-click "+ task"
    // that puts that skill's specialist on a new piece of work.
    this.skillsPanel.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-skill]')
      if (!b) return
      const key = b.dataset.skill
      const name = b.dataset.name || key
      const brief = window.prompt(`New task for "${name}":`)
      if (brief && brief.trim()) this.send(COMMAND.CREATE_TASK, { kind: 'custom', skill: key, brief: brief.trim() })
    })

    // Click handling. A button runs an action. ONLY the compact header toggles
    // selection — clicks inside the expanded detail (especially the dropdown)
    // must NOT toggle the row shut, or the dropdown would close the instant it
    // opens (the click bubbles up here).
    this.list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]')
      if (btn) { e.stopPropagation(); this._action(btn.dataset.act, btn.closest('[data-id]').dataset.id); return }
      const head = e.target.closest('.dir__row')
      if (head) this._select(head.closest('[data-id]').dataset.id)
    })
    // Dropdowns: assign a specific backlog task, or send the agent to a zone.
    this.list.addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-act]')
      if (!sel || !sel.value) return
      const id = sel.closest('[data-id]').dataset.id
      if (sel.dataset.act === 'move') this.send(COMMAND.MOVE, { agentId: id, zone: sel.value })
      else if (sel.dataset.act === 'assign') this.send(COMMAND.ASSIGN, { agentId: id, taskId: sel.value })
      sel.value = ''
    })

    this.root.append(this.toolbar, this.dir)
  }

  setTasks(tasks) { this._tasks = tasks || [] }

  // Render the defined custom skills (sent on the wire as [{key, name}]). Each
  // gets a one-click "+ task" button. No-op'd to a hint when there are none.
  setSkills(skills) {
    const list = skills || []
    // Cheap change-detection so we don't rebuild the rows (and their buttons)
    // every tick — only when the catalog actually changes.
    const sig = list.map((s) => `${s.key}:${s.name}`).join('|')
    if (sig === this._skillsSig) return
    this._skillsSig = sig
    if (!list.length) {
      this.skillsPanel.innerHTML = `<div class="skills__head">SKILLS</div>
        <div class="skills__empty">none yet — design one with <b>+ skill</b></div>`
      return
    }
    const rows = list.map((s) => `
      <div class="skill-row">
        <span class="skill-row__name">${esc(s.name)}</span>
        <button class="skill-row__add" data-skill="${esc(s.key)}" data-name="${esc(s.name)}" title="Give this skill a new task">+ task</button>
      </div>`).join('')
    this.skillsPanel.innerHTML = `<div class="skills__head">SKILLS <span>· ${list.length}</span></div>${rows}`
  }

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

  // Incremental render: create rows once, then UPDATE them in place each tick.
  // This keeps interactive elements (the dropdown) alive across refreshes.
  _render() {
    this.dir.querySelector('#dir-count').textContent = `· ${this._agents.length}`
    const seen = new Set()
    for (const a of this._agents) {
      seen.add(a.id)
      let li = this._rowEls.get(a.id)
      if (!li) { li = this._createRow(a); this.list.appendChild(li); this._rowEls.set(a.id, li) }
      this._updateRow(li, a)
    }
    for (const [id, li] of this._rowEls) {
      if (!seen.has(id)) { li.remove(); this._rowEls.delete(id) }
    }
  }

  _createRow(a) {
    const li = document.createElement('li')
    li.className = 'dir__item'
    li.dataset.id = a.id
    li.innerHTML = `<div class="dir__row">
        <span class="dir__dot"></span>
        <span class="dir__name"></span>
        <span class="dir__st"></span>
      </div>`
    return li
  }

  _updateRow(li, a) {
    const sel = a.id === this._selectedId
    const color = STATUS_COLOR[a.status] || STATUS_COLOR.idle
    li.classList.toggle('sel', sel)
    const dot = li.querySelector('.dir__dot')
    dot.style.background = color
    dot.style.boxShadow = `0 0 6px ${color}`
    // Mark specialists (agents with skills) with a star in the directory list.
    li.querySelector('.dir__name').textContent = (a.skills?.length ? '★ ' : '') + a.name
    const st = li.querySelector('.dir__st')
    st.textContent = a.status
    st.style.color = color

    let det = li.querySelector('.dir__detail')
    if (sel && !det) li.insertAdjacentHTML('beforeend', this._detailHtml(a))
    else if (!sel && det) det.remove()
    else if (sel && det) this._updateDetail(det, a) // update text, leave controls intact
  }

  // Options for the "assign a task…" dropdown: the current backlog.
  _backlogOptions() {
    const backlog = this._tasks.filter((t) => t.state === 'backlog')
    if (!backlog.length) return '<option value="" disabled>backlog empty</option>'
    return backlog.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('')
  }

  _detailHtml(a) {
    const paused = a.status === 'paused'
    const zones = ZONES.map((z) => `<option value="${z.key}">${z.label}</option>`).join('')
    return `<div class="dir__detail">
        <div class="dir__meta">${esc(a.model)} · ${esc(a.platform)}</div>
        <div class="dir__meta">${a.status} — ${esc(a.task || 'idle')}</div>
        <div class="dir__meta dir__skills">${this._skillsHtml(a)}</div>
        <div class="dir__meta">uptime ${fmtUptime(a.uptime)}</div>
        <div class="dir__acts">
          <button data-act="${paused ? 'resume' : 'pause'}">${paused ? '▶ resume' : '⏸ pause'}</button>
          <button data-act="rename">✎ rename</button>
          <button data-act="kill" class="danger">✕ remove</button>
        </div>
        <select data-act="assign" class="dir__move"><option value="">assign a task…</option>${this._backlogOptions()}</select>
        <select data-act="move" class="dir__move"><option value="">send to zone…</option>${zones}</select>
      </div>`
  }

  // Skills shown as small chips, or a hint to grant one.
  _skillsHtml(a) {
    const skills = a.skills || []
    if (!skills.length) return 'skills: <span style="opacity:.6">generalist</span>'
    return 'skills: ' + skills.map((s) => `<span class="skill-chip">${esc(s)}</span>`).join(' ')
  }

  _updateDetail(det, a) {
    const m = det.querySelectorAll('.dir__meta')
    m[0].textContent = `${a.model} · ${a.platform}`
    m[1].textContent = `${a.status} — ${a.task || 'idle'}`
    m[2].innerHTML = this._skillsHtml(a)
    m[3].textContent = `uptime ${fmtUptime(a.uptime)}`
    const pr = det.querySelector('button[data-act="pause"], button[data-act="resume"]')
    if (pr) {
      const paused = a.status === 'paused'
      pr.dataset.act = paused ? 'resume' : 'pause'
      pr.textContent = paused ? '▶ resume' : '⏸ pause'
    }
    // Keep the backlog options fresh — but not while the user has it open.
    const asel = det.querySelector('select[data-act="assign"]')
    if (asel && document.activeElement !== asel) {
      asel.innerHTML = `<option value="">assign a task…</option>` + this._backlogOptions()
    }
  }
}
