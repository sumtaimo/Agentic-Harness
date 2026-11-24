# Handoff: after Steps 1–4 (Foundation intake, Done vs Good + UX design, Antigravity auto-fallback, Old-project upgrades & visual-confirm hardening) — 2026-11-24

Read this first in the next session. Then read `AGENTS.md` and `.harness/memory/lessons.md`.

Branch: `lab` only. Do NOT create branches. Do NOT `git push` or touch `release` until the owner says so in chat.
No version bump / CHANGELOG entry until the owner says so. Ask before editing `.harness/charter.md` or `.harness/config.json`.

## State (Steps 1–4 completed on `lab`)
- Step 1 `9b69c98`: `docs/foundation/{product,domain,brand}.md` blank forms (installer never overwrites a filled file) and a skippable role-aware intake in `/harness:run` and `/harness:feature`.
- Step 2 `37330d7`: reviewer rubric adds `intentFit`, `states`, `craft` and a required `doneVsGood` ({intent, weak}); visual gate for changed UI (`visible.mjs visual attach|confirm|reject`, Claude Code asks the human for `confirm`); new `brand-craft` skill; Flow & State Table in `spec-writer`; `lead-ux` / `ux-designer` may write `docs/ux/**/*.md`; `lead-ux` reads `brand.md` + `product.md`.
- Step 3 `0520001`: updated Antigravity `fast` and `medium` tiers in `.harness/config.json` (`profiles.antigravity.models` and `quotaFallback.codex.models`) off the models retiring on 2026-11-30, added automatic `agy models` pre-flight check + reactive `MODEL_AUTO_FALLBACK` retry, doctor fallback hints, and `upgradeConfig()` migration of retired template defaults.
- Step 4 (2026-11-24):
  - Updated `.harness/charter.md` (`UX_DESIGNER` table row & Section 1) to cover `docs/ux/**` / `docs/ux/**/*.md`.
  - Updated `install.mjs` so existing ("old") projects upgrading safely receive full design & workflow support: missing `docs/foundation/*` & `brand-craft`, untouched prior template `.claude/commands/harness/*.md` & `.claude/agents/*.md`, untouched starter-stub `spec-writer`, updated `UX_DESIGNER` (`docs/ux/**`, `brand.md`/`product.md`) & `REVIEWER` (`Done vs Good`) roles, and template `team.json` (`lead-ux` `docs/ux/**/*.md` + `brand-craft`, or adding missing pre-1.0.7 `lead-ux`) while preserving custom edits, engine routing, and adapted scopes.
  - Hardened `visible.mjs visual confirm` (`checkVisualConfirmOrigin`, `askVisualConfirm` in `.harness/lib/guard.mjs`): refuses non-TTY self-approval in editors without `ask` rules (Antigravity, Cursor, Codex), prompts `[y/N]` interactively in human terminals, and continues working with Claude Code's `ask` rule (`CLAUDECODE` + `.claude/settings.json`).
  - Updated `.harness/lib/feature.mjs` (`expandPrompt`), `.harness/visible.mjs` (`brief`), `AGENTS.md`, `docs/WORKFLOW.md`, and `docs/WORKFLOW.km.md` so Antigravity/Cursor/headless feature & editor workflows also follow `docs/foundation/`, `docs/ux/` → `UX_DESIGNER`, `Done vs Good`, and the hardened visual gate.
- Key files: `.harness/charter.md`, `.harness/lib/guard.mjs`, `.harness/visible.mjs`, `.harness/lib/feature.mjs`, `.harness/lib/common.mjs`, `.harness/daemon.mjs`, `.harness/doctor.mjs`, `.harness/config.json`, `install.mjs`, `AGENTS.md`, `docs/WORKFLOW.md`, `docs/WORKFLOW.km.md`, `test/run-tests.mjs`, `test/engine-probe.test.mjs`, `test/evals/golden.json`.

## Remaining tasks (in order)
1. **Done (2026-11-24):** `git pull` on `lab`, `cd website && npm ci`, `npm run audit -- --site`, `npm test`, and Antigravity model update + automatic `agy models` fallback (`0520001`).
2. Skill-library risk check (owner contacts the skill library maintainers): required by `AGENTS.md` BEFORE release, because skills/roles changed (`brand-craft`, `spec-writer`, `ux-designer`, `reviewer`). Read the owner's local coordination notes first if the owner mentions it (`docs/notes/`).
3. Skill Foundry: the template's `spec-writer` is a "starter stub" that Skill Foundry's real `spec-writer` replaces on install, so the Flow & State Table must also be added in the Skill Foundry repo (separate repo, owner decides).
4. **Done (2026-11-24):** updated `.harness/charter.md` UX_DESIGNER scope (`docs/ux/**`, `docs/ux/**/*.md`).
5. **Done (2026-11-24):** updated `install.mjs` so existing projects receive untouched template commands/roles/team/agents/starter stubs + full design support while keeping every customized edit, engine routing, and adapted scope.
6. **Done (2026-11-24):** hardened `visible.mjs visual confirm` so editors without `ask` rules (Antigravity, Cursor) cannot self-approve silently in non-TTY shells (requires interactive human `[y/N]` terminal or `visual attach` screenshots).
7. Release only when the owner says "release": bump `"version"` in `package.json` (currently 1.0.46), add the `CHANGELOG.md` entry (what changed, who is affected, permission change: 2 allow + 1 ask rules, migration + old-project upgrade + Antigravity model fallback + hardened `visual confirm`), re-run `npm test` + `npm run audit -- --site`, then `git push origin lab:release` (normal push, never force).

## Risks to tell the owner
- Reviewer verdicts in the old format are refused now (the reviewer must answer again); in-flight runs are affected. The `security` agent keeps the old format.
- The screenshot check is deterministic (real PNG/JPEG/WebP, not tiny, newer than the last UI change), not proof it shows the right thing; the reviewer is told to Read it.
- Headless (daemon) runs land on `uat`, so UI changes are flagged (`VISUAL_REVIEW_PENDING`, `needsVisualReview`), not held.
- `team.json` lead-ux scope changed to `docs/ux/**/*.md` (a file-type glob so `lead-ba` keeps the rest of `docs/**`); `lead-ux` now has skills `ui-craft` + `brand-craft`.
