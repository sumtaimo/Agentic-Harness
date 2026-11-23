# Handoff: after Step 2 (Done vs Good rubric, visual gate, brand-craft, docs/ux) — 2026-11-23

Read this first in the next session. Then read `AGENTS.md` and `.harness/memory/lessons.md`.

Branch: `lab` only. Do NOT create branches. Do NOT `git push` or touch `release` until the owner says so in chat.
No version bump / CHANGELOG entry until the owner says so. Ask before editing `.harness/charter.md` or `.harness/config.json`.

## State (everything below is committed and pushed to `lab`)
- Step 1 `9b69c98`: `docs/foundation/{product,domain,brand}.md` blank forms (installer never overwrites a filled file) and a skippable role-aware intake in `/harness:run` and `/harness:feature`.
- Step 2 `37330d7`: reviewer rubric adds `intentFit`, `states`, `craft` and a required `doneVsGood` ({intent, weak}); visual gate for changed UI (`visible.mjs visual attach|confirm|reject`, Claude Code asks the human for `confirm`); new `brand-craft` skill; Flow & State Table in `spec-writer`; `lead-ux` / `ux-designer` may write `docs/ux/**/*.md`; `lead-ux` reads `brand.md` + `product.md`.
- Last verified: `npm test` 241 passed, 0 failed (+14/14 engine-probe); `npm run audit` 23 passed, 0 failed.
- Key files: `.harness/lib/guard.mjs` (rubric, `checkVisualEvidence`), `.harness/visible.mjs` (gate + `visual` command), `.harness/daemon.mjs` (headless reviewer prompt, `VISUAL_REVIEW_PENDING`), `test/run-tests.mjs`, `test/evals/golden.json`.

## Remaining tasks (in order)
1. `git pull` on `lab`, then run `npm test`, `npm run audit` and `npm run audit -- --site` (not yet run on the final tree; if the website build fails once, run `cd website && npm ci` and retry). Fix anything red.
2. Skill-library risk check (owner contacts the skill library maintainers): required by `AGENTS.md` BEFORE release, because skills/roles changed (`brand-craft`, `spec-writer`, `ux-designer`, `reviewer`). Read the owner's local coordination notes first if the owner mentions it (`docs/notes/`).
3. Skill Foundry: the template's `spec-writer` is a "starter stub" that Skill Foundry's real `spec-writer` replaces on install, so the Flow & State Table must also be added in the Skill Foundry repo (separate repo, owner decides).
4. `.harness/charter.md` role table still lists the old UX_DESIGNER scope (style files only): update with the owner's OK (add `docs/ux/**`).
5. Decide with the owner: should an update refresh existing projects' slash commands? The installer keeps files that exist (`kept .claude/commands/…`), so existing projects do not get the new intake/visual steps. (Pre-existing behavior.)
6. Optional hardening to propose to the owner: confirm that `visual confirm` cannot be self-approved by an orchestrator in editors without ask rules (Antigravity, Cursor); today it relies on the instruction "only after the human said yes".
7. Release only when the owner says "release": bump `"version"` in `package.json` (currently 1.0.46), add the `CHANGELOG.md` entry (what changed, who is affected, permission change: 2 allow + 1 ask rules, migration), re-run `npm test` + `npm run audit -- --site`, then `git push origin lab:release` (normal push, never force).

## Risks to tell the owner
- Reviewer verdicts in the old format are refused now (the reviewer must answer again); in-flight runs are affected. The `security` agent keeps the old format.
- The screenshot check is deterministic (real PNG/JPEG/WebP, not tiny, newer than the last UI change), not proof it shows the right thing; the reviewer is told to Read it.
- Headless (daemon) runs land on `uat`, so UI changes are flagged (`VISUAL_REVIEW_PENDING`, `needsVisualReview`), not held.
- `team.json` lead-ux scope changed to `docs/ux/**/*.md` (a file-type glob so `lead-ba` keeps the rest of `docs/**`); `lead-ux` now has skills `ui-craft` + `brand-craft`.
