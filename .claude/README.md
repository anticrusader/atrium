# Portable Claude context

This folder travels with the repo so Claude Code has the project history on any
machine you clone to.

- **`../CLAUDE.md`** — auto-loaded by Claude Code in this project. This is the
  primary mechanism; you don't have to do anything to use it.
- **`memory/`** — a snapshot of Claude's per-project "memory" notes (intent,
  decisions, the agreed next step, model choices, etc.).

## Restoring memory on a new machine (optional)

Claude Code stores live memory per-project under a global path that is derived
from the project's absolute path on that machine, e.g.:

```
~/.claude/projects/<encoded-project-path>/
  MEMORY.md
  memory/*.md
```

To seed a fresh machine with this repo's saved memory, copy the files in
`memory/` (including `MEMORY.md`) into that global location for this project.
`CLAUDE.md` already covers the essentials, so this step is optional — it mainly
restores the granular memory index.

> Note: this is a point-in-time snapshot. If memory changes during work, re-copy
> the updated files here and commit them so the snapshot stays current.
