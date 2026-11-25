# Handoff: after v1.0.48 release (UX slot 2 + Skill-Foundry coordination released) — 2026-11-25

Read this first in the next session. Then read `AGENTS.md` and `.harness/memory/lessons.md`.

Branch: `lab` only. Do NOT create branches. Do NOT `git push` or touch `release` until the owner says so in chat.
No version bump / CHANGELOG entry until the owner says so. Ask before editing `.harness/charter.md` or `.harness/config.json`.

## State (v1.0.48 released — `lab` synced to `release`)
- Step 1 `9b69c98`: `docs/foundation/{product,domain,brand}.md` blank forms (installer never overwrites a filled file) and a skippable role-aware intake in `/harness:run` and `/harness:feature`.
- Step 2 `37330d7`: reviewer rubric adds `intentFit`, `states`, `craft` and a required `doneVsGood` ({intent, weak}); visual gate for changed UI (`visible.mjs visual attach|confirm|reject`, Claude Code asks the human for `confirm`); new `brand-craft` skill; Flow & State Table in `spec-writer`; `lead-ux` / `ux-designer` may write `docs/ux/**/*.md`; `lead-ux` reads `brand.md` + `product.md`.
- Step 3 `0520001`: updated Antigravity `fast` and `medium` tiers in `.harness/config.json` (`profiles.antigravity.models` and `quotaFallback.codex.models`) off the models retiring on 2026-11-30, added automatic `agy models` pre-flight check + reactive `MODEL_AUTO_FALLBACK` retry, doctor fallback hints, and `upgradeConfig()` migration of retired template defaults.
- Step 4 `812947a`: updated `.harness/charter.md` (`UX_DESIGNER` `docs/ux/**`), updated `install.mjs` for existing-project design & workflow upgrades, hardened non-TTY `visual confirm` across Antigravity/Cursor, and aligned `.harness/lib/feature.mjs`, `.harness/visible.mjs`, `AGENTS.md`, and `docs/WORKFLOW*.md`.
- Release `1.0.47` (2026-11-25): Skill Foundry (`spec-writer-harness-sync`, `9435546`) completed risk check + `spec-writer` Flow & State Table + dual-order audit (`35 passed, 0 failed`), `package.json` bumped `1.0.46` -> `1.0.47`, `CHANGELOG.md` updated, and `lab` pushed to `release`.
- Release `1.0.48` (2026-11-25): coordinated with Skill-Foundry (`v1.10.0` — `design-system`, `motion-craft`, `svg-mechanism`): saved `L3` in `.harness/memory/lessons.md`, unpinned `ui-craft` on `lead-ux` (`skills: ["brand-craft"]`, freeing slot 2), removed overlapping keywords (`"design system"`, `"user flow"`, `"microcopy"`) from `brand-craft`, clarified `DEV_ENGINEER` token-script handoff in `brand-craft` rule 7, added subsumed-keyword protection in `governance.mjs` `matchSkills()` (preserving `ui-craft` `STARTER_SHA`), updated `install.mjs` `1.0.47` -> `1.0.48` upgrades, bumped `package.json` + `CHANGELOG.md`, passed full tests/audit, and pushed `lab` to `release`.

## Tasks status
1. **Done (2026-11-24):** `git pull` on `lab`, `cd website && npm ci`, `npm run audit -- --site`, `npm test`, and Antigravity model update + automatic `agy models` fallback (`0520001`).
2. **Done (2026-11-25):** Skill-library risk check completed cleanly by Skill Foundry (`spec-writer-harness-sync`, `9435546`; low-risk advisory only: `brand-craft` keywords `"design system"` / `"user flow"` partially overlap `design-system` / `ux-review`, harmless while `lead-ux` pins `["ui-craft", "brand-craft"]`).
3. **Done (2026-11-25):** Skill Foundry real `spec-writer` updated with Flow & State Table + `docs/foundation/` references (ready in `spec-writer-harness-sync` to merge to `master` after `1.0.47` ships).
4. **Done (2026-11-24):** updated `.harness/charter.md` UX_DESIGNER scope (`docs/ux/**`, `docs/ux/**/*.md`).
5. **Done (2026-11-24):** updated `install.mjs` so existing projects receive untouched template commands/roles/team/agents/starter stubs + full design support while keeping every customized edit, engine routing, and adapted scope.
6. **Done (2026-11-24):** hardened `visible.mjs visual confirm` so editors without `ask` rules (Antigravity, Cursor) cannot self-approve silently in non-TTY shells (requires interactive human `[y/N]` terminal or `visual attach` screenshots).
7. **Done (2026-11-25):** released `v1.0.47` (`package.json`, `CHANGELOG.md`, `npm test`, `npm run audit -- --site`, pushed `lab` -> `release`).
8. **Done (2026-11-25):** released `v1.0.48` (UX slot 2 + Skill-Foundry coordination + subsumed-keyword ranking; `package.json`, `CHANGELOG.md`, `npm test`, `audit --site --foundry`, pushed `lab` -> `release`).

## Risks to tell the owner
- Reviewer verdicts in the old format are refused now (the reviewer must answer again); in-flight runs are affected. The `security` agent keeps the old format.
- The screenshot check is deterministic (real PNG/JPEG/WebP, not tiny, newer than the last UI change), not proof it shows the right thing; the reviewer is told to Read it.
- Headless (daemon) runs land on `uat`, so UI changes are flagged (`VISUAL_REVIEW_PENDING`, `needsVisualReview`), not held.
- `team.json` `lead-ux` scope uses `docs/ux/**/*.md` (a file-type glob so `lead-ba` keeps the rest of `docs/**`), and `lead-ux` pins `["brand-craft"]` (1/2) so slot 2 dynamically loads `ui-craft` or Skill-Foundry UX skills.
- Next in Skill-Foundry (separate repo/session): update `design-system` to read `docs/foundation/brand.md`, `product.md`, and `docs/ux/`.
