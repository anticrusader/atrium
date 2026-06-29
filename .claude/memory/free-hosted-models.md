---
name: free-hosted-models
description: Free hosted (non-local) LLM API options recommended for the Hermes Agora executor
metadata: 
  node_type: memory
  type: reference
  originSessionId: d038332f-35c5-4dfe-b433-7670731d815a
---

Free hosted (no-local) model providers recommended for wiring a real agent executor in [[hermes-agora-project]]. All are OpenAI-compatible, so the executor code is identical except base URL + model id. Free-tier model IDs rotate — verify current list at the provider before relying on a specific slug.

**OpenRouter** (preferred, on-theme) — `https://openrouter.ai/api/v1`, OpenAI-compatible, no credit card.
- Has a REAL free Hermes model: `nousresearch/hermes-3-llama-3.1-405b:free` (131K ctx) — BUT it is frequently **429 upstream** (shared free capacity), so don't rely on it alone.
- Verified working free model (2026-06-29): `google/gemma-4-26b-a4b-it:free` (~3.5s latency). `meta-llama/llama-3.3-70b-instruct:free` also exists (often 429).
- `:free` slugs ROTATE — many guessed ids 404. To get the current list, `GET {baseURL}/models` and filter `pricing.prompt==0 && pricing.completion==0`.
- Limits (2026): ~20 requests/min, ~200 requests/day on free.
- The executor handles this with a comma-separated fallback list that rotates on 429. See [[next-step-real-executor]].

**NVIDIA build** (CURRENTLY ACTIVE, recommended) — `https://integrate.api.nvidia.com/v1`, OpenAI-compatible, generous free tier (no constant 429 like OpenRouter). User has an `nvapi-...` key in `.env` (`NVIDIA_API_KEY`). 121 models in catalog; NO Hermes/Nous (so not on-theme). Verified-good for short agent steps: `meta/llama-3.3-70b-instruct` (primary, ~1.3s, clean), `nvidia/llama-3.3-nemotron-super-49b-v1`, `meta/llama-3.1-8b-instruct` (very fast). Avoid nemotron `-v1.5` (returns empty with small max_tokens — reasoning eats the budget). The executor's `buildExecutor` is provider-aware (`LLM_PROVIDER=nvidia`).

**Groq** (fastest, best for a busy loop) — `https://api.groq.com/openai/v1`, OpenAI-compatible, no credit card.
- `llama-3.1-8b-instant`: ~14,400 req/day (most permissive free model).
- `llama-3.3-70b-versatile`: ~30 RPM, ~1K req/day.

**Google Gemini** free tier (AI Studio) and **Cerebras** free tier are viable alternates.

Local fallback (different machine, RTX 3090 24GB): Ollama `hermes3:8b` at `http://localhost:11434/v1`. See [[next-step-real-executor]].
