---
description: Bug hunt — QA looks for real bugs with evidence, I keep the ones to fix, then autopilot fixes each Red-Green
argument-hint: (optional) an area to hunt, e.g. checkout --files src/cart/
---
Hunt for real bugs, then fix only the ones I keep.

1. Run `node .harness/hunt.mjs new "$ARGUMENTS" --no-run` (add `--files <folder>` if I named one) and note the hunt id (`H1`, …).
2. Run `node .harness/hunt.mjs prompt <id>`. Start the `lead-qa` agent with that prompt and these rules: **write no file**; it may read everything and run the project's tests; every finding needs evidence (file:line, what it ran, expected vs actual); reply with the JSON only. Save its JSON reply to `.agent-state/hunt-<id>.json` (you write it, not the agent).
3. Run `node .harness/hunt.mjs run <id> --from .agent-state/hunt-<id>.json`. On `HUNT_FAILED`, send the error back to `lead-qa` once; a second failure: tell me why and stop.
4. Show me the findings in plain words, most severe first: ✅ confirmed (a command really failed) or 🟡 suspect (found by reading only), where, and what goes wrong. Say how many the harness dropped and why. Point me to the report (`docs/bugs/…`). Then **stop and ask me which bugs to fix.** Do not choose for me.
5. After my answer, run `node .harness/hunt.mjs approve <id> --keep <my numbers>` (or `--all`). Tell me any `!` warning.
6. Ask whether to fix now. If yes, run `/harness:auto`: each bug is fixed Red-Green (QA writes a failing test, DEV fixes the root cause, the controller checks), on the `uat` branch.

Never approve findings or run `backlog.mjs approve` for me. Never commit, push or merge.
