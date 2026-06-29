---
name: real-research-task
description: Hermes Agora real task kinds — Wikipedia research + a 2-stage multi-agent fact-check pipeline
metadata: 
  node_type: memory
  type: project
  originSessionId: d038332f-35c5-4dfe-b433-7670731d815a
---

[[hermes-agora-project]] has REAL task kinds (not simulated narration), in `server/research.js`, routed from `server/executor.js` `step()`:

**`research`** — SEARCH live Wikipedia → READ extract → SUMMARIZE with the model. Completion = a grounded 📚 summary (task.result). Library zone. `+ research` button / seed (2) / trickle (~25%).

**`factcheck` + `verify` (real 2-stage multi-agent pipeline)** — Agent A researches a CLAIM vs Wikipedia → verdict `⚖️ SUPPORTED/CONTRADICTED/UNCLEAR` (jira floor). On completion, `_maybeHandoff` ALWAYS creates a stage-2 `verify` task carrying claim+verdict, with `_exclude = doer` so a DIFFERENT agent takes it. Agent B pulls an INDEPENDENT second source (DuckDuckGo Instant Answer, Wikipedia fallback — retrieved by SUBJECT/topic, NOT the full claim sentence which returns garbage) → `✅ CONFIRM` / `❌ DISPUTE` (conference hall). `+ fact-check` button / seed (1) / trickle (~15%). Claims in `CLAIMS` (orchestrator).

Key orchestrator changes: `_dispatch` ranks backlog (stage-2 verify > real research/factcheck > sim) so real work is promptly visible under the shared rate limit, and honors `_exclude`. Per-tick event window widened to `events.slice(-16)` (was -6) so verdicts aren't dropped when many agents emit at once. `_wireTasks()` strips `_`-prefixed fields. Also fixed: agent-runtime WORKING now surfaces the final step's note (so 📚/⚖️/✅ aren't hidden behind a generic 'finishing' label).

Verified live on NVIDIA: Zephyr Dune ⚖️ CONTRADICTED → handoff → Nico Dune ✅ CONFIRM (different agents). Caveat: stage 1 reads only the short Wikipedia summary extract, so a TRUE claim can read CONTRADICTED if the summary omits it — honest ("source doesn't support this"), not a bug. This is the TEMPLATE for real tool use + multi-agent collaboration. Offline MockGateway only labels these (no network). See [[next-step-real-executor]], [[free-hosted-models]].
