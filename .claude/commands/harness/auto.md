---
description: Autonomous mode — work through the READY backlog by yourself as the orchestrator, with visible agents, then report to the human
argument-hint: (optional) how many tasks at most
---
Run the harness in **autonomous mode**, as the orchestrator, strictly inside `.harness/charter.md`. The workflow per task is the same as `/harness:run`: **controller brief → you delegate → named agents work visibly → controller verify → report.**

1. Read `.harness/charter.md` section 0. If it says `autonomous: off`, tell me autonomous mode is off and stop. **Never change the charter yourself.**
2. Pick a session id like `A-<yyyymmddhhmm>`. Run `node .harness/visible.mjs brief --next --auto-session <sid>` (add `--check "<cmd>"` only if I gave one). Read the exit result:
   - **exit 0:** you have a brief for the highest-priority READY task. Do steps 2–5 of `/harness:run` for it (delegate with `assign`, start all assigned agents in one message, `verify`).
   - **exit 6 (nothing READY):** if the charter objectives are filled in, act as the product owner: propose at most the remaining budget of small, independently verifiable tasks as JSON and run `node .harness/visible.mjs propose <sid> '{"tasks":[{"title","goal","priority","files":["src/x.js"],"acceptanceCriteria":["…"],"interfaceContract":"…"}]}'`, then `brief --next --auto-session <sid>` again. If the objectives are still the placeholder (exit 5) or the backlog is empty, tell me and stop. Do not invent work.
   - **exit 3 (budget used):** stop and report.
   - **exit 4 (paused) or 2 (escalated):** stop and report exactly why; a human must decide.
3. After each task passes (the controller said PASSED), go back to step 2 for the next READY task, until the budget (`maxAutoTasksPerRun`, or the number I gave) is used, nothing is READY, or anything fails. **Any failure stops autonomy**: do not start the next task.
4. At the end, report to me in plain words: each task (title, which named agents worked on it, passed or not), the files changed, anything blocked, and the one next step you recommend. Never commit, push or merge for me.

$ARGUMENTS
