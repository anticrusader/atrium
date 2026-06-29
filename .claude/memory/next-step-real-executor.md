---
name: next-step-real-executor
description: The agreed next build step for Hermes Agora — wire one agent to a real model executor
metadata: 
  node_type: memory
  type: project
  originSessionId: d038332f-35c5-4dfe-b433-7670731d815a
---

Next step for [[hermes-agora-project]]: make ONE agent call a real model so the user can watch a genuine plan→act→observe loop in the 3D view. The seam is already built — replace `simulatedExecutor.step()` in `server/agent-runtime.js` with a real `step()` (a worked `llmExecutor` example is in `docs/ORCHESTRATION.md §7`). Nothing else in the state machine / scheduler / transport / dashboard changes.

**Model choice (decided priority):**
1. **Free hosted model first** — see [[free-hosted-models]]. Preferred: OpenRouter `nousresearch/hermes-3-llama-3.1-405b:free` (real Hermes, on-theme) or Groq `llama-3.1-8b-instant` (fast, high daily limit) for a busy agent loop.
2. **If a suitable free model is NOT available/usable, fall back to LOCAL models on the user's OTHER system, which has an RTX 3090 (24GB VRAM).** On that box use Ollama (OpenAI-compatible at `http://localhost:11434/v1`) with `hermes3:8b` — fits 24GB comfortably. (70B won't fit well at decent quant on a single 3090; 8B is the sweet spot.)

**Why:** user is using this project to learn agent orchestration hands-on, and wants to see a real reasoning loop, not just simulation.
**How to apply:** when wiring it, keep `step()` doing one small unit per call, add a concurrency cap in `Orchestrator._dispatch()` so it doesn't fire many parallel paid/rate-limited calls, and start with a single agent so every step is readable.
