---
name: next-step-real-executor
description: "Status of the real-model executor for Hermes Agora (DONE) and what's next"
metadata: 
  node_type: memory
  type: project
  originSessionId: d038332f-35c5-4dfe-b433-7670731d815a
---

DONE (2026-06-29): the WHOLE fleet in [[hermes-agora-project]] now runs on a real model. Implemented `server/executor.js` (`makeLLMExecutor`): OpenAI-compatible call, shared token-bucket rate limiter (`LLM_RPM`, default 15/min for the whole fleet), comma-separated model **fallback list** that rotates on 429/5xx, concurrency cap, forced completion after N steps. Made `server/agent-runtime.js` async-aware (fires one model call in WORKING, applies result on a later tick, never blocks the loop; working memory in `task.scratch`). `server/index.js` loads `.env` via `process.loadEnvFile()` and auto-selects the LLM executor when `OPENROUTER_API_KEY` is set, else simulated.

Verified: live model output flows into the activity feed (real reasoning sentences), HUD shows model + `(live)`. See [[free-hosted-models]] for the 429 reality (on-theme Hermes-405B is often upstream-limited → rotates to gemma/llama).

**Run live:** key in `.env` → `npm run dev:all` → open `?feed=ws://127.0.0.1:8787`.
**Local fallback** (user's RTX 3090 24GB): Ollama `hermes3:8b`, set `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL=hermes3:8b`, `OPENROUTER_API_KEY=ollama`.

Next ideas (not done): agent-to-agent handoff (completed agent creates a follow-up task — MESSAGING state is the hook); priority/skill scheduling in `Orchestrator._dispatch()`; surface the post-rotation *active* model in the HUD (executor exposes `current()`).
