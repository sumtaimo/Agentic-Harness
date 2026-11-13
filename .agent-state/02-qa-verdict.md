# Phase 3 QA verdict: Gemini/agy profiles and doctor warning

Audited: commit `184326d` on `main` against `.agent-state/01-audit-and-plan.md` (section 6) and the PO answers (`agy`; Gemini may auto-approve).

## Verdict: PASS WITH RISKS

All four planned changes are present and the automated checks pass. Two edge cases are real but limited to Windows or very long prompts, and the flags themselves are still unverified against the real CLIs.

## Plan vs. diff

| Plan step | Evidence | Result |
|---|---|---|
| 1. Get real `gemini --help` / `agy --help` | Not provided by the PO; web sources used instead | SKIPPED (disclosed) |
| 2. Gemini and Antigravity profiles | `.harness/config.json`: gemini `--approval-mode yolo -p ""` stdin; antigravity `binary: agy`, `-p {prompt}`, `promptVia: arg`, no approval flag; both `verified: false` | DONE |
| 3. Doctor warns on missing first-choice engine | `.harness/doctor.mjs` (+6 lines after the probe loop start); live output: "gemini not installed, but it is your first-choice engine" | DONE |
| 4. Test with real flag lists | `test/engine-probe.test.mjs`: 7 cases incl. old-Gemini fallthrough to `agy` and `agy` without `-p` | DONE |
| (not in plan) `docs/ENGINES.md` updated | Removes facts the config change made wrong | Scope creep, small and disclosed |

Business rules: auto-approve only on Gemini, matching the PO answer. `agy` has none. No API keys anywhere. The `claude` profile is untouched.

## Checks run

- `npm test`: 89 passed, 0 failed
- `node --test test/engine-probe.test.mjs`: 7 passed, 0 failed
- `node .harness/doctor.mjs`: 0 failures, 1 warning (the new, correct "gemini not installed" warning)

## Risks found

1. **Windows drops the empty `-p ""` argument (real bug, Windows only).** On Windows the engine is spawned with `shell: true` and each arg goes through `winQuote` (`.harness/daemon.mjs:167`, `:252`). `winQuote('')` returns `''` unchanged, because the regex does not match an empty string. So the command line becomes `gemini --approval-mode yolo -p` with no value. Gemini may then error or treat the next token as the prompt. Linux and macOS are not affected: `spawn` without a shell keeps empty args.
2. **`agy` prompt on the command line.** `promptVia: "arg"` puts the whole worker prompt in one argv entry. Linux limits one argument to 128 KiB (`MAX_ARG_STRLEN`). On Windows with `shell: true`, multi-line prompts pass through `cmd.exe`, where newlines are not safely quoted by `winQuote`. Typical prompts are far below 128 KiB, but the Windows newline case is likely to break. Stdin would be safer if `agy` supports it, which is unconfirmed.
3. **Flags unverified.** `-p` and `--approval-mode` for Gemini, and `-p` for `agy`, come from web sources. A wrong flag makes the probe reject the engine and fall back, so no run hangs, but your first-choice engine would be silently unused. The new doctor warning only covers "not installed", not "installed but rejected"; that case was already reported as a failure (✖) by doctor.
4. **The probe passes on empty `--help` output** (`common.mjs:108-109`, `checked: false` counts as compatible). Unchanged by this work, still open from the Phase 1 audit.

## Not found

- No reload or lifecycle regressions: the probe cache key includes the flags (`common.mjs:98`), so the new profiles re-probe automatically.
- Memory injection is fine for `agy`: with no `instructionFile`, the harness injects profile and lessons itself (`daemon.mjs:340`).

## Next action

Fix risk 1 (one line), then confirm the flags on a real machine with `node .harness/doctor.mjs`. If `agy` reads stdin, switch it to `promptVia: "stdin"` to remove risk 2.

Ready-to-copy follow-up prompt:

> [PHASE 2: BUILD] In `.harness/daemon.mjs:167`, make `winQuote` quote an empty string as `""` so `gemini -p ""` keeps its empty argument on Windows (`shell: true`). Add a test in `test/engine-probe.test.mjs` or `test/run-tests.mjs` that checks `winQuote('')` returns `'""'` (export it or test the built args). Do not change anything else. Run `npm test` and `node --test test/engine-probe.test.mjs`, report counts, and do not push.
