---
name: github-anticrusader
description: "User's GitHub account and the Hermes Agora private repo"
metadata: 
  node_type: memory
  type: user
  originSessionId: d038332f-35c5-4dfe-b433-7670731d815a
---

The user's GitHub account is **anticrusader** (authenticated via `gh` CLI, HTTPS). [[hermes-agora-project]] is pushed there as a **private** repo. The repo intentionally includes a `CLAUDE.md` and a checked-in `.claude/` folder (portable memory copy) so that pulling the project on a different system gives Claude Code the project history/context. To restore memory on a new machine, copy the repo's `.claude/memory/*` into the global memory path for that machine's project, or rely on the auto-loaded `CLAUDE.md`.
