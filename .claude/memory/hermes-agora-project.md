---
name: hermes-agora-project
description: "What the Hermes Agora project is, its intent, and run modes"
metadata: 
  node_type: memory
  type: project
  originSessionId: d038332f-35c5-4dfe-b433-7670731d815a
---

**Hermes Agora** (dir: `OneDrive/Desktop/Cursor Repositories/hermesagora`) is an unofficial, self-hostable rebuild of hermesagora.com — a "living 3D office" that visualizes AI agents. The user extended it from a pure monitor into a small **agent orchestrator** specifically to **learn agent orchestration hands-on**.

Stack: Three.js + Vite dashboard (`src/`), Node + `ws` orchestrator backend (`server/`). Shared wire contract in `server/protocol.js` imported by both sides.

Two run modes: `npm run dev` (in-browser simulation, zero backend) and `npm run dev:all` (dashboard + real orchestrator; open `?feed=ws://127.0.0.1:8787`). Host CPU/MEM/DISK are real in orchestrator mode.

Persistence: the orchestrator world (fleet + task board + completed count) is saved to `server/state.json` (gitignored) every 5s and on exit, and restored on boot (`server/store.js`, `Orchestrator.seed()/toState()/hydrate()`, wired in `server/index.js`). So restarts no longer wipe custom/named agents. IMPORTANT lesson learned: server restarts used to lose in-memory agents (e.g. the user's "genesys") — before any future change that restarts the server, remember state now persists, but warn the user anyway.

Key seam: agents are state machines with a pluggable `executor.step()` — currently simulated. See [[next-step-real-executor]] for the agreed next step and [[free-hosted-models]] for model choices. Teaching docs live in `docs/ORCHESTRATION.md` and `docs/PROTOCOL.md`. Pushed to GitHub private repo under [[github-anticrusader]].
