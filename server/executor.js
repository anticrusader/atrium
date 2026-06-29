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

  async function step(agent, task) {
    task.scratch ??= []

    // Force a clean finish after enough real steps so tasks don't run forever.
    if (task.scratch.length >= maxSteps) {
      return { delta: 1, note: `wrapped up: ${task.title}` }
    }

    // Gate on the shared budget. No token → no progress this tick (try again).
    if (inFlight >= maxInFlight || !limiter.take()) {
      stats.rateLimited++
      return { delta: 0, note: '⏳ waiting for model slot' }
    }

    inFlight++
    try {
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          // OpenRouter likes these; harmless elsewhere.
          'HTTP-Referer': 'http://localhost',
          'X-Title': 'Hermes Agora',
        },
        body: JSON.stringify({
          model: activeModel(),
          max_tokens: 80,
          temperature: 0.7,
          messages: [
            {
              role: 'system',
              content:
                `You are ${agent.name}, an AI agent working in a virtual office. ` +
                `Do ONE small next step on your task. Reply with a single short ` +
                `sentence (max 15 words) describing what you just did. If the task ` +
                `is now fully complete, end your reply with the token DONE.`,
            },
            {
              role: 'user',
              content:
                `Task: "${task.title}".\nSteps so far:\n` +
                (task.scratch.length
                  ? task.scratch.map((s, i) => `${i + 1}. ${s}`).join('\n')
                  : '(none yet)') +
                `\nYour next step:`,
            },
          ],
        }),
      })

      if (res.status === 429) {
        // This model is upstream-limited — rotate to the next fallback model
        // and apply a short global cooldown so we don't spin.
        const was = activeModel()
        rotate()
        limiter.backoff(3000)
        stats.rateLimited++
        return { delta: 0, note: `⏳ ${was.split('/').pop()} busy → trying ${activeModel().split('/').pop()}` }
      }
      if (!res.ok) {
        stats.errors++
        const body = await res.text().catch(() => '')
        console.warn(`[executor] ${res.status} on ${activeModel()}: ${body.slice(0, 140)}`)
        rotate() // 404/5xx → try a different model next time too
        return { delta: 0.34, note: `model error ${res.status}` }
      }

      stats.calls++
      const data = await res.json()
      let text = data?.choices?.[0]?.message?.content?.trim() || '(no output)'
      const done = /\bDONE\b/.test(text)
      text = text.replace(/\bDONE\b/gi, '').replace(/\s+/g, ' ').trim()
      if (text) task.scratch.push(text)
      return { delta: done ? 1 : 0.26, note: text || 'thinking…' }
    } catch (err) {
      stats.errors++
      return { delta: 0.34, note: `model unreachable: ${err.message || 'error'}` }
    } finally {
      inFlight--
    }
  }

  return { step, info: { models, baseURL, rpm }, current: activeModel, stats }
}
