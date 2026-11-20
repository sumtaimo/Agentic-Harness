---
name: harness-phased-workflow
description: Use when asked to audit, build or QA a change in a project that has the agentic harness, or when the user says "Phase 1", "Phase 2", "Phase 3", "audit", "approved to build" or "QA verdict". Runs a checked three-phase flow with a stop for the owner's approval between phases.
---
# Phased workflow: audit, build, QA

Read `.harness/memory/profile.md`, `.harness/memory/lessons.md` and `CLAUDE.local.md` (if present) first. Their rules (for example when to ask before a push) override anything below.

## Before you touch git
Run these before any push and stop if the result is not what you expect. A plain `git fetch` keeps branches that were deleted on the remote, so it can look "in sync" when it is not.
```bash
git fetch --prune origin
git ls-remote --symref origin HEAD
git ls-remote --heads origin
```
Check that your branch exists on the remote, that it is the branch the owner named, and that you are not about to create a new branch by accident (`[new branch]` in push output is a warning sign). Never push to a branch the owner did not name.

## Phase 1: Audit (default when no phase is named; read-only)
- Change no source file. Write only `.agent-state/NN-audit-and-plan.md` (NN = next free number; this folder is git-ignored and local).
- Sections: Where (`file:line`) | Current vs expected | Rules and permissions, plus open business questions | Gap / root cause | Impact (validation, lifecycle, reload, permissions, related modules) | Smallest safe fix plan with "do not touch" guardrails | Validation checklist (exact commands).
- Recover technical facts from the code yourself. Ask the owner only business decisions.
- If a fact needs a real tool you do not have (a CLI, a device), say so and mark the claim unverified. Never invent it.
- Summarize in chat and STOP. Wait for "Approved to Build".

## Phase 2: Build (only after approval)
- Re-read the Phase 1 file. If it is missing or business questions are unanswered, stop and ask.
- Make only the planned change. Reuse the project's existing patterns. Show anything you changed that the plan did not list.
- Run the project's real check (`npm test` or the controller's check). Report exact pass/fail counts.
- Commit only when the owner says so. Push only after a separate, explicit confirmation.

## Phase 3: QA verdict (independent and skeptical)
- Trust `git diff` and `file:line` evidence, not claims in a report.
- Compare the diff with the Phase 1 plan: missing requirements, wrong assumptions, scope creep, state/reload bugs, regressions, weak evidence.
- Reproduce a risk before you report it when you can (a small script in the scratchpad). Check CI for the pushed commit when you can read it.
- Write `.agent-state/NN-qa-verdict.md`: verdict `PASS`, `PASS WITH RISKS` or `FAIL`, the evidence, and a ready-to-copy follow-up prompt for any gap.
- If nothing changed since the last verdict, say so and do not write a new file.

## Always
- Never `git push`, `git reset --hard`, deploy or run migrations without the owner's explicit confirmation in chat.
- Report results honestly: what changed, how it was checked, what is still unknown.
