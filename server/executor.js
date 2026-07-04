// executor.js
// The "real work" plug-in for agents. An executor implements one method:
//
//   step(agent, task) -> { delta, note }   (may be async)
//
// `delta` advances task.progress (0..1); `note` is a short human line for the
// activity feed. This file provides an LLM executor that calls any
// OpenAI-compatible chat API (OpenRouter, Groq, local Ollama, …).
//
// Because the WHOLE fleet shares one executor, it also owns a shared RATE
// LIMITER and a concurrency cap so dozens of agents can't exceed the provider's
// free-tier limits. Agents that can't get a token this tick simply make no
// progress and try again — you can watch the fleet bottleneck on the limit,
// which is exactly how real orchestration behaves under a constrained resource.
//
// Task kinds: a normal task is "narrated" by the model (simulated work); a
// `research` task does GENUINELY REAL work via researchStep (Wikipedia + model).

import { researchStep, factCheckStep, verifyStep } from './research.js'
import { rpaDesignStep } from './rpa.js'
import { emailStep } from './email.js'
import { customStep } from './custom-skill.js'

const now = () => Date.now()

// Token-bucket limiter: refills `rpm` tokens per minute, capacity `rpm`.
class RateLimiter {
  constructor(rpm) {
    this.capacity = rpm
    this.tokens = rpm
    this.refillPerMs = rpm / 60000
    this.last = now()
    this.cooldownUntil = 0
  }
  _refill() {
    const t = now()
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs)
    this.last = t
  }
  take() {
    if (now() < this.cooldownUntil) return false
    this._refill()
    if (this.tokens >= 1) { this.tokens -= 1; return true }
    return false
  }
  backoff(ms) { this.cooldownUntil = now() + ms }
}

/**
 * Build an LLM executor.
 * @param {object} cfg
 * @param {string} cfg.apiKey
 * @param {string} cfg.baseURL    OpenAI-compatible base, e.g. https://openrouter.ai/api/v1
 * @param {string} cfg.model      e.g. nousresearch/hermes-3-llama-3.1-405b:free
 * @param {number} [cfg.rpm]      requests/min budget shared by the whole fleet
 * @param {number} [cfg.maxInFlight] concurrent HTTP calls cap
 * @param {number} [cfg.maxSteps] force task completion after this many steps
 */
export function makeLLMExecutor(cfg) {
  const { apiKey, baseURL, rpm = 15, maxInFlight = 4, maxSteps = 3 } = cfg
  // `model` may be a single id or a comma-separated fallback list. Free models
  // get upstream-rate-limited individually, so we rotate to the next on failure.
  const models = (Array.isArray(cfg.model) ? cfg.model : String(cfg.model).split(','))
    .map((s) => s.trim()).filter(Boolean)
  let mi = 0
  const activeModel = () => models[mi % models.length]
  const rotate = () => { if (models.length > 1) mi = (mi + 1) % models.length }

  const limiter = new RateLimiter(rpm)
  let inFlight = 0
  const stats = { calls: 0, errors: 0, rateLimited: 0 }

  // One raw model call. Shared by the narration step AND the research step.
  // Handles model rotation on 429/5xx. Returns { ok, text, status }.
  //
  // The fetch carries a HARD 30s TIMEOUT (AbortSignal). Without it, a stalled
  // provider connection (e.g. NVIDIA 504-ing under load) hangs the call until
  // the agent-level watchdog dead-letters the task ~50s later — and the hung
  // promise never runs `finally`, permanently leaking an inFlight slot. With
  // it, a stall becomes a fast recoverable "model busy" and we rotate models.
  async function chat(messages, maxTokens = 80) {
    inFlight++
    try {
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'http://localhost', // OpenRouter likes these; harmless elsewhere
          'X-Title': 'Hermes Agora',
        },
        body: JSON.stringify({ model: activeModel(), max_tokens: maxTokens, temperature: 0.7, messages }),
      })
      if (res.status === 429) { rotate(); limiter.backoff(3000); stats.rateLimited++; return { ok: false, status: 429 } }
      if (!res.ok) {
        stats.errors++
        const body = await res.text().catch(() => '')
        console.warn(`[executor] ${res.status} on ${activeModel()}: ${body.slice(0, 140)}`)
        rotate()
        return { ok: false, status: res.status }
      }
      stats.calls++
      const data = await res.json()
      return { ok: true, text: (data?.choices?.[0]?.message?.content || '').trim() }
    } catch (err) {
      stats.errors++
      // Timed out / network dropped: treat like a 5xx — this model (or the
      // provider) is struggling, so rotate to the next and let the caller retry.
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        console.warn(`[executor] 30s timeout on ${activeModel()} — rotating`)
        rotate()
        limiter.backoff(2000)
        return { ok: false, status: 0, error: 'timed out after 30s' }
      }
      return { ok: false, status: 0, error: err.message }
    } finally {
      inFlight--
    }
  }

  // Simulated-but-model-narrated step (the default task kind).
  async function narrationStep(agent, task) {
    task.scratch ??= []
    if (task.scratch.length >= maxSteps) return { delta: 1, note: `wrapped up: ${task.title}` }
    if (inFlight >= maxInFlight || !limiter.take()) { stats.rateLimited++; return { delta: 0, note: '⏳ waiting for model slot' } }
    const r = await chat([
      {
        role: 'system',
        content:
          `You are ${agent.name}, an AI agent working in a virtual office. Do ONE small next ` +
          `step on your task. Reply with a single short sentence (max 15 words) describing ` +
          `what you just did. If the task is now fully complete, end with the token DONE.`,
      },
      {
        role: 'user',
        content:
          `Task: "${task.title}".\nSteps so far:\n` +
          (task.scratch.length ? task.scratch.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(none yet)') +
          `\nYour next step:`,
      },
    ], 80)
    if (!r.ok) {
      if (r.status === 429) return { delta: 0, note: `⏳ busy → trying ${activeModel().split('/').pop()}` }
      return { delta: 0.34, note: `model error ${r.status || 'unreachable'}` }
    }
    let text = r.text || '(no output)'
    const done = /\bDONE\b/.test(text)
    text = text.replace(/\bDONE\b/gi, '').replace(/\s+/g, ' ').trim()
    if (text) task.scratch.push(text)
    return { delta: done ? 1 : 0.26, note: text || 'thinking…' }
  }

  // Dispatch by task kind: research/factcheck/verify do REAL tool work; the
  // rest are narrated by the model (simulated).
  async function step(agent, task) {
    if (task.kind === 'research') return researchStep({ task, chat, limiter })
    if (task.kind === 'factcheck') return factCheckStep({ task, chat, limiter })
    if (task.kind === 'verify') return verifyStep({ task, chat, limiter })
    if (task.kind === 'rpa-design') return rpaDesignStep({ task, chat, limiter })
    if (task.kind === 'email') return emailStep({ task, chat, limiter })
    if (task.kind === 'custom') return customStep({ task, chat, limiter })
    return narrationStep(agent, task)
  }

  return { step, chat, info: { models, baseURL, rpm }, current: activeModel, stats }
}
