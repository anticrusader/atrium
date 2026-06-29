// research.js
// A GENUINELY REAL task step. Unlike the simulated narration, a research task
// does actual work:
//   1. SEARCH  — query the real Wikipedia API for the topic (a real tool call)
//   2. READ    — fetch the real article extract (real external content)
//   3. SUMMARIZE — ask the model to summarize the REAL extract (grounded output)
//
// "Done" here means the agent actually produced a summary grounded in fetched
// content — not a progress counter. The phases are tracked on the task object
// and advance one per tick (each tick = one real network/model call), reusing
// the same async, non-blocking WORKING loop as every other task.

const UA = { 'User-Agent': 'HermesAgora/0.1 (educational orchestration demo)' }

// Turn a natural-language question into a good search term, so a typed topic
// like "what is loop engineering?" searches "loop engineering" (and lands on
// the right article) instead of matching something unrelated.
export function cleanQuery(s) {
  const cleaned = String(s || '')
    .replace(/^\s*(what|who|when|where|why|how|which)\s+(is|are|was|were|did|does|do)\s+/i, '')
    .replace(/^\s*(what's|whats|who's|define|explain|tell me about|describe)\s+/i, '')
    .replace(/\?+\s*$/, '')
    .trim()
  return cleaned || String(s || '')
}

async function wikiSearch(topic) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(cleanQuery(topic))}&srlimit=1&format=json`
  const res = await fetch(url, { headers: UA })
  if (!res.ok) return null
  const data = await res.json()
  return data?.query?.search?.[0]?.title ?? null
}

async function wikiSummary(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
  const res = await fetch(url, { headers: UA })
  if (!res.ok) return null
  const data = await res.json()
  return data?.extract ?? null
}

// A SECOND, independent retrieval path for verification — DuckDuckGo's Instant
// Answer API, with a Wikipedia fallback. Retrieves by the SUBJECT (topic), not
// the full claim sentence (which returns garbage matches). DDG is a separate
// endpoint/aggregator from stage 1's Wikipedia REST read.
async function secondSource(claim, topic) {
  const subject = topic || claim
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(subject)}&format=json&no_html=1&skip_disambig=1`
    const res = await fetch(url, { headers: UA })
    if (res.ok) {
      const j = await res.json()
      if (j.AbstractText) return { text: j.AbstractText.slice(0, 1200), src: `DuckDuckGo${j.AbstractSource ? '/' + j.AbstractSource : ''}` }
    }
  } catch { /* fall through to Wikipedia */ }
  // Fallback: a Wikipedia read of the subject (relevant even if same family).
  const title = await wikiSearch(subject)
  if (title) {
    const ex = await wikiSummary(title)
    if (ex) return { text: ex.slice(0, 1200), src: `Wikipedia: ${title}` }
  }
  return null
}

/**
 * One real research step. Mutates `task` to track phase and store the result.
 * @param {object} ctx
 * @param {object} ctx.task   the research task ({ topic, ... })
 * @param {(messages:any[], maxTokens:number)=>Promise<{ok,text,status}>} ctx.chat
 * @param {{take:()=>boolean}} ctx.limiter  shared model rate limiter
 * @returns {Promise<{delta:number, note:string}>}
 */
export async function researchStep({ task, chat, limiter }) {
  try {
    // Phase 1: SEARCH
    if (!task.phase) {
      const title = await wikiSearch(task.topic)
      if (!title) { task.phase = 'done'; return { delta: 1, note: `no encyclopedia results for "${task.topic}"` } }
      task._title = title
      task.phase = 'read'
      return { delta: 0.3, note: `searched Wikipedia for "${task.topic}" → found "${title}"` }
    }

    // Phase 2: READ
    if (task.phase === 'read') {
      const extract = await wikiSummary(task._title)
      task._extract = (extract || '').slice(0, 1500)
      task.phase = 'summarize'
      if (!task._extract) return { delta: 0.3, note: `"${task._title}" had no readable extract` }
      return { delta: 0.3, note: `read "${task._title}" — ${task._extract.length} chars of real content` }
    }

    // Phase 3: SUMMARIZE (the only phase that calls the model → gate the limiter)
    if (task.phase === 'summarize') {
      if (!limiter.take()) return { delta: 0, note: '⏳ waiting for a model slot' }
      const r = await chat([
        { role: 'system', content: 'You summarize encyclopedia text accurately in ONE concise sentence. Use ONLY the provided text; do not add outside facts.' },
        { role: 'user', content: `Topic: ${task.topic}\nEncyclopedia extract:\n"""${task._extract || '(none)'}"""\n\nIn one sentence, what is it?` },
      ], 110)
      if (!r.ok) return { delta: 0, note: `⏳ model busy (${r.status || 'error'}) — retrying` }
      const summary = (r.text || '').replace(/\s+/g, ' ').replace(/\bDONE\b/gi, '').trim()
      task.result = summary           // the real artifact this task produced
      task.phase = 'done'
      return { delta: 1, note: `📚 ${summary || '(no summary produced)'}` }
    }

    return { delta: 1, note: 'done' }
  } catch (err) {
    task.phase = 'done'
    return { delta: 1, note: `research error: ${err.message}` }
  }
}

