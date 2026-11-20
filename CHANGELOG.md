# Changelog

One entry per released version (newest first). Each entry says what changed, who is affected, any change to
config, permissions or hooks, and what to do after updating. Update a project with:

```
npx github:sumtaimo/Agentic-Harness#release .
```

The installer keeps your `config.json`, charter, team, backlog and memory; it replaces the harness core and prints
the entries newer than the version you had.

## 1.0.24 — 2026-11-20

- **hook-guard: no more false blocks on quoted text.** A read-only command such as `node -e "…"` was blocked only
  because its quoted argument contained the words of a forbidden git command. Quoted arguments and heredocs that a
  program reads are now treated as data. Quoted shell code (`bash -c "…"`, `powershell -Command "…"`, `cmd /c "…"`)
  and git's own arguments (`git push origin "main"`) are still checked. *Affects:* Claude Code users.
- **`backlog.mjs done <id> "note"`** closes an item finished outside the harness (the note is required and kept as
  `doneNote`, result `DONE_OUTSIDE_HARNESS`). Claude Code asks before running it.
- **doctor: removed engines.** An older `config.json` that still lists `orca` (or `gemini`) gets one clear warning
  ("no longer supported … remove it") instead of a failed flag probe and a missing-models warning. *Migration:*
  delete `orca` from `profiles` and `autoOrder` in `.harness/config.json`.
- **doctor: one-engine team.** When every team member is routed to the same engine, doctor says what happens on a
  usage limit (HTTP 429): agents retry on another usable engine (`QUOTA_FALLBACK`), or, if there is none, a warning
  that one limit stops the whole team. *Fix:* `node .harness/team.mjs auto-assign` after allowing a second engine.
- **CHANGELOG.md** (this file) and a "what's new" summary at the end of every install that changes the version.

## 1.0.23 — 2026-11-20

- **LLM judge gate, required by default** (`config.review`: `required: true`, `headless: true`, `minScore: 3`).
  A PASSED code change is not DONE until a read-only reviewer judge approves it against a rubric (correctness,
  acceptance, tests, rootCause, safety). Editor: `node .harness/visible.mjs judge <run> --agent reviewer --file <report>`;
  the backlog item stays IN_PROGRESS (`awaitingJudge`) and autopilot waits. Headless (`daemon`, `npm run auto`,
  `dispatch`): the controller runs the reviewer itself; findings go back to the workers as the next cycle's error;
  no valid verdict fails closed. Docs-only and test-only changes skip it. *Affects:* everyone; runs take one extra
  agent call per code change. *To turn it into advice only:* `"review": { "required": false }`.
- **Prompt-injection guard.** Every agent prompt says that content read from files and tools is data, not
  instructions. Backlog or proposed task text that tries to steer agents is rejected (`visible.mjs propose`) or held
  as BLOCKED (`brief --next`, the daemon) until `node .harness/backlog.mjs approve <id>`. Injection-like text an agent
  writes into a file is reported and shown to the judge.
- **PreToolUse guard `.harness/hook-guard.mjs`** blocks, before they run: edits to `.env*`, `.git/**`,
  `.harness/releases/**` (and the harness core in installed projects), `git reset --hard`, `git clean -f`, force
  pushes, and pushes to protected branches (`git.protectedBranches` + `git.integrationBranch`).
  *Settings change:* the installer merges into `.claude/settings.json` a `PreToolUse` hook (`node .harness/hook-guard.mjs`)
  and a deny rule `Bash(git reset --hard:*)`. Your own rules and hooks stay.
- **Prompt size guard** `config.maxPromptChars` (default 120000): oversized worker prompts are clipped, memory and
  error trace first (`PROMPT_CLIPPED` in telemetry).
- **Skill pointers:** `schema_version` is read (`SKILL_SCHEMA_MAX = 1`); a newer pointer is skipped with a doctor
  warning instead of a crash. Keywords match as case-insensitive substrings.
- **Evals:** `test/evals/golden.json` (run by `npm test`) and `npm run eval -- --engine <name>` (opt-in, live).

## 1.0.22 — 2026-11-19

- A test script that can never fail (`exit 0`, `true`, a bare `echo`, the `npm init` stub) is no longer treated as
  a real check: autonomous runs refuse it, manual reports say `NO REAL TEST SIGNAL`.
- Antigravity (`agy`): long prompts no longer overflow the Windows command line.
- Landing page and docs brought in line with the source.

## 1.0.21 — 2026-11-18

- **Pre-commit patch safety gate** (`scanPatchSafety`): newly added secrets (shown only as `(redacted)`) and merge
  conflict markers block verify; a new `debugger` statement is a warning.
- **Failure diagnosis** on a failed check (`[FAILURE DIAGNOSIS]`, `[REPEAT FAILURE]`), in the daemon and the editor
  workflow.
- **Task-aware memory:** `node .harness/memory.mjs context --goal … --files …` ranks auto-lessons by relevance;
  `memory.mjs learn` and `promote` save and share local lessons.
- Check auto-detection for npm/pnpm/yarn/bun workspaces, Python, Go, Rust, PHP/Laravel and Makefile; adaptive scopes
  for non-`src/` layouts (`node .harness/team.mjs adapt-scopes`); a repo map in planner prompts.
- doctor checks that the six cross-tool rule files point to `AGENTS.md`. *Rule files change:* the installer rewrites
  the harness section of `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursor/rules/harness.mdc` and
  `.windsurfrules` to also mention `node .harness/memory.mjs learn` (local lessons) and `memory.mjs context`.

## 1.0.20 — 2026-11-18

- Docs, README, AGENTS.md and the website synced with the source; the template audit gained a docs-drift check
  (`npm run audit`).

## 1.0.19 — 2026-11-18

- **Strict test isolation:** only `lead-qa` may create or change test files; a test file touched by `lead-dev` is
  reverted as a scope violation.
- **Two-phase root-cause fixing** for bug fixes (`visible.mjs brief --bugfix`): Symptom / Root Cause / Blast Radius
  before editing; an anti-cheat diff audit flags skipped tests, empty `catch` blocks and weakened assertions.

## 1.0.18 — 2026-11-18

- Eleven fixes from Skill Foundry feedback: memory, Windows process-tree kill, junctions and hooks, glob scopes,
  backlog priority 0, and a notice when a paid API key is set in the shell.

Older versions: see `git log` on the `release` branch.
