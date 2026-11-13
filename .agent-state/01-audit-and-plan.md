# Phase 1 audit: doctor probe for the Gemini and Antigravity engines

Status: READ-ONLY audit. No source file was changed. Waiting for Product Owner approval before Phase 2.
Repo state audited: working tree of branch `claude/cloud-environment-setup-cowrnu` (same code as `main` after PR #1, except `main` is a squash).

## 1. Where

| What | Location |
|---|---|
| Flag extraction from a profile | `.harness/lib/common.mjs:80-83` (`profileFlags`) |
| The probe itself (`<binary> --help`, flag regex, cache) | `.harness/lib/common.mjs:91-117` (`probeEngine`) |
| Engine selection and fallback to `auto` | `.harness/lib/common.mjs:126-156` (`resolveProfile`) |
| Doctor report per engine | `.harness/doctor.mjs:35-44`; "not installed" is neutral at `:39`; chosen engine at `:46-47` |
| Fallback is logged | `.harness/daemon.mjs:243` (`ENGINE_FALLBACK`) |
| Engine command line and spawn | `.harness/daemon.mjs:170-181`, `:252` |
| `GEMINI.md` is injected as the instruction file | `.harness/daemon.mjs:340-342` |
| Gemini profile | `.harness/config.json:132-` (`args: ["--yolo"]`, `promptVia: "stdin"`, `verified: false`) |
| Antigravity profile | `.harness/config.json:98-` (`binary: "antigravity"`, `args: ["--headless","--json"]`, `verified: false`) |
| Engine order | `.harness/config.json:9` (now `gemini, antigravity, claude, orca, codex`) |
| Worker timeout | `.harness/config.json:3` (`workerTimeoutMs: 300000`) |
| Existing probe test (generic fake engine only) | `test/run-tests.mjs:133-144` |

## 2. Current vs. expected

**Current:** the probe runs `<binary> --help` once (15 s timeout) and checks that each configured flag string appears in the help text. A missing binary or a missing flag makes the engine "unusable", and `auto` skips it.

**Expected (your goal):** with Gemini first in `autoOrder`, the harness should use Gemini whenever it can really run a headless task, and fall back safely otherwise.

Tested in a scratch dir with fake binaries and `HARNESS_ROOT` pointing away from the repo (no repo file was written):

| Fake CLI | Result |
|---|---|
| fake `gemini` whose help lists `-y, --yolo` | `compatible: true`, `auto -> gemini` |
| fake `antigravity` with VS Code-style help | `missing: ["--headless","--json"]`, explicit `antigravity` falls back to `gemini` |

So the probe logic is sound. The weakness is what it checks, not how.

## 3. Rules and permissions (and open questions for the PO)

- Subscription-only policy: neither profile needs an API key. `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `OPENAI_API_KEY` are all unset in this container.
- `--yolo` auto-approves every tool call (the profile note at `config.json:132-` says so). That is a permission decision for you.
- **Open question 1 (business):** which Antigravity command do you run in a terminal, `agy` or `antigravity`? Web sources say the terminal agent is `agy` and `antigravity` is the desktop app launcher. I could not confirm this against Google's own reference.
- **Open question 2 (business):** may Gemini run with auto-approve in this repo, or should it use a safer approval mode?
- Technical facts I could not recover from this container: neither CLI is installed here, so I have no real `--help` output.

## 4. Gap / root cause

1. **The probe checks flag names, not behaviour.** Gemini's profile has only `--yolo`. Web sources say headless mode is triggered by `-p`/`--prompt` (`echo "..." | gemini -p ""`), and that `--yolo` is deprecated in favour of `--approval-mode=yolo`. If `--yolo` is still listed in `--help`, the probe passes but the engine may not enter headless mode. Nothing falls back in that case. The worker would wait until `workerTimeoutMs` (300 s) and then fail. Because Gemini is now first in `autoOrder`, this affects every `auto` run.
2. **Antigravity profile is probably wrong.** `antigravity --headless --json` came from "the original spec" (profile note). Sources point to `agy -p`, with approval via `--approve` or `--dangerously-skip-permissions`, and I could not tell which is current. The safe outcome today is a fallback (probe fails), not a hang.
3. **Doctor is quiet about the engine you want.** `doctor.mjs:39` prints "not installed" as a neutral dot. A user who expects Gemini to be first gets no warning if it is missing; only line 47 reveals the fallback.
4. **No test uses the real Gemini or Antigravity profile shape**, only a generic fake (`test/run-tests.mjs:133-144`).
5. Antigravity has no `instructionFile`, so `AGENTS.md`/`GEMINI.md` content is not injected for it (`daemon.mjs:340`). Not verified whether that matters.

## 5. Impact and beyond-UI acceptance criteria

- **Validation states:** installed + compatible, installed + incompatible, not installed, help unreadable (`checked: false`, treated as compatible, `common.mjs:108-109`). The last case would let a broken profile through; verify it for both CLIs.
- **Lifecycle:** probe results are cached in `.harness/engine-probe.json` keyed by binary path, mtime and flags (`common.mjs:98-100`). Upgrading a CLI changes mtime, so the cache refreshes. Editing only the profile args changes the key too.
- **Reload persistence:** the cache file is git-ignored (`.gitignore`), so each machine probes for itself.
- **Related modules:** `daemon.mjs` (spawn and fallback), `doctor.mjs`, `visible.mjs` (editor workflow, unaffected), `test/run-tests.mjs`.
- **Regression risk:** Claude profile (`verified: true`) must stay untouched. `autoOrder` still falls through to Claude.
- No UI or layout acceptance criteria apply; this is CLI output only.

## 6. Smallest safe fix plan (for Phase 2, only after the PO answers section 3)

1. On your machine, run `gemini --help` and `agy --help` (and `antigravity --help` if both exist) and paste the output. This is read-only and gives the real flags.
2. Update only the `gemini` and `antigravity` profiles in `.harness/config.json`, using the flags from step 1 (likely `-p`, an approval-mode flag, and `--output-format` for Gemini; `agy -p` plus its approval flag for Antigravity). Do not mark `verified: true` until a real run succeeds.
3. In `doctor.mjs`, turn the neutral "not installed" line into a warning when the engine is first in `autoOrder` or equals `activeProfile`.
4. Add one test using fake `gemini` and fake `agy`/`antigravity` binaries with the real flag lists (extends `test/run-tests.mjs:133-144`).

**Scope guardrails (do not touch):** the `claude` profile, `charter.md`, `team.json`, `.claude/`, roles and skills, `daemon.mjs` spawn logic, any API-key handling. Do not push; do not install global software.

## 7. Validation checklist

Automated:
- `npm test` (expect 89 passed, plus the new test)
- `node .harness/doctor.mjs` (expect 0 failures)

Manual, on a machine with the CLIs installed:
- `node .harness/doctor.mjs` shows `gemini` and the Antigravity binary as compatible, or names the missing flags.
- `npm run run -- --goal "create hello.txt containing hi" --files hello.txt --engine gemini` (or the equivalent dispatch flag): it finishes well under 300 s and `.harness/telemetry.log` shows `ENGINE_SPAWN` for `gemini`, not `ENGINE_FALLBACK`.
- Repeat with the Antigravity profile selected.
- Remove one of the CLIs from `PATH` and confirm the run falls back and logs `ENGINE_FALLBACK`.

## Sources used (web, unverified against vendor reference)
- Gemini headless flags: https://www.mintlify.com/google-gemini/gemini-cli/reference/cli-options and https://geminicli.com/docs/cli
- Antigravity CLI: https://computingforgeeks.com/antigravity-cli-cheat-sheet/ and https://antigravity.google/docs/cli/headless