// ── Fact-check, STAGE 1 ──────────────────────────────────────────────────────
// Agent A: research a claim against a PRIMARY source (Wikipedia) and reach a
// preliminary verdict. The verdict (task.result) is what gets HANDED OFF to a
// second agent for independent verification (stage 2 below).
export async function factCheckStep({ task, chat, limiter }) {
  try {
    if (!task.phase) {
      const title = await wikiSearch(task.topic)
      if (!title) { task.phase = 'done'; return { delta: 1, note: `no source found for "${task.topic}"` } }
      task._title = title
      task.phase = 'read'
      return { delta: 0.3, note: `looking into the claim — found source "${title}"` }
    }
    if (task.phase === 'read') {
      const extract = await wikiSummary(task._title)
      task._extract = (extract || '').slice(0, 1500)
      task.phase = 'assess'
      return { delta: 0.3, note: `read "${task._title}" — ${task._extract.length} chars` }
    }
    if (task.phase === 'assess') {
      if (!limiter.take()) return { delta: 0, note: '⏳ waiting for a model slot' }
      const r = await chat([
        { role: 'system', content: 'You are a fact-checker. Using ONLY the source text, judge the claim. Start your reply with exactly one word — SUPPORTED, CONTRADICTED, or UNCLEAR — then a brief reason. Be concise.' },
        { role: 'user', content: `Claim: "${task.claim}"\nSource (${task._title}):\n"""${task._extract || '(none)'}"""\n\nVerdict:` },
      ], 120)
      if (!r.ok) return { delta: 0, note: `⏳ model busy (${r.status || 'error'})` }
      const verdict = (r.text || '').replace(/\s+/g, ' ').trim()
      task.result = verdict
      task.phase = 'done'
      return { delta: 1, note: `⚖️ ${verdict || '(no verdict)'}` }
    }
    return { delta: 1, note: 'done' }
  } catch (err) {
    task.phase = 'done'
    return { delta: 1, note: `fact-check error: ${err.message}` }
  }
}

// ── Fact-check, STAGE 2 (the handoff) ────────────────────────────────────────
// Agent B: receives A's claim + preliminary verdict, pulls an INDEPENDENT second
// source, and confirms or disputes A's conclusion. This is real multi-agent
// collaboration on real data — B never saw A's source, only A's verdict.
export async function verifyStep({ task, chat, limiter }) {
  try {
    if (!task.phase) {
      const second = await secondSource(task.claim, task.topic)
      task._src2 = second?.text || ''
      task._src2name = second?.src || 'no second source'
      task.phase = 'judge'
      return { delta: 0.4, note: `pulled an independent second source (${task._src2name})` }
    }
    if (task.phase === 'judge') {
      if (!limiter.take()) return { delta: 0, note: '⏳ waiting for a model slot' }
      const r = await chat([
        { role: 'system', content: 'You independently verify a colleague\'s fact-check. Compare their verdict against the SECOND source provided. Start your reply with exactly one word — CONFIRM or DISPUTE — then a brief reason. Use only the second source.' },
        { role: 'user', content: `Claim: "${task.claim}"\nColleague's verdict: ${task.finding || '(none)'}\nSecond source (${task._src2name}):\n"""${task._src2 || '(no text retrieved)'}"""\n\nYour judgment:` },
      ], 120)
      if (!r.ok) return { delta: 0, note: `⏳ model busy (${r.status || 'error'})` }
      const text = (r.text || '').replace(/\s+/g, ' ').trim()
      const emoji = /\bDISPUTE/i.test(text) ? '❌' : /\bCONFIRM/i.test(text) ? '✅' : '⚖️'
      task.result = text
      task.phase = 'done'
      return { delta: 1, note: `${emoji} ${text || '(no judgment)'}` }
    }
    return { delta: 1, note: 'done' }
  } catch (err) {
    task.phase = 'done'
    return { delta: 1, note: `verify error: ${err.message}` }
  }
}
