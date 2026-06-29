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

async function wikiSearch(topic) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(topic)}&srlimit=1&format=json`
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
