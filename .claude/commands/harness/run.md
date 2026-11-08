---
description: Run a task through the agentic harness and show the agents working live in this chat
argument-hint: <what you want done, in plain words>
---
Run this through the agentic harness, so I can watch the agents work live in this chat.

**Goal from the user:** $ARGUMENTS

If the goal above is empty, ask me what I want done, in one simple question, and stop.

Otherwise follow these steps in order. Explain each step in one plain sentence (I may not be a programmer).

1. **Controller.** Run `node .harness/daemon.mjs --status`. If it says the daemon is NOT running (or there is no state yet), start it in the background with the Bash tool using `run_in_background: true` and the command `node .harness/daemon.mjs`. Live agent output is on by default. Wait 3 seconds, then run `--status` again to confirm it is running.
2. **Plan the job.** Decide which files the work should touch (`--files`) and what command proves it worked (`--check`, for example `npm test`). If the project has no real check, say so and propose one before going on. For a big goal made of independent parts, add `--auto-plan` so the AI planner splits it into parallel workers. Put exact names, signatures and formats that workers share into the goal text.
3. **Dispatch** (do not use `--wait`): `node .harness/dispatch.mjs --goal "<goal>" --files "<files>" --check "<check>"`. Note the `JOB_ID=...` and `LIVE_FROM=...` lines it prints.
4. **Watch live.** Immediately start the Monitor tool with `node .harness/watch.mjs --job <JOB_ID> --from <LIVE_FROM>`, `timeout_ms` 900000, and the description "harness agents working on <short title>". Every line is something an agent is doing right now (file writes, commands, messages, denied actions, the check result). Tell me in one short sentence what is happening when something interesting arrives. Do not poll and do not sleep.
5. **Result.** When the monitor prints `RESULT:`, read the session note it refers to (newest file in `.harness/memory/sessions/`) and explain the outcome in plain words: what changed, how it was checked, what is still unknown.
   - If NOT DONE: explain the last error (`.harness/failed/<id>-*.trace.txt`), and ask me what to do. Do not retry silently.
   - Autonomous and `uat` work is merged into the `uat` branch only. Show `git log --oneline uat` and let me decide about `main`. Never merge, push or reset `main` yourself.
