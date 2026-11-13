# Phase 3 QA verdict (round 5): Khmer workflow doc

Audited: commit `f1e3d41` on `main` (`docs/WORKFLOW.km.md`, 59 lines, the only file changed).

## Verdict: PASS WITH RISKS (docs only)

The facts in the doc match the code, and `npm test` passes (89 of 89, including the docs-match-reality test). One section compresses the real story in a way that is slightly misleading, and the doc is not linked from anywhere.

## Facts checked against the code

| Claim in the doc | Source | Result |
|---|---|---|
| Max 3 cycles, then HALTED_HITL_REQUIRED | `.harness/config.json:2` (`maxCycles: 3`) | correct |
| Modes normal, parallel, team | `.harness/dispatch.mjs:77-79` | correct |
| `autoOrder` gemini → antigravity → claude → orca → codex | `.harness/config.json` | correct |
| Autonomous paths `src/**`, `docs/**`, `tests/**`, `test/**` | `.harness/charter.md:11` | correct |
| Autopilot lands on `uat` | `.harness/config.json` `git.integrationBranch` | correct |
| Rule L1 (ask before every push) | `.harness/memory/lessons.md` | correct |
| `ENGINE_FALLBACK` in `.harness/telemetry.log` | `.harness/daemon.mjs:243` | correct |

## Issues

1. **Section 7 skips a step.** It says the first attempt failed 75/89 because `sandbox()` copied the backlog and open run, and then that `install.mjs` was fixed. It leaves out that `sandbox()` itself was fixed first (88/89), and that `install.mjs` fixed the last failing test (the demo project). A reader could think the `install.mjs` change fixed the `sandbox()` problem.
2. **Not linked.** Neither `README.md` nor `docs/WORKFLOW.md` points to `docs/WORKFLOW.km.md`, so Khmer readers would not find it.

## Next action

Ready-to-copy follow-up prompt:

> [PHASE 2: BUILD] In `docs/WORKFLOW.km.md` section 7, add the missing middle step: `sandbox()` was fixed first (test 88/89), then the last failing test (demo project) was fixed in `install.mjs` (89/89). Add one line near the top of `docs/WORKFLOW.md` linking to `docs/WORKFLOW.km.md` (Khmer version). Change nothing else. Run `npm test` and do not push.
