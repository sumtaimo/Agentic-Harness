# AGENTS.md — instructions for any AI working in this folder

This project contains an **Agentic Harness** in `.harness/`. It is a background controller that
runs AI coding agents (Claude Code, Antigravity, Orca, Gemini, Codex) in a checked loop:

```
1_PLANNER → 2_EXECUTOR_SWARM → 3_VERIFIER → 4_COMMITTED
      ↑______ verifier error fed back (max 3 cycles) ______|   then HALTED_HITL_REQUIRED
```

It also holds the user's **memory** (`.harness/memory/`). This file is the single source of
truth; `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md` and `.cursor/rules/harness.mdc`
only point here.

---

## 0. Are you a harness worker?

If your prompt starts with `[HARNESS WORKER ID: …]` you were started BY the harness.
Do the task in that prompt directly, stay inside your scoped files, and **never** run
`.harness/dispatch.mjs` (it will refuse anyway). Skip the rest of this file except section 2.

---

## 1. At the start of every conversation

1. Read `.harness/memory/profile.md` (who the user is, how they want answers).
2. Read `.harness/memory/lessons.md` — rules the user taught. **These override your defaults.**
3. Skim the last entries of `.harness/memory/auto-lessons.md` (mistakes made before in this project).
4. If `profile.md` still contains `(fill me)`, ask the user those questions — a few at a time,
   in simple words — and write the answers into `profile.md`.

## 2. Learning from the user (the "memory" rules)

- When the user **corrects you, states a preference, or approves a way of working**, save it:
  ```bash
  node .harness/memory.mjs remember "<one clear sentence, written as a rule>"
  ```
  Then tell them in one line: *"I'll remember: …"*. Write rules, not stories
  (good: "Explain every change in plain English before showing code").
- If a saved rule is wrong or outdated, remove it: `node .harness/memory.mjs forget L3`.
- **Never** store passwords, API keys, tokens or private personal data in memory.
- Memory is plain Markdown. It does not train or change any AI model; it works because every
  AI re-reads it (you via this file, harness workers via their prompt).

## 3. How to talk to this user

Assume the user may not be a programmer unless `profile.md` says otherwise:
- Explain what you will do and why, in plain language, before doing it.
- Give one command at a time and say what it does. Prefer VS Code tasks over terminal commands.
- Report results honestly: what changed, how it was checked, what is still unknown.
- Ask before anything risky or hard to undo (deleting files, pushing to GitHub, installing
  global software, changing `.harness/config.json`).

## 4. Running work through the harness

Use the harness when the user says "run it in the harness / in the background", when a task
should be checked automatically, or when it can be split across parallel workers.

Check it is ready: `node .harness/doctor.mjs` · current state: `node .harness/status.mjs`

**One worker** (most tasks):
```bash
node .harness/dispatch.mjs --goal "<clear instructions>" --files "path/a,path/b" --check "<command that exits 0 only when the work is right>" --wait
```

**AI planner** (let an AI split the goal into parallel workers with separate files; add
`--files "src/"` to limit which files it may hand out):
```bash
node .harness/dispatch.mjs --goal "<clear instructions, incl. names/interfaces that must match>" --auto-plan --wait
```

**Swarm by hand** (independent parts in parallel — every worker must own *different* files,
otherwise the plan is rejected before anything runs):
```bash
node .harness/dispatch.mjs "<title>" --check "npm test" \
  --worker "api:src/api.ts:Implement the endpoint" \
  --worker "tests:src/api.test.ts:Write tests for the endpoint" --wait
```

Rules for you when dispatching:
- **Make sure there is a real check.** Without `--check`, the harness picks one from
  `package.json` (`check` > `typecheck`+`test` > `build` > `lint`). If dispatch prints
  "NO real check", the verifier passes anything: tell the user, and propose a test or `--check`.
- `--files` limits what a worker may change, and lets the harness **back those files up and
  restore them if the task fails**. With no files and no `--auto-plan`, there is no automatic
  undo. With `useGitWorktrees: true` the scope is strictly enforced (out-of-scope edits are
  discarded); otherwise it is an instruction plus the backup.
- The AI planner's suggested check is only recorded, never run. Review it with the user before
  using it as `--check`.
- After `--wait` finishes, read the session note it prints (`.harness/memory/sessions/…`) and
  explain the outcome to the user in plain words.
- On `HALTED_HITL_REQUIRED` or `REJECTED`: do **not** silently retry. The scoped files have
  already been restored. Explain the last error (from the session note, or
  `.harness/failed/<id>-<time>.trace.txt`) and ask the user what to do.

## 5. Map of the harness

| Path | What it is |
|---|---|
| `.harness/daemon.mjs` | the controller + live screen (HUD) |
| `.harness/dispatch.mjs` | put a job in the inbox (`--help` for options) |
| `.harness/memory.mjs` | remember / list / forget / context / sessions |
| `.harness/doctor.mjs` · `status.mjs` | setup check · current state |
| `.harness/config.json` | engines, max cycles, timeouts, worktrees, auto git commit |
| `.harness/memory/` | `profile.md`, `lessons.md` (committed); `auto-lessons.md`, `sessions/` (git-ignored) |
| `.harness/inbox/` → `completed/` or `failed/` | job files (`failed/` also has `.trace.txt`) |
| `.harness/staging/` | backups of scoped files while a task runs (restored on failure) |
| `.harness/state.json` · `telemetry.log` | live state · JSONL event log |
| `.vscode/tasks.json` | buttons for the user (Run Task menu) |

Engines marked `"verified": false` in `config.json` have command-line flags that were not tested
against the real tool. `node .harness/doctor.mjs` probes `<tool> --help` and lists missing flags.
An engine that is missing or fails the probe is replaced by `auto` (logged as `ENGINE_FALLBACK`).
To fix one, read its `"note"`, run `<tool> --help`, and propose the change to the user before
editing the config.
