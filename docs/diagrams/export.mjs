// export.mjs — regenerate the diagram PNGs from docs/DIAGRAMS.md.
//
//   npm run diagrams
//
// Extracts every ```mermaid block from DIAGRAMS.md (order matters) and renders
// each to docs/diagrams/<NN-name>.png using mermaid-cli via `npx` (downloaded on
// demand the first time — needs network then; cached afterwards). Nothing is
// added to the project's dependencies, so a normal `npm install` stays light.
//
// If you ADD or REMOVE a diagram, update NAMES below to match the new order.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url)) // docs/diagrams
const docsMd = join(here, '..', 'DIAGRAMS.md')

// One name per Mermaid block, in document order → docs/diagrams/<name>.png
const NAMES = [
  '01-system-architecture', '02-orchestration-loop', '03-agent-state-machine',
  '04-commands-and-events', '05-what-is-a-skill', '06-skill-dispatch',
  '07-rpa-architect-flow', '08-custom-skill-flow', '09-handoff-factcheck-verify',
  '10-deliverables',
]

const md = readFileSync(docsMd, 'utf8')
const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1].trimEnd())

if (blocks.length !== NAMES.length) {
  console.error(`✗ DIAGRAMS.md has ${blocks.length} mermaid blocks but NAMES lists ${NAMES.length}.`)
  console.error('  Update the NAMES array in docs/diagrams/export.mjs to match (in order).')
  process.exit(1)
}

const win = process.platform === 'win32'
const npx = win ? 'npx.cmd' : 'npx'
// With shell:true (needed to run npx.cmd on Windows) args aren't auto-quoted, so
// quote any that contain spaces — the repo path may include them.
const q = (a) => (win && /\s/.test(a) ? `"${a}"` : a)

const tmp = mkdtempSync(join(tmpdir(), 'atrium-diagrams-'))
const pptr = join(tmp, 'puppeteer.json')
writeFileSync(pptr, JSON.stringify({ args: ['--no-sandbox', '--disable-setuid-sandbox'] }))

console.log(`Rendering ${blocks.length} diagrams → docs/diagrams/ …`)
let ok = 0
for (let i = 0; i < blocks.length; i++) {
  const name = NAMES[i]
  const mmd = join(tmp, `${name}.mmd`)
  const out = join(here, `${name}.png`)
  writeFileSync(mmd, `${blocks[i]}\n`)
  const args = ['-y', '@mermaid-js/mermaid-cli', '-i', mmd, '-o', out, '-p', pptr, '-b', 'white', '-t', 'default', '-s', '2']
  const r = spawnSync(npx, args.map(q), { stdio: ['ignore', 'ignore', 'inherit'], shell: win })
  if (r.status === 0) { ok++; console.log(`  ✓ ${name}.png`) } else console.error(`  ✗ ${name} (exit ${r.status})`)
}
rmSync(tmp, { recursive: true, force: true })

console.log(`\n${ok}/${blocks.length} rendered.`)
process.exit(ok === blocks.length ? 0 : 1)
