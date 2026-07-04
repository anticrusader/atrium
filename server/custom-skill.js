// custom-skill.js
// Runs a USER-AUTHORED prompt-skill — a skill defined from the dashboard with
// just a name + a system prompt (the "expertise"), no code. This is what makes
// skills designable on the page: the orchestrator stores the prompt, attaches it
// to the task as `_system`, and this step runs the model with it.
//
// It's the generalization of server/rpa.js: the RPA architect is a hard-coded
// version of exactly this. Anything that's "an expert with instructions" — a
// SQL reviewer, a legal-clause checker, a brand copywriter — works here with no
// new code, just a prompt the user typed.

const FALLBACK_SYSTEM =
  'You are a knowledgeable specialist. Complete the task thoroughly and concisely, ' +
  'using clear structure (short headers or bullet points) where it helps.'

/**
 * One step of a custom prompt-skill. Single model call grounded in the user's
 * authored system prompt; stores the output on task.result. Same async contract
 * as researchStep / rpaDesignStep.
 * @param {object} ctx
 * @param {object} ctx.task    a `custom` task ({ _system, brief, ... })
 * @param {(messages:any[], maxTokens:number)=>Promise<{ok,text,status}>} ctx.chat
 * @param {{take:()=>boolean}} ctx.limiter
 */
export async function customStep({ task, chat, limiter }) {
  try {
    if (task.phase === 'done') return { delta: 1, note: 'done' }
    if (!limiter.take()) return { delta: 0, note: '⏳ waiting for a model slot' }

    const system = (task._system && task._system.trim()) || FALLBACK_SYSTEM
    const brief = task.brief || task.title

    const r = await chat([
      { role: 'system', content: system },
      { role: 'user', content: `Task: ${brief}\n\nProduce your expert output now.` },
    ], 700)
    if (!r.ok) return { delta: 0, note: `⏳ model busy (${r.status || 'error'}) — retrying` }

    const out = (r.text || '').replace(/\bDONE\b/gi, '').trim()
    task.result = out
    task.phase = 'done'
    const head = out.split('\n').map((l) => l.trim()).find(Boolean) || 'produced output'
    return { delta: 1, note: `✨ ${head.replace(/^#+\s*/, '').slice(0, 90)}` }
  } catch (err) {
    // Hard failure → the orchestrator retries once, then marks the task FAILED.
    return { failed: true, note: `custom skill failed: ${err.message}` }
  }
}
