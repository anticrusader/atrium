// artifacts.js
// Real work should leave a real DELIVERABLE. Tasks that genuinely produce
// something (an RPA solution design, a research summary, a fact-check verdict)
// store it on `task.result` — but the task itself is ephemeral (done tasks get
// pruned from the board). So when such a task completes, we write its result to
// a Markdown file under server/outputs/ that you can open, keep, and share.
//
// This is the difference between "the agent narrated some work" and "the agent
// handed me a document." Only tasks with a non-empty `task.result` are saved.

import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'

const OUT_DIR = fileURLToPath(new URL('./outputs/', import.meta.url))

// Human title for each kind, used in the file header.
const KIND_TITLE = {
  'rpa-design': 'RPA / UiPath Solution Design',
  research: 'Research Summary',
  factcheck: 'Fact-Check (stage 1)',
  verify: 'Independent Verification (stage 2)',
  email: 'Email Draft',
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50)

/**
 * Write a completed task's result to a Markdown file. Returns a short relative
 * path (e.g. "server/outputs/t123-rpa-design-invoice.md") to show in the UI, or
 * null if there's nothing worth saving.
 */
export function saveArtifact(task, nowMs = Date.now()) {
  if (!task?.result || !String(task.result).trim()) return null
  mkdirSync(OUT_DIR, { recursive: true })

  const kind = task.kind || 'task'
  const subject = task.brief || task.topic || task.claim || task.title
  const file = `${task.id}-${slug(kind)}${subject ? '-' + slug(subject) : ''}.md`.slice(0, 90)
  const when = new Date(nowMs).toISOString()

  const lines = [
    `# ${KIND_TITLE[kind] || 'Task Result'}`,
    '',
    `- **Task:** ${task.title}`,
    `- **By:** ${task.doneBy || task.agentId || 'unknown'}`,
    `- **Completed:** ${when}`,
  ]
  if (task.brief) lines.push(`- **Process:** ${task.brief}`)
  if (task.topic) lines.push(`- **Topic:** ${task.topic}`)
  if (task.claim) lines.push(`- **Claim:** ${task.claim}`)
  if (task.finding) lines.push(`- **Stage-1 verdict it received:** ${task.finding}`)
  lines.push('', '---', '', String(task.result).trim(), '')

  writeFileSync(`${OUT_DIR}${file}`, lines.join('\n'), 'utf8')
  return `server/outputs/${file}`
}
