# Phase 3 QA verdict (round 3): probe cache key fix

Audited: commit `10f2b42` on `main` (`.harness/lib/common.mjs`, `test/engine-probe.test.mjs`) against risk A in `.agent-state/03-qa-verdict.md`.

## Verdict: PASS

The fix closes risk A, the checks pass, and nothing outside the two stated files changed.

## Evidence

- Cache key is now `v2|<binary>|<mtime>|verified=<bool>|<flags>` (`.harness/lib/common.mjs:110`, `PROBE_VERSION = 2` at `:100`).
- The round-2 reproduction re-run in the same scratch folder: the old-format cache entry claiming "compatible" is now ignored (`cached compatible: false`, was `true`).
- New test covers: old-format entry ignored, flipping `verified` re-probes, both results cached separately.
- The cache file is only read and written in `probeEngine` (`common.mjs:34`, `:128`); no other module depends on the key format.
- `npm test`: 89 passed, 0 failed. `node --test test/engine-probe.test.mjs`: 10 passed, 0 failed.

## Minor (not blocking)

1. The JSDoc above `probeEngine` (`common.mjs:96`) still says the cache is "keyed by binary path + mtime + flags". It should also mention the version and `verified`.
2. Old cache entries are never removed, so `.harness/engine-probe.json` keeps a few dead keys after upgrades. It is git-ignored and tiny, so this has no practical effect.

## Still open (needs your machine)

- Risk B: whether `agy` reads stdin with `-p ""`. Check with `echo "say hi" | agy -p ""`.
- Real `--help` flags for `gemini` and `agy`. Check with `node .harness/doctor.mjs`.

## Next action

Optional one-line doc fix for minor item 1. Otherwise the code work is complete; mark the Gemini and `agy` profiles `verified: true` once both real-machine checks succeed.

Ready-to-copy follow-up prompt (optional):

> [PHASE 2: BUILD] In `.harness/lib/common.mjs`, update the JSDoc above `probeEngine` so it says the cache is keyed by probe version, binary path, mtime, the profile's `verified` value and the flags. Change nothing else. Run `npm test` and do not push.
