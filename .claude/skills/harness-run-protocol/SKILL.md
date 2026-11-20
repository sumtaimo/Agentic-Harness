---
name: harness-run-protocol
description: Use when running a task through the harness controller from Claude Code as the orchestrator (/harness:run, /harness:auto), or when a controller run is FAILED, stuck or needs a rollback.
---
# Running a task through the controller

You only plan and delegate. Never edit project files, `.harness/` or `.claude/` yourself during a run.

## The flow
1. `node .harness/visible.mjs brief` (or `brief --next --auto-session <id>` for the next READY backlog item). It prints the task, the check, the team and each lead's scope.
2. Write the delegation as JSON and validate it: `node .harness/visible.mjs assign <run> '<json>'`. Every file goes to exactly one lead, inside that lead's scope and inside the files the human allowed. Put exact names and formats in `interfaceContract`.
3. Start ALL assigned agents in ONE message with the Agent tool (`subagent_type` = the lead's id). Use the prompts `assign` prints; do not shorten the rules sections.
4. When they report, run `node .harness/visible.mjs verify <run> --reports '{"lead-x":"one line"}'`. The controller reverts every change outside the assignments and runs the real check.
5. Report in plain words. Say PASSED only if the controller said PASSED. Subagent reports are claims, not proof.

## When a run fails
- Read the failing test messages first. Decide whether your change caused them or the environment did (open run state under `.harness/visible/`, a non-empty backlog and the owner's settings can leak into tests that copy `.harness/`).
- A FAILED run cannot be re-assigned, and `verify` reverts files outside the original assignment. To widen the scope: back up the work (copy files into the scratchpad), `node .harness/visible.mjs rollback <run>`, get the owner's approval to widen the backlog item's `targetFiles`, then `node .harness/backlog.mjs ready <id>` and start a fresh run.
- A fix to a file outside the charter (for example `install.mjs`, or anything under `.harness/`) is made by hand, with the owner's approval, BEFORE the new run starts, so the controller treats it as part of the starting point.
- Agents may run only `npm test` and `node --test`. If one needs a file copied, give it the exact content to write instead.
- 3 failed cycles end in `HALTED_HITL_REQUIRED`: files are restored and a human decides.
- A task the controller holds as "Needs your OK" waits for the owner: `node .harness/backlog.mjs approve <id>`. Do not approve it yourself.

## Rules that always apply
- Obey `.harness/charter.md` (allowed and forbidden paths, `autonomous` on/off) and the owner's rules. If autonomy is off, do not start autonomous runs until the owner says so.
- An AI CLI that is installed and logged in is used only after the owner allowed it on this machine (`node .harness/engines.mjs allow <tool>`).
- Autonomous work lands on the `uat` branch, never the owner's working branch. Do not merge or push it yourself.
- Do not commit or push unless the owner asks, and run the remote checks in `harness-phased-workflow` before any push.
