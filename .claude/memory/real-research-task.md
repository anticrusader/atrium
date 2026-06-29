---
name: real-research-task
description: "Hermes Agora has one genuinely-real task kind (Wikipedia research), the template for real tool use"
metadata: 
  node_type: memory
  type: project
  originSessionId: d038332f-35c5-4dfe-b433-7670731d815a
---

[[hermes-agora-project]] now has a genuinely REAL task kind (not simulated narration): `kind:'research'`. Implemented in `server/research.js`, routed from `server/executor.js` `step()`. Flow: (1) SEARCH live Wikipedia API for `task.topic`, (2) READ the real article extract, (3) SUMMARIZE that real content with the model. Completion = a grounded summary actually produced (stored on `task.result`); the 📚 summary shows in the activity feed.

Created via the **`+ research`** toolbar button (`create_task {kind:'research'}`), seed (2 at boot), and trickle (~30%). Happens in the library zone. `Orchestrator._wireTasks()` strips `_`-prefixed fields (e.g. `_extract`) from the wire. Only the summarize phase spends a rate-limiter token (Wikipedia calls are free).

Bug fixed along the way: agent-runtime WORKING used to discard the final step's note behind a generic "finishing" label, so the 📚 summary never reached the feed — now it surfaces `note || task.title`.

Verified live on NVIDIA: "searched Wikipedia for 'black holes' → found 'Black hole'" → "read … 608 chars of real content" → "📚 A black hole is an extremely compact astronomical body…". This is the TEMPLATE for all real work: swap Wikipedia for any tool (web search, file read, API, test runner) and decide completion from real results. Offline MockGateway can't fetch — real research needs the backend (`?feed=ws://...`). See [[next-step-real-executor]].
