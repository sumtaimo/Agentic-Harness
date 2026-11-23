# Handoff: Step 2 (Done vs Good rubric, visual gate, brand-craft, UX docs/ux) — 2026-11-23

Branch: `lab` (do NOT create branches; do NOT `git push` until the owner says yes; no version bump / release yet).
Step 1 is committed (`9b69c98`). **Step 2 is built but UNCOMMITTED** in the working tree.

## Owner's Step 2 request (approved)
1. Small fix: `lead-ux` reads BOTH `brand.md` and `product.md` (done in `run.md`, docs, test).
2. Rubric: add `intentFit`, `states`, `craft` + mandatory "Done vs Good" (`doneVsGood.intent` + `doneVsGood.weak`); make NEEDS A VISUAL REVIEW a real gate (human confirm OR screenshot evidence).
3. New `brand-craft` skill; Flow & State Table in `spec-writer`.
4. Widen `ux-designer` to write `docs/ux/**` (code scope and charter limits unchanged).
Rules: run `npm test` and `npm run audit`; report exact results, every file changed, edge cases and risks.

## What was done (all uncommitted)
- `.harness/lib/guard.mjs`: 8-criterion rubric (`states`/`craft` may be `"n/a"`, `craft` not on UI), `doneVsGood` required for reviewer (security stays old format), `isUiFile`, `visualPending`, `reviewComplete`, `checkVisualEvidence` (real PNG/JPEG/WebP, >=1KB, PNG >=200px, newer than the run), `reviewPolicy().visual` (config `review.visual:false` turns the gate off).
- `.harness/visible.mjs`: `verify` sets `run.uiChanged/uiFiles/visualRequired` (UI = `isUiFile && isReviewableFile`, so test files never trigger it); new `visual attach|confirm|reject <run>`; `judge` uses the new rubric and `completeIfReviewed`; status shows `[AWAITING VISUAL REVIEW]`; autopilot waits. Evidence must be newer than the last UI-file change.
- `.harness/daemon.mjs` (headless): reviewer prompt has the DONE-vs-GOOD line (foundation files by reference); UI approved => telemetry `VISUAL_REVIEW_PENDING` + `needsVisualReview` on the backlog item. NOT a hard gate (work lands on `uat`).
- `.harness/lib/handoff.mjs`: headless-resumed UI run keeps the visual gate open.
- Roles/team: `roles/reviewer.json`, `roles/ux-designer.json` (writablePaths + `docs/ux/**`), `team.json` (lead-ux scope `docs/ux/**/*.md`, skills `ui-craft`,`brand-craft`), regenerated `.claude/agents/lead-ux.md`; hand-edited `.claude/agents/reviewer.md`.
- Skills: new `.harness/skills/brand-craft/SKILL.md`; `spec-writer/SKILL.md` Flow & State Table.
- `.claude/settings.json`: allow `visual attach`, `visual reject`; ASK `visual confirm`. `.claude/commands/harness/run.md` updated (intake, role->file map, step 4b).
- Docs: `README.md`, `AGENTS.md`, `docs/WORKFLOW.md`, `docs/WORKFLOW.km.md`.
- Tests: `test/run-tests.mjs` (fixtures + 4 new tests), `test/evals/golden.json` (13 judge cases, 13 invalid), `test/mock-agent.mjs`.

## Verification status
- Last COMPLETE run before the final two edits: `npm test` 241 passed, 0 failed (+14/14 engine-probe); `npm run audit` 23/0.
- After that I made 2 small edits (UI filter via `isReviewableFile`, `uiChanged`, evidence newer-than-last-UI-change, handoff.mjs resume flag) and added 2 test blocks; a `npm test` run was started in the background and its result was NOT read.
- NEXT: run `npm test`, `npm run audit`, `npm run audit -- --site` (if the website `npm ci` step fails once, run `cd website && npm ci` then retry). Fix anything red.

## Still to do
1. Re-run tests/audit as above; fix failures.
2. Commit on `lab` (specific files, no push) once green; then ask the owner before any push.
3. Final report to the owner: exact results, every file changed, edge cases/risks.

## Risks to tell the owner
- Verdicts in the old format are now refused for the reviewer (must answer again); in-flight runs are affected.
- `confirm` is only as strong as the orchestrator's honesty outside Claude Code (Claude Code asks the human via the settings ASK rule); screenshot check is deterministic (valid, fresh image), not proof it shows the right thing; the reviewer is told to Read it.
- Headless runs are flagged, not held.
- `spec-writer` here is a Skill Foundry "starter stub": Skill Foundry's real spec-writer replaces it on install, so the Flow & State Table must also go there.
- AGENTS.md: skill/role changes need the skill-library maintainers' risk check BEFORE release.
- `team.json` lead-ux scope changed (needed to make the approved role widening effective); `charter.md` role table still lists old UX scope (owner approval needed to edit charter).
- Existing projects keep old slash commands on update ("kept (already existed)"): pre-existing behaviour.
- No version bump / CHANGELOG entry yet (owner's release decision).
