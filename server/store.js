// store.js
// Tiny JSON persistence so the orchestrator's world (fleet + task board)
// survives a server restart. Best-effort: any error is swallowed — losing the
// save is never worse than crashing the server.

import { readFileSync, writeFileSync, renameSync } from 'node:fs'

export function loadState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null // no file / unreadable / corrupt → caller seeds fresh
  }
}

// Write to a temp file then rename over the target, so a crash mid-write can't
// leave a half-written (corrupt) state file.
export function saveState(file, data) {
  try {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, file)
  } catch {
    /* best-effort */
  }
}
