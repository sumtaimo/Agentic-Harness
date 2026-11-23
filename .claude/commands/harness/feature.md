---
description: Big feature from a short goal — BA grows it into the whole user workflow, I keep the steps I want, then autopilot builds them
argument-hint: a short goal, e.g. login
---
Grow my short goal into a whole feature, the way a business analyst would, then build only the steps I keep.

0. **Intake (skippable).** Read `docs/foundation/product.md` and `docs/foundation/domain.md`, plus `docs/foundation/brand.md` when the feature has screens. A file that does not exist counts as all blank; a blank is a line that still says `(fill me`. If none of the relevant fields is blank, say nothing and go on. Otherwise ask me, in one message, **at most 3 short questions in plain words**, one per blank, the ones that matter most for this goal (who it is for and why, hard rules, states and permissions, and for screens the tone and anti-patterns). I can answer "skip": then go on at once, never guess an answer and do not ask again in this session. Use my answers for this feature only. You never write the foundation files yourself; offer once to save my answers, and only after a yes do it through `lead-ba` in a later assignment limited to that file.
1. Run `node .harness/feature.mjs new "$ARGUMENTS" --no-expand` and note the feature id (`F1`, …).
2. Run `node .harness/feature.mjs prompt <id>`. Start the `lead-ba` agent with that prompt and these rules: **read only, write no file**; read the project first; **pass the foundation by reference** (never paste whole files): add the line "First read docs/foundation/product.md and domain.md (and brand.md if it has screens); ignore lines that still say (fill me) and never invent what they leave out", plus my intake answers as "Owner said: …"; reply with the JSON only. Save its JSON reply to `.agent-state/feature-<id>.json` (you write it, not the agent).
3. Run `node .harness/feature.mjs expand <id> --from .agent-state/feature-<id>.json`. If it prints `FEATURE_EXPAND_FAILED`, send the error back to `lead-ba` once and try again; a second failure: tell me why and stop.
4. Show me the numbered steps in plain words: what the user does at each step, its size, which steps come first, and every 🟡 decision as a question. Point me to the spec page it wrote (`docs/features/…`). Then **stop and ask me which steps to keep.** Do not choose for me.
5. After my answer, run `node .harness/feature.mjs approve <id> --keep <my numbers>` (or `--all` if I said all). Tell me any `!` warning it prints.
6. Ask whether to build now. If yes, run `/harness:auto` (autonomous mode on the `uat` branch; big runs stay held for my OK). Progress any time: `node .harness/feature.mjs status`.

Never approve steps, answer a 🟡 decision, or run `backlog.mjs approve` for me. Never commit, push or merge.
