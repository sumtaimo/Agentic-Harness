# Phase 3 QA verdict (round 2): the three fixes after the first QA

Audited: `6d08049` (winQuote), `cce3af0` (agy on stdin), `bf0105e` (empty `--help`) on `main`, against the risks in `.agent-state/02-qa-verdict.md`.

## Verdict: PASS WITH RISKS

Each fix does what it claims, and the checks pass. One new edge case was found in the probe cache, and one risk cannot be closed without the real `agy` CLI.

## Fix vs. risk

| Risk (02-qa-verdict) | Fix | Evidence | Result |
|---|---|---|---|
| 1. Windows drops `-p ""` | `winQuote` moved to `.harness/lib/common.mjs`, quotes `''` as `""`; `daemon.mjs` imports it | Test `winQuote keeps an empty argument…` passes; `node --check .harness/daemon.mjs` OK | CLOSED (not run on real Windows) |
| 2. `agy` prompt as an argument | `agy -p ""`, `promptVia: stdin` in `.harness/config.json` | Test asserts profile shape | CLOSED for length/quoting; see new risk B |
| 3. Flags unverified | Not fixable here | All non-Claude profiles still `verified: false` | OPEN (needs your machine) |
| 4. Empty `--help` trusted | `common.mjs`: unreadable help is compatible only if `verified: true`; reason added to fallback; doctor says "will NOT be used" | Two tests (silent unverified rejected, falls through to `agy`; silent verified trusted) pass | CLOSED, with new risk A |

Scope: no file outside the three commits' stated files changed. The `claude` profile is untouched and still passes doctor (5 of 5 flags). No API keys.

## Checks run

- `npm test`: 89 passed, 0 failed
- `node --test test/engine-probe.test.mjs`: 9 passed, 0 failed
- `node .harness/doctor.mjs`: 0 failures

## New risks

**A. Stale probe cache keeps the old "compatible" answer (reproduced).** The cache key is `binary path | mtime | flags` (`.harness/lib/common.mjs:107`). It does not include the probe logic or the profile's `verified` value. In a scratch test, a cache entry written by the old logic still returned `compatible: true` for a silent, unverified CLI, while a fresh probe returned `false`. Effects:
- On a machine that already probed a silent CLI before `bf0105e`, normal runs keep using it until the CLI binary changes.
- Changing a profile from `verified: false` to `true` (or back) does not re-probe either.
- Mitigation today: `node .harness/doctor.mjs` probes with `force` and rewrites the cache entry, so running doctor once clears it.
- `.harness/engine-probe.json` is git-ignored, so this only affects local machines, never the repo.

**B. `agy` may get an empty prompt.** If `agy` does not read stdin when `-p` is empty, it runs with no prompt. The probe only checks flag names, so it cannot detect this. Not testable without the real CLI.

## Next action

Fix A (small), then verify B on your machine with `echo "say hi" | agy -p ""`.

Ready-to-copy follow-up prompt:

> [PHASE 2: BUILD] In `.harness/lib/common.mjs` `probeEngine`, add a probe logic version and the profile's `verified` value to the cache key (line 107), e.g. `` `v2|${binPath}|${mtime}|${profile.verified === true}|${flags.join(' ')}` ``, so old cache entries and a changed `verified` value force a fresh probe. Add a test in `test/engine-probe.test.mjs` that writes an old-format cache entry claiming `compatible: true` for a silent unverified CLI and checks that `probeEngine` (without `force`) now returns `compatible: false`. Change nothing else. Run `npm test` and `node --test test/engine-probe.test.mjs`, report counts, and do not push.
