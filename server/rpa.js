// rpa.js
// The RPA / UiPath SOLUTION ARCHITECT skill.
//
// This is a "skill" in its purest form: a specialized agent capability backed by
// a domain-expert system prompt. There is no external tool or credential here —
// the value is the EXPERTISE encoded in the prompt. The agent who owns the
// `rpa-architect` skill (see SKILL_FOR_KIND in protocol.js) is the only one the
// dispatcher will hand a `rpa-design` task to.
//
// A design runs in two real model calls over two ticks (so progress is visible):
//   1. ANALYZE — decompose the business process: steps, systems, inputs, the
//                rule-based vs judgement split, data volumes, exception points.
//   2. DESIGN  — produce the UiPath solution architecture grounded in #1.
// The finished architecture is stored on `task.result` and surfaced in the feed.

// The persona. Kept here (not inline) so it reads like a real role description
// and is easy to tune. This is the whole "knowledge" of the skill.
const ARCHITECT_SYSTEM =
  'You are a senior RPA Solution Architect with deep UiPath expertise. You design ' +
  'production automations and you think like an architect, not a coder. You know: ' +
  'the UiPath platform (Studio, Studio X, Orchestrator, Assistant, Action Center, ' +
  'Apps, Data Service, Document Understanding, AI Center, Integration Service, Test ' +
  'Suite); the REFramework (Init/GetTransactionData/Process/End, queues with ' +
  'transaction items, retries, business vs system exceptions); attended vs ' +
  'unattended vs API/serverless triggers; Orchestrator assets, queues, credentials ' +
  '(prefer credential stores / Azure Key Vault — never hardcode), triggers, robots; ' +
  'selector strategy (strict vs fuzzy, anchors, dynamic selectors, UI vs API-first); ' +
  'modern UiAutomation activities; exception handling, logging, transactional ' +
  'recovery and idempotency; SDLC, source control, and CoE governance. You weigh ' +
  'automation feasibility honestly (rules-based + stable + high-volume = good fit; ' +
  'high judgement / constantly-changing UI = poor fit, recommend API or Document ' +
  'Understanding/AI where it genuinely helps). Be concrete and pragmatic. Never ' +
  'invent UiPath features that do not exist.'

/**
 * One step of an RPA solution design. Mutates `task` to track phase + store
 * the result. Same async contract as researchStep.
 * @param {object} ctx
 * @param {object} ctx.task    the rpa-design task ({ brief, ... })
 * @param {(messages:any[], maxTokens:number)=>Promise<{ok,text,status}>} ctx.chat
 * @param {{take:()=>boolean}} ctx.limiter  shared model rate limiter
 */
export async function rpaDesignStep({ task, chat, limiter }) {
  const brief = task.brief || task.title.replace(/^RPA design:\s*/i, '')
  try {
    // Phase 1: ANALYZE the process.
    if (!task.phase) {
      if (!limiter.take()) return { delta: 0, note: '⏳ waiting for a model slot' }
      const r = await chat([
        { role: 'system', content: ARCHITECT_SYSTEM },
        {
          role: 'user',
          content:
            `Process to automate: "${brief}".\n\n` +
            'Break it down for an RPA assessment. List, tersely: the main steps; the ' +
            'applications/systems touched; inputs & outputs; which parts are rule-based ' +
            'vs need human judgement; likely exception points; and rough volume/frequency ' +
            'if implied. Bullet points only, no preamble.',
        },
      ], 320)
      if (!r.ok) return { delta: 0, note: `⏳ model busy (${r.status || 'error'}) — retrying` }
      task._analysis = (r.text || '').trim()
      task.phase = 'design'
      const first = task._analysis.split('\n').find((l) => l.trim()) || 'analyzed the process'
      return { delta: 0.45, note: `🧩 decomposed the process — ${first.replace(/^[-*•]\s*/, '').slice(0, 80)}…` }
    }

    // Phase 2: DESIGN the UiPath solution, grounded in the analysis.
    if (task.phase === 'design') {
      if (!limiter.take()) return { delta: 0, note: '⏳ waiting for a model slot' }
      const r = await chat([
        { role: 'system', content: ARCHITECT_SYSTEM },
        {
          role: 'user',
          content:
            `Process: "${brief}".\nProcess analysis:\n${task._analysis || '(none)'}\n\n` +
            'Now give the UiPath solution architecture. Cover, with short headers:\n' +
            '1) Feasibility & fit (good/partial/poor + one-line why)\n' +
            '2) Recommended approach (attended/unattended/API; REFramework or simple; ' +
            'Document Understanding/AI only if it genuinely helps)\n' +
            '3) Key UiPath components (Studio projects, Orchestrator queues/assets/' +
            'credentials, triggers, robots)\n' +
            '4) Selector / integration strategy (UI vs API-first)\n' +
            '5) Exception handling & recovery\n' +
            '6) Risks and a rough effort estimate (S/M/L).\n' +
            'Be concise and concrete.',
        },
      ], 700)
      if (!r.ok) return { delta: 0, note: `⏳ model busy (${r.status || 'error'}) — retrying` }
      const design = (r.text || '').replace(/\bDONE\b/gi, '').trim()
      task.result = design          // the real artifact: the solution architecture
      task.phase = 'done'
      // Surface the feasibility line (usually the first content line) in the feed.
      const head = design.split('\n').map((l) => l.trim()).find(Boolean) || 'solution designed'
      return { delta: 1, note: `🏗️ ${head.replace(/^#+\s*/, '').slice(0, 90)}` }
    }

    return { delta: 1, note: 'done' }
  } catch (err) {
    task.phase = 'done'
    return { delta: 1, note: `rpa-design error: ${err.message}` }
  }
}
