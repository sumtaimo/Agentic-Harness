---
description: Run one autonomous controller step now (promote the next READY backlog item, or let the PO plan one)
---
Do ONE autonomous step of the harness, strictly inside `.harness/charter.md`.

1. Read `.harness/charter.md` section 0. If it says `autonomous: off`, tell me that autonomous mode is off, show me the objectives that would need to be filled in, and ask whether I want to turn it on. **Do not change the charter yourself.** Stop here.
2. Otherwise run `node .harness/daemon.mjs --status` and `node .harness/backlog.mjs overview` and tell me in one line what is READY.
3. Run `node .harness/daemon.mjs --tick` with the Bash tool and a `timeout` of 600000 (the step can take minutes because it runs the agents). If a controller is already running, the tick only queues the work for it; then follow the live feed with the Monitor tool: `node .harness/watch.mjs` (`timeout_ms` 900000).
4. Report in plain words: what ran, whether it was committed, which branch it landed on (autonomous work goes to `uat`, never `main`), and anything that needs my decision. Show `git log --oneline uat` if it moved. Never merge, push or reset `main`.
