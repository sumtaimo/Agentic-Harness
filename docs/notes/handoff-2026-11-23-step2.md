# Handoff: after Step 2 (Done vs Good rubric, visual gate, brand-craft, docs/ux) — 2026-11-23

Read this first in the next session. Then read `AGENTS.md` and `.harness/memory/lessons.md`.

Branch: `lab` only. Do NOT create branches. Do NOT `git push` or touch `release` until the owner says so in chat.
No version bump / CHANGELOG entry until the owner says so. Ask before editing `.harness/charter.md` or `.harness/config.json`.

## State (Steps 1–2 on `lab`; Step 3 Antigravity model refresh + auto-fallback ready on `lab`)
- Step 1 `9b69c98`: `docs/foundation/{product,domain,brand}.md` blank forms (installer never overwrites a filled file) and a skippable role-aware intake in `/harness:run` and `/harness:feature`.
- Step 2 `37330d7`: reviewer rubric adds `intentFit`, `states`, `craft` and a required `doneVsGood` ({intent, weak}); visual gate for changed UI (`visible.mjs visual attach|confirm|reject`, Claude Code asks the human for `confirm`); new `brand-craft` skill; Flow & State Table in `spec-writer`; `lead-ux` / `ux-designer` may write `docs/ux/**/*.md`; `lead-ux` reads `brand.md` + `product.md`.
- Step 3 (2026-11-24): updated Antigravity `fast` and `medium` tiers in `.harness/config.json` (`profiles.antigravity.models` and `quotaFallback.codex.models`) off the models retiring on 2026-11-30, and verified both tiers with real scratch smoke runs on `agy` 1.5.14 (`COMMITTED` on Cycle 1). Added automatic `agy models` pre-flight check (`listAvailableModels`, `pickModelFromAvailable`, 6 h cache in `.harness/engine-probe.json`), reactive `MODEL_AUTO_FALLBACK` retry (`isModelUnavailableError`) in `.harness/daemon.mjs`, runtime fallback hints in `.harness/doctor.mjs`, and automatic upgrade migration of discontinued template defaults in `install.mjs` (preserving custom owner models), plus docs (`docs/ENGINES.md`, `docs/MULTI-MODEL-SETUP.md`) and unit/e2e tests (`test/engine-probe.test.mjs`, `test/run-tests.mjs`). Also updated `sandbox()` in `test/run-tests.mjs` to skip git-ignored runtime caches.
- Key files: `.harness/lib/guard.mjs`, `.harness/visible.mjs`, `.harness/lib/common.mjs`, `.harness/daemon.mjs`, `.harness/doctor.mjs`, `.harness/config.json`, `install.mjs`, `test/run-tests.mjs`, `test/engine-probe.test.mjs`, `test/evals/golden.json`.

## Remaining tasks (in order)
1. **Done (2026-11-24):** `git pull` on `lab`, `cd website && npm ci`, `npm run audit -- --site`, `npm test`, and Antigravity model update + automatic `agy models` fallback.
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
