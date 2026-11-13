---
description: Run a task through the agentic harness; you are the orchestrator, the named agents work visibly in this session, and you report back
argument-hint: <what you want done, in plain words>
---
Run this task through the agentic harness. The workflow is fixed: **human → controller → you (the orchestrator) → named agents → controller verify → report to the human.**

**Goal from the user:** $ARGUMENTS

If the goal is empty, ask me what I want done, in one simple question, and stop.

You are the **orchestrator**: you only plan and delegate; the agents do the work. The **controller** (`node .harness/visible.mjs`) holds the rules and enforces them; do not try to bypass it. Explain each step to me in one plain sentence (I may not be a programmer).

1. **Brief.** Run `node .harness/visible.mjs brief --goal "<goal>"` (add `--files "<paths the work may touch>"` if I named some, and `--check "<command>"` if I named a check). Read the whole brief: the task, the check, the team and each lead's scope, the rules I taught. Note the `RUN_ID=`. If the brief warns there is **no real check**, tell me and propose one before going on.
2. **Delegate.** Decide which lead gets which files. Give each file to exactly one lead, inside that lead's scope, and put every exact name, signature and format the agents share into `interfaceContract`. Skip leads with nothing to do. Write the delegation JSON and run `node .harness/visible.mjs assign <RUN_ID> '<json>'`. If it says REJECTED, fix it (3 attempts, then it escalates to me). Nothing starts before it says DELEGATION OK. Tip: pass the JSON as one single-quoted argument, written in plain words without apostrophes; if that is awkward, save it with the Write tool outside the project and use `assign <RUN_ID> --file <path>`.
3. **Work (visible).** `assign` prints one ready-made prompt per agent. Start **all** assigned agents in **one message** with the Agent tool, in parallel: `subagent_type` = the lead's id (for example `lead-dev`), `description` = the line `assign` printed, `prompt` = exactly the prompt it printed. I watch them work in the session. Do not do their work yourself and do not edit project files yourself. Do not poll or sleep while they work: you are told when each one finishes, so just wait for their reports.
4. **Verify.** When all agents have reported, run `node .harness/visible.mjs verify <RUN_ID> --reports '{"lead-dev":"<their one-line report>", …}'`. The controller compares every changed file with the assignments (anything outside is reverted), runs the real check, and prints the report. If it says NOT PASSED YET, send the failure to the responsible lead(s) with the Agent tool (give them the exact failure text), then run `verify` again (3 cycles at most; after that it stops, restores the files, and asks me).
5. **Report back to me**, in plain words, from the controller's report: what each named agent did, whether the check passed, what changed, and anything that needs my decision. Never say something passed unless the controller said PASSED. Never commit, push or merge for me.

Rules for you: never edit `.harness/` or `.claude/` files, never widen a scope, never raise a limit, and never start an agent the controller did not accept in step 2. For a task you want to run in the background without this session (terminal, unattended), the headless mode is `node .harness/dispatch.mjs --goal "…" --hierarchy --max-cost <usd>` (see the README).
