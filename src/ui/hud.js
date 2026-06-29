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

function meterColor(pct) {
  if (pct < 55) return 'var(--green)'
  if (pct < 80) return 'var(--amber)'
  return 'var(--red)'
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
    this._build()
  }

  _build() {
    // --- Brand / status (top-left) ---
    this.brand = el('div', 'hud__panel brand')
    this.brand.innerHTML = `
      <div class="brand__mark">HERMES <span>//</span> AGORA</div>
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

    // --- Hint ---
    this.hint = el('div', 'hint', 'drag to orbit · scroll to zoom · hover an agent')

    this.root.append(this.brand, this.host, this.roster, this.board, this.focus, this.tag, this.hint)

    // Section chips
    const secWrap = this.root.querySelector('#r-sections')
    this._chips = {}
    for (const z of ZONES) {
      const c = el('span', 'chip', `${z.label} <b>0</b>`)
      this._chips[z.key] = c
      secWrap.appendChild(c)
    }
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

  updateBoard(tasks) {
    if (!tasks) return
    const by = { backlog: 0, assigned: 0, in_progress: 0, done: 0, failed: 0 }
    for (const t of tasks) by[t.state] = (by[t.state] || 0) + 1
    this.root.querySelector('#bd-backlog').textContent = by.backlog + by.assigned
    this.root.querySelector('#bd-progress').textContent = by.in_progress
    this.root.querySelector('#bd-done').textContent = by.done

    // Show the BACKLOG (queued, assignable) first, then in-progress with bars.
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const list = this.root.querySelector('#bd-list')
    const rows = []
    for (const t of tasks.filter((t) => t.state === 'backlog').slice(0, 5)) {
      rows.push(`<li><span class="bd-title">${esc(t.title)}</span><span class="bd-badge">queued</span></li>`)
    }
    for (const t of tasks.filter((t) => t.state === 'in_progress').slice(0, 4)) {
      rows.push(`<li><span class="bd-title">${esc(t.title)}</span><span class="bd-track"><span class="bd-fill" style="width:${Math.round(t.progress * 100)}%"></span></span></li>`)
    }
    list.innerHTML = rows.join('') || '<li class="bd-empty">board empty</li>'
  }

  _setMeter(id, pct) {
    const v = this.root.querySelector(`#m-${id}-v`)
    const f = this.root.querySelector(`#m-${id}-f`)
    if (v) v.textContent = `${pct}%`
    if (f) {
      f.style.width = `${pct}%`
      f.style.background = meterColor(pct)
    }
  }

  update({ agents, host, active }) {
    // Counts
    this.root.querySelector('#r-total').textContent = agents.length
    this.root.querySelector('#r-active').textContent = active

    // Host meters
    this._setMeter('cpu', host.cpu)
    this._setMeter('mem', host.mem)
    this._setMeter('disk', host.disk)
    this._setMeter('net', host.net)

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
