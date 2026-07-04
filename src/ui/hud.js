// hud.js
// Builds and updates the DOM overlay: brand/status, host meters, agent counts,
// section chips, and a live activity feed. Pure DOM — no framework.

import { ZONES } from '../sim/gateway.js'

function el(tag, cls, html) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html != null) n.innerHTML = html
  return n
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Hex (not var()) so the fill can be composed into a gradient + glow inline.
function meterColor(pct) {
  if (pct < 55) return '#57e08a'
  if (pct < 80) return '#ffcf5c'
  return '#ff6b7a'
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

export class Hud {
  constructor(root) {
    this.root = root
    this.version = 'v0.1.0 · pre-release'
    this._feed = []
    this._agents = []        // latest roster (for task→agent name lookup)
    this._tasks = []         // latest task list
    this._openTaskId = null  // task whose detail panel is open
    this._build()
  }

  _build() {
    // --- Brand / status (top-left) ---
    this.brand = el('div', 'hud__panel brand')
    this.brand.innerHTML = `
      <div class="brand__mark">ATRIUM</div>
      <div class="brand__sub"><span class="dot"></span><span id="b-status">online · gateway running</span></div>
      <div class="brand__ver" id="b-ver">${this.version}</div>
    `

    // --- Host meters (top-right) ---
    this.host = el('div', 'hud__panel host')
    this.host.innerHTML = `
      <div class="host__title">host</div>
      ${this._meterHtml('cpu', 'CPU', 0)}
      ${this._meterHtml('mem', 'MEM', 0)}
      ${this._meterHtml('disk', 'DISK', 0)}
      ${this._meterHtml('net', 'NET', 0)}
      <div class="host__llm" id="m-llm" style="display:none"></div>
    `

    // --- Roster counts + section chips (bottom-left) ---
    this.roster = el('div', 'hud__panel roster')
    this.roster.innerHTML = `
      <div class="roster__big"><span id="r-total">0</span><small>total</small>
        <span class="roster__active" id="r-active">0</span><small>active</small></div>
      <div class="sections" id="r-sections"></div>
    `

    // --- Task board (right, above activity) ---
    this.board = el('div', 'hud__panel board')
    this.board.innerHTML = `
      <div class="focus__title">jira floor — task board</div>
      <div class="board__cols">
        <div class="board__col"><span id="bd-backlog">0</span><small>backlog</small></div>
        <div class="board__col"><span id="bd-progress" class="board__hot">0</span><small>in progress</small></div>
        <div class="board__col"><span id="bd-done" class="board__ok">0</span><small>done</small></div>
        <div class="board__col"><span id="bd-failed" class="board__bad">0</span><small>failed</small></div>
      </div>
      <ul class="board__list" id="bd-list"></ul>
    `

    // --- Activity feed (bottom-right) ---
    this.focus = el('div', 'hud__panel focus')
    this.focus.innerHTML = `
      <div class="focus__title">activity</div>
      <ul class="feed" id="f-feed"></ul>
    `

    // --- Hover tag ---
    this.tag = el('div', 'tag')

    // --- Task detail panel (opens when you click a task on the board) ---
    this.taskPanel = el('div', 'hud__panel taskpanel')
    this.taskPanel.style.display = 'none'

    // --- Hint ---
    this.hint = el('div', 'hint', 'drag to orbit · scroll to zoom · hover an agent · click a task')

    this.root.append(this.brand, this.host, this.roster, this.board, this.focus, this.taskPanel, this.tag, this.hint)

    // Section chips
    const secWrap = this.root.querySelector('#r-sections')
    this._chips = {}
    for (const z of ZONES) {
      const c = el('span', 'chip', `${z.label} <b>0</b>`)
      this._chips[z.key] = c
      secWrap.appendChild(c)
    }

    // Click a task row on the board → open its detail panel.
    this.board.addEventListener('click', (e) => {
      const row = e.target.closest('[data-taskid]')
      if (row) this.openTask(row.dataset.taskid)
    })
    this.taskPanel.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="closetask"]')) { this.closeTask(); return }
      const link = e.target.closest('[data-taskid]') // follow a handoff link
      if (link) this.openTask(link.dataset.taskid)
    })
  }

  openTask(id) { this._openTaskId = id; this._renderTaskPanel() }
  closeTask() { this._openTaskId = null; this.taskPanel.style.display = 'none' }

  _nameOf(agentId) { return agentId ? (this._agents.find((a) => a.id === agentId)?.name || '—') : null }

  _renderTaskPanel() {
    const t = this._tasks.find((x) => x.id === this._openTaskId)
    if (!t) { this.taskPanel.style.display = 'none'; return }
    const who = this._nameOf(t.agentId) || t.doneBy || '—'
    const pct = Math.round((t.progress || 0) * 100)
    const parent = t.parent ? this._tasks.find((x) => x.id === t.parent) : null
    const children = this._tasks.filter((x) => x.parent === t.id)
    const roleLabel = t.state === 'done' ? 'completed by' : t.agentId ? 'working on it' : 'unassigned'

    const out = []
    out.push(`<div class="tp__meta">state: <b style="color:var(--ink)">${t.state}</b> · ${pct}%</div>`)
    out.push(`<div class="tp__meta">${roleLabel}: <b style="color:var(--ink)">${esc(who)}</b></div>`)
    if (t.topic) out.push(`<div class="tp__meta">topic: ${esc(t.topic)}</div>`)
    if (t.claim) out.push(`<div class="tp__meta">claim: ${esc(t.claim)}</div>`)
    if (parent) out.push(`<div class="tp__meta">↳ handed off from <span class="tp__link" data-taskid="${parent.id}">${esc(parent.title)}</span></div>`)
    if (t.finding) out.push(`<div class="tp__block"><div class="tp__lbl">verdict it received</div>${esc(t.finding)}</div>`)
    if (t.result) out.push(`<div class="tp__block"><div class="tp__lbl">result</div>${esc(t.result)}</div>`)
    if (t.artifact) out.push(`<div class="tp__meta">📄 saved to <b style="color:var(--ink)">${esc(t.artifact)}</b></div>`)

    // Per-task activity timeline: who did what, in order.
    if (Array.isArray(t.log) && t.log.length) {
      out.push('<div class="tp__lbl">activity</div><ul class="tp__log">')
      for (const e of t.log) out.push(`<li><b>${esc(e.who)}</b> ${esc(e.verb)} ${e.what ? esc(e.what) : ''}</li>`)
      out.push('</ul>')
    }

    // Handoffs: which agent it was handed to, and what they did (click to follow).
    if (children.length) {
      out.push('<div class="tp__lbl">handed off to</div>')
      for (const c of children) {
        const cwho = c.doneBy || this._nameOf(c.agentId) || 'waiting for an agent'
        out.push(`<div class="tp__child">
          <span class="tp__link" data-taskid="${c.id}">${esc(c.title)}</span>
          <div class="tp__meta">→ ${esc(cwho)} · ${c.state}</div>
          ${c.result ? `<div class="tp__cres">${esc(c.result)}</div>` : ''}
        </div>`)
      }
    }

    this.taskPanel.innerHTML = `
      <div class="tp__head">
        <span class="tp__kind">${t.kind || 'task'}</span>
        <button class="tp__x" data-act="closetask" title="close">✕</button>
      </div>
      <div class="tp__title">${esc(t.title)}</div>
      ${out.join('')}
    `
    this.taskPanel.style.display = 'block'
  }

  _meterHtml(id, label, pct) {
    return `
      <div class="meter">
        <div class="meter__row"><span>${label}</span><b id="m-${id}-v">${pct}%</b></div>
        <div class="meter__track"><div class="meter__fill" id="m-${id}-f" style="width:${pct}%"></div></div>
      </div>`
  }

  setVersion(v) {
    this.version = v
    const e = this.root.querySelector('#b-ver')
    if (e) e.textContent = v
  }

  // Reflect whether we're connected to the real orchestrator or the local sim.
  setMode(kind) {
    const e = this.root.querySelector('#b-status')
    if (!e) return
    e.textContent = kind === 'orchestrator'
      ? 'online · orchestrator connected'
      : 'online · local simulation'
  }

  updateBoard(tasks, completed) {
    if (!tasks) return
    this._tasks = tasks
    const by = { backlog: 0, assigned: 0, in_progress: 0, done: 0, failed: 0 }
    for (const t of tasks) by[t.state] = (by[t.state] || 0) + 1
    // Counts now match the list exactly: backlog = queued only; an assigned task
    // (an agent walking to it) counts as in-progress, not backlog.
    this.root.querySelector('#bd-backlog').textContent = by.backlog
    this.root.querySelector('#bd-progress').textContent = by.in_progress + by.assigned
    this.root.querySelector('#bd-done').textContent = completed ?? by.done
    this.root.querySelector('#bd-failed').textContent = by.failed

    // Rows are clickable → task detail. Show the FULL backlog (the list scrolls),
    // then active tasks with bars, then a few recent done.
    const list = this.root.querySelector('#bd-list')
    const rows = []
    for (const t of tasks.filter((t) => t.state === 'backlog')) {
      rows.push(`<li class="bd-row" data-taskid="${t.id}"><span class="bd-title">${esc(t.title)}</span><span class="bd-badge">queued</span></li>`)
    }
    for (const t of tasks.filter((t) => t.state === 'assigned' || t.state === 'in_progress').slice(0, 5)) {
      rows.push(`<li class="bd-row" data-taskid="${t.id}"><span class="bd-title">${esc(t.title)}</span><span class="bd-track"><span class="bd-fill" style="width:${Math.round((t.progress || 0) * 100)}%"></span></span></li>`)
    }
    for (const t of tasks.filter((t) => t.state === 'failed').slice(-2).reverse()) {
      rows.push(`<li class="bd-row" data-taskid="${t.id}"><span class="bd-title">${esc(t.title)}</span><span class="bd-badge bd-fail">failed</span></li>`)
    }
    for (const t of tasks.filter((t) => t.state === 'done').slice(-3).reverse()) {
      rows.push(`<li class="bd-row" data-taskid="${t.id}"><span class="bd-title">${esc(t.title)}</span><span class="bd-badge bd-done">done</span></li>`)
    }
    list.innerHTML = rows.join('') || '<li class="bd-empty">board empty</li>'

    if (this._openTaskId) this._renderTaskPanel() // keep an open detail panel live
  }

  _setMeter(id, pct) {
    const v = this.root.querySelector(`#m-${id}-v`)
    const f = this.root.querySelector(`#m-${id}-f`)
    if (v) v.textContent = `${pct}%`
    if (f) {
      const c = meterColor(pct)
      f.style.width = `${pct}%`
      // Gradient fill with a soft glow at the leading edge — reads as "energy".
      f.style.background = `linear-gradient(90deg, ${c}55, ${c})`
      f.style.boxShadow = `0 0 10px ${c}55`
    }
  }

  update({ agents, host, active, llm }) {
    this._agents = agents
    // Counts
    this.root.querySelector('#r-total').textContent = agents.length
    this.root.querySelector('#r-active').textContent = active

    // Host meters
    this._setMeter('cpu', host.cpu)
    this._setMeter('mem', host.mem)
    this._setMeter('disk', host.disk)
    this._setMeter('net', host.net)

    // Live LLM telemetry: the ACTIVE model (post-rotation) + shared-limiter
    // counters. Only present on a live backend; hidden in the local sim.
    const llmEl = this.root.querySelector('#m-llm')
    if (llmEl) {
      if (llm) {
        llmEl.style.display = 'block'
        llmEl.textContent = `⚡ ${llm.model} · ${llm.calls} calls · ${llm.throttled} throttled` +
          (llm.errors ? ` · ${llm.errors} errors` : '')
      } else {
        llmEl.style.display = 'none'
      }
    }

    // Per-zone occupancy
    const counts = {}
    for (const a of agents) counts[a.zone] = (counts[a.zone] || 0) + 1
    for (const [key, chip] of Object.entries(this._chips)) {
      const n = counts[key] || 0
      chip.querySelector('b').textContent = n
      chip.style.opacity = n ? '1' : '0.55'
    }
  }

  pushEvents(events) {
    if (!events || !events.length) return
    const verbMap = {
      thinking: 'is thinking —', messaging: 'is messaging —', working: 'is working —',
      'moved to': 'moved to', went: 'went',
    }
    for (const ev of events) {
      const verb = verbMap[ev.verb] || ev.verb
      this._feed.unshift(`<span class="who">${ev.who}</span><span><span class="verb">${verb}</span> ${ev.what}</span>`)
    }
    this._feed = this._feed.slice(0, 7)
    const ul = this.root.querySelector('#f-feed')
    ul.innerHTML = this._feed.map((s) => `<li>${s}</li>`).join('')
  }

  // Show/hide the agent tooltip near the cursor.
  showTag(record, screen) {
    if (!record) { this.tag.style.display = 'none'; return }
    this.tag.style.display = 'block'
    this.tag.style.left = `${screen.x}px`
    this.tag.style.top = `${screen.y}px`
    this.tag.innerHTML = `
      <div><b>${record.name}</b></div>
      <div style="color:var(--ink-dim);margin-top:3px">
        ${record.model} · ${record.platform}<br/>
        ${record.status} · ${record.task}<br/>
        uptime ${fmtUptime(record.uptime)}
      </div>`
  }
}
