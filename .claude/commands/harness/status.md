---
description: Show what the agentic harness is doing and what is in the backlog
---
Run `node .harness/status.mjs --log 15` and `node .harness/backlog.mjs overview`. Then summarise in plain words, in at most 8 lines: is the controller running, what it is working on, what is READY / DONE / BLOCKED, anything that needs my decision (BLOCKED items, failed jobs in `.harness/failed/`, a paused autonomous mode), and the one next step you recommend.
