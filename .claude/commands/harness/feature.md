---
description: Big feature from a short goal — BA grows it into the whole user workflow, I keep the steps I want, then autopilot builds them
argument-hint: a short goal, e.g. login
---
Grow my short goal into a whole feature, the way a business analyst would, then build only the steps I keep.

1. Run `node .harness/feature.mjs new "$ARGUMENTS" --no-expand` and note the feature id (`F1`, …).
2. Run `node .harness/feature.mjs prompt <id>`. Start the `lead-ba` agent with that prompt and these rules: **read only, write no file**; read the project first; reply with the JSON only. Save its JSON reply to `.agent-state/feature-<id>.json` (you write it, not the agent).
3. Run `node .harness/feature.mjs expand <id> --from .agent-state/feature-<id>.json`. If it prints `FEATURE_EXPAND_FAILED`, send the error back to `lead-ba` once and try again; a second failure: tell me why and stop.
4. Show me the numbered steps in plain words: what the user does at each step, its size, which steps come first, and every 🟡 decision as a question. Point me to the spec page it wrote (`docs/features/…`). Then **stop and ask me which steps to keep.** Do not choose for me.
5. After my answer, run `node .harness/feature.mjs approve <id> --keep <my numbers>` (or `--all` if I said all). Tell me any `!` warning it prints.
6. Ask whether to build now. If yes, run `/harness:auto` (autonomous mode on the `uat` branch; big runs stay held for my OK). Progress any time: `node .harness/feature.mjs status`.

Never approve steps, answer a 🟡 decision, or run `backlog.mjs approve` for me. Never commit, push or merge.
