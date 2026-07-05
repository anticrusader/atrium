// index.js — the orchestrator's network edge.
// A WebSocket server that:
//   • on connect, sends a full SNAPSHOT
//   • every tick, broadcasts a TICK to all clients
//   • receives COMMANDS from any client, applies them, returns an ACK
//
// Run:  npm run server   (defaults to ws://127.0.0.1:8787)
// Then open the dashboard with  ?feed=ws://127.0.0.1:8787
//
// This is the seam where a real fleet would attach: instead of (or in addition
// to) the simulated Orchestrator, you could bridge inbound agent telemetry from
// Hermes processes here and forward commands to them.

import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { Orchestrator } from './orchestrator.js'
import { Metrics } from './metrics.js'
import { makeLLMExecutor } from './executor.js'
import { loadState, saveState } from './store.js'
import { EVENT, event, isCommand } from './protocol.js'

// Load .env (Node 20.6+: no dependency needed). Safe if the file is absent.
try { process.loadEnvFile() } catch { /* no .env — that's fine */ }

const PORT = Number(process.env.PORT ?? 4787) // moved off 8787 to avoid collisions (embedded in Memex)
const HOST = process.env.HOST ?? '127.0.0.1'
const TICK_MS = Number(process.env.TICK_MS ?? 1100)

// Choose the executor: a real LLM if a key is configured, else the simulation.
// The WHOLE fleet shares this one executor (and its rate limiter).
function buildExecutor() {
  // Provider-aware: pick the right key + default base URL for LLM_PROVIDER.
  // All these providers are OpenAI-compatible, so only the key/URL/model differ.
  const provider = (process.env.LLM_PROVIDER || 'openrouter').toLowerCase()
  const keyByProvider = {
    nvidia: process.env.NVIDIA_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    groq: process.env.GROQ_API_KEY,
  }
  const baseByProvider = {
    nvidia: 'https://integrate.api.nvidia.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    groq: 'https://api.groq.com/openai/v1',
    ollama: 'http://localhost:11434/v1',
  }
  const key = process.env.LLM_API_KEY || keyByProvider[provider] || process.env.OPENROUTER_API_KEY
  const baseURL = process.env.LLM_BASE_URL || baseByProvider[provider] || baseByProvider.openrouter
  const model = process.env.LLM_MODEL || 'meta/llama-3.3-70b-instruct'
  const rpm = Number(process.env.LLM_RPM ?? 15)
  if (!key) {
    console.log(`  [executor] no API key for provider "${provider}" → simulated work (check .env)`)
    return { executor: null, label: 'simulation' }
  }
  const ex = makeLLMExecutor({ apiKey: key, baseURL, model, rpm })
  console.log(`  [executor] LIVE (${provider}) — ${ex.info.models.length} model(s), ${rpm} req/min shared across the fleet`)
  ex.info.models.forEach((m, i) => console.log(`     ${i === 0 ? '▶' : ' '} ${m}`))
  // Label shows the primary model; the executor rotates to fallbacks on 429.
  return { executor: ex, label: ex.info.models[0].split('/').pop() }
}

const { executor, label } = buildExecutor()
const orchestrator = new Orchestrator({
  executor: executor ?? undefined,
  maxConcurrent: Number(process.env.MAX_CONCURRENT ?? 6),
})
if (executor) orchestrator.version = `v0.1.0 · ${label} (live)`

// Persistence: restore the saved world if present, else seed a fresh fleet.
// The fleet + task board survive restarts (state in server/state.json).
const STATE_FILE = fileURLToPath(new URL('./state.json', import.meta.url))
const saved = loadState(STATE_FILE)
if (saved && Array.isArray(saved.agents) && saved.agents.length) {
  orchestrator.hydrate(saved)
  console.log(`  [state] restored ${saved.agents.length} agents + ${(saved.tasks || []).length} tasks from state.json`)
} else {
  orchestrator.seed(Number(process.env.FLEET ?? 5))
  console.log('  [state] no saved world → seeded a fresh fleet')
}

const metrics = new Metrics()

const wss = new WebSocketServer({ host: HOST, port: PORT })

function broadcast(frame) {
  const data = JSON.stringify(frame)
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data)
  }
}

wss.on('listening', () => {
  const i = metrics.info()
  console.log(`\n  ATRIUM  orchestrator`)
  console.log(`  ws://${HOST}:${PORT}   (${i.cores} cores · ${i.platform} · ${i.totalMemGb}GB)`)
  console.log(`  open the dashboard with:  ?feed=ws://${HOST}:${PORT}\n`)
})

wss.on('connection', (ws) => {
  // Hand the new client the current world.
  ws.send(JSON.stringify(event(EVENT.SNAPSHOT, orchestrator.snapshot(metrics.sample(Date.now())))))

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (!isCommand(msg)) return
    const ok = orchestrator.apply(msg.type, msg.payload || {})
    ws.send(JSON.stringify(event(EVENT.ACK, { id: msg.id, ok })))
  })
})

// The heartbeat: advance the world and publish it.
let nowMs = Date.now()
setInterval(() => {
  nowMs += TICK_MS
  const sample = metrics.sample(nowMs)
  const payload = orchestrator.tick(sample)
  broadcast(event(EVENT.TICK, payload))
}, TICK_MS)

// Autosave the world so it survives restarts.
setInterval(() => saveState(STATE_FILE, orchestrator.toState()), 5000)

function shutdown() {
  saveState(STATE_FILE, orchestrator.toState()) // flush before exiting
  console.log('\n  state saved · orchestrator stopped')
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
