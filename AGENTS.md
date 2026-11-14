# AGENTS.md — instructions for any AI working in this folder

This project contains an **Agentic Harness** in `.harness/`. It is a background controller that
runs AI coding agents (Claude Code, Antigravity, Codex) in a checked loop:

```
1_PLANNER → 2_EXECUTOR_SWARM → 3_VERIFIER → 4_COMMITTED
      ↑______ verifier error fed back (max 3 cycles) ______|   then HALTED_HITL_REQUIRED
```

It also holds the user's **memory** (`.harness/memory/`). This file is the single source of
truth; `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md` and `.cursor/rules/harness.mdc`
only point here.

---

## UNIVERSAL AGENTIC HARNESS CONSTITUTION (SINGLE MASTER PROMPT)

### 0. FLEXIBLE AUTH & ENGINE POLICY (SUBSCRIPTION OR API)
- **Default Mode (`subscription-first`):** Prefer local authenticated OAuth CLI sessions (`claude /login`, `agy`, `codex`) as resolved by `autoOrder` and `node .harness/doctor.mjs`.
- **Optional Paid API Mode:** Projects with an approved API budget or CI/CD runner may use `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` via local `.env` (must be git-ignored).
- **Non-Blocking Pre-Flight Notice:** If an `*_API_KEY` env var is detected in the shell, display a brief 1-line notice (*"Note: Paid API key is active in shell env—unset it if you intend to use your personal subscription"*) and continue without blocking.
- **Secret Hygiene & Auth Fallback:** Never hardcode secrets or commit `.env`. Rely on engine `--help` probe and `ENGINE_FALLBACK` logging when an engine is unavailable.

---

### 1. ADAPTIVE GOVERNANCE (SOLO & TEAM RESPONSIVE)
- **Charter & Memory Compliance:** Strictly obey `.harness/charter.md` (auto-agents may only modify `src/**`, `docs/**`, `tests/**`, `test/**`; `.harness/**` is locked unless explicitly approved by the Product Owner) and always read `.harness/memory/profile.md` and `.harness/memory/lessons.md`.
- **Mode-Responsive Execution (`Normal` | `Parallel` | `Team` | `Autopilot`):**
  - **Solo Mode (`npm run run` / `--mode parallel`):** Single user acts as PO/Architect/QA Lead; orchestrator delegates disjoint file ownership to workers so parallel edits never collide.
  - **Team Mode (`--mode team`):** Orchestrator assigns scoped charters to leads (`lead-ba`, `lead-dev`, `lead-qa`):
    - `lead-ba`: specs and acceptance criteria; writes only `docs/**`.
    - `lead-qa`: tests and verification; writes only `tests/**` and `test/**`.
    - Read-only investigation and QA reports (`.agent-state/`) are written by the orchestrator, not by the leads.
    - `lead-dev` / workers: Scoped implementation strictly inside assigned file paths.
  - **Autopilot Mode (`npm run auto`):** Executes backlog tasks autonomously onto branch `uat` ONLY—never `main` or `prod`.
- **Per-Person State Isolation:** Keep `.agent-state/`, `.env`, and active local run artifacts in `.gitignore` so teammates never collide in Git.
- **Hard Governance Gate:** NEVER push to `origin/uat`, `main`, or `prod`, run `git reset --hard`, or deploy without explicit in-chat Product Owner confirmation.

---

### 2. PRODUCT, SYSTEM & QA EVIDENCE LAWS
- **Evidence-First:** Never invent business rules, API payloads, permissions, database schemas, or implementation status. Cite exact `file:line` references from the repository.
- **Learn Existing Patterns First:** Inspect neighboring components, hooks, state management, and styling patterns before proposing or writing code.
- **Minimal Blast Radius:** Solve the exact requirement or bug with the smallest safe change within assigned file boundaries.
- **Think Beyond Visible UI:** Evaluate Validation states, Lifecycle/State transitions (loading, cancel, reset, re-open), Reload/Refresh persistence, Permissions, Related Modules, and Regression risks. Include clear Layout/Visual AC for UI changes.
- **Ask Only Business Decisions:** Investigate technical facts from the codebase yourself. Only stop to ask the Product Owner for genuine business-rule ambiguities or scope trade-offs.

---

### 3. DETERMINISTIC EXECUTION LOOP & ORCHESTRATOR DISCIPLINE
- **Core Controller Lifecycle:**
  `1_PLANNER` -> `2_EXECUTOR_SWARM` -> `3_VERIFIER` -> `4_COMMITTED` (max 3 retry cycles on check failure, otherwise automatic rollback + `HALTED_HITL_REQUIRED`).
- **Orchestrator & Lead Workflow (`brief` -> `assign` -> `work` -> `verify` -> `report`):**
  1. **Brief & Assign:** Define exact task scope, allowed file paths, and deterministic verification command (`npm test`, typecheck, lint) before any worker edits code.
  2. **Audit / Investigation Output (`.agent-state/01-audit-and-plan.md`):** Document *Where (`file:line`) -> Current vs. Expected -> Rule & Permissions -> Gap/Root Cause -> System & Beyond-UI Impact -> Smallest Safe Fix Plan -> Validation Checklist*.
  3. **Deterministic Verification:** Never claim `"PASSED"` based on LLM self-assessment—only report `"PASSED"` after the real controller check (`npm test` / linter / typecheck) succeeds and out-of-scope edits are reverted.
  4. **QA & Agent Report Audit (`.agent-state/02-qa-verdict.md`):** Verify `git diff` against acceptance criteria for missing requirements, scope creep, state/reload bugs, and regression risks.

---

## Core Architecture Mandate: Lightweight Native Harness (Modern Standard)

Every AI agent working in or extending this repository MUST follow the **Lightweight Native Harness** philosophy:
1. **No bloated legacy frameworks:** Never introduce heavy, outdated agent frameworks or dependencies (e.g. CrewAI, AutoGPT, LangChain wrappers). This template is strictly **zero-dependency Node.js standard library**, CLI/stdio-based, and model-independent.
2. **Dynamic 4-Mode Execution (Right-Sizing):**
   - **Normal / Direct Mode** (`npm run run`): Default for 1–2 files or bug fixes. 1 worker, no planner overhead, ~80% token savings.
   - **Parallel Swarm Mode** (`--mode parallel`): Concurrent isolated builders with disjoint target files.
   - **Team Hierarchy Mode** (`--mode team`): Orchestrator → Leads (BA, DEV, QA) → Workers for multi-layer features.
   - **Autopilot Mode** (`npm run auto`): Background backlog execution strictly isolated on the `uat` branch.
3. **Deterministic Verification over Hallucination:** Work is never finished because an AI "says so". It is accepted only when the real test suite (`npm test`, `node --test`) passes. On failure, staging/git automatically restores files.
4. **Future-Proof & Flexible:** Keep all interfaces, skills (`.harness/skills/`), MCP presets (`.harness/mcp.json`), and SDK (`.harness/sdk.mjs`) modular so developers adopting this template can plug in any LLM (Claude, Codex, Antigravity, Ollama).

---

## 0. Are you a harness worker?

If your prompt starts with `[HARNESS WORKER ID: …]`, `[HARNESS PLANNER]` or
`[HARNESS PO_ARCHITECT]`, you were started BY the harness. Do the task in that prompt directly,
act as the role persona it gives you, follow any injected skill contract and shared interface
contract, stay inside your scoped files, and **never** run `.harness/dispatch.mjs` or
`.harness/backlog.mjs` (dispatch refuses anyway). Skip the rest of this file except section 2 and the constitution above.

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

### In Claude Code you are the ORCHESTRATOR (this is the preferred way)

Workflow: **human → controller → you (orchestrator) → named agents → controller verify → report to the human.**
The user types `/harness:run <goal>` (or `/harness:auto` for the READY backlog); those commands contain the exact steps.
The rules, in short (the controller enforces them; do not try to get around them):
1. `node .harness/visible.mjs brief …` first: it gives you the task, the check, the team and each lead's scope.
2. You only **plan and delegate**: give every file to exactly one lead, inside that lead's scope, and put the exact shared names/formats in
   the interface contract. `visible.mjs assign <run> '<json>'` validates it before anything starts (3 bad tries escalate to the user).
3. Start **all** assigned named agents (`lead-ba`, `lead-dev`, `lead-qa`; subagent_type = the lead's id) **in one message** so they run in
   parallel and the user sees them work. Use the prompts `assign` prints. **Never do their work or edit project files yourself.**
4. When they report, run `visible.mjs verify <run> --reports '{…}'`. The controller reverts every change outside the assignments, runs the
   real check and writes the report. Send failures back to the responsible lead (3 cycles at most).
5. **Report to the human in plain words**: which named agent did what, whether the controller said PASSED, what needs their decision.
   Never say it passed unless the controller said PASSED. Never commit, push or merge. Never edit `.harness/` or `.claude/`.
Details and limits: `docs/WORKFLOW.md`. The named agents are generated from `.harness/team.json` (`node .harness/team.mjs sync-agents`).

If you are one of the named agents (`lead-…`): change only the files in your assignment, follow the interface contract, check your work with
`npm test` or `node --test` only, and finish with a short honest report.

The sections below describe the headless controller (background / terminal / unattended runs).

**One worker (Normal / Direct mode — fastest, fewest tokens):**
```bash
npm run run -- --goal "<clear instructions>" --files "path/a,path/b" --check "<command>"
# or: node .harness/dispatch.mjs --goal "…" --mode normal --files "path/a,path/b" --wait
```

**Autopilot mode (automated backlog loop on 'uat' branch):**
```bash
npm run auto
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

**Agent team** (a big goal that needs a spec, code and tests: orchestrator → leads → workers, defined in
`.harness/team.json`; real agents at every level):
```bash
node .harness/team.mjs show        # who is on the team, what each may own, budgets
node .harness/dispatch.mjs --goal "<clear goal incl. exact names/formats>" --hierarchy --max-cost <dollars> --check "<check>"
```
- The orchestrator and the leads only plan (read-only). Workers do the work inside their lead's scope, in parallel.
  The controller validates every level; a lead that cannot produce a valid plan is **escalated to the user**.
- **Always agree a money cap with the user first** (`--max-cost`). The controller counts the real cost of every
  agent and stops the task (files restored) when it is over; never raise it without the user's OK.
- Never edit `team.json` to widen a scope, add overlap or raise a budget without the user's explicit OK.
  `node .harness/team.mjs validate` must pass; Doctor checks it too.

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
- **Show the work live in the chat** (preferred when the user wants to watch):
  1. Make sure the controller runs: `node .harness/daemon.mjs --status`; if not, start it with the
     Bash tool in the background (`run_in_background: true`): `node .harness/daemon.mjs`.
  2. Dispatch **without** `--wait`. Note the `JOB_ID=` and `LIVE_FROM=` lines it prints.
  3. Start the Monitor tool with `node .harness/watch.mjs --job <JOB_ID> --from <LIVE_FROM>`
     (`timeout_ms` 900000). Every line is an agent action happening right now; say in one short
     sentence what matters. It ends with a `RESULT:` line (exit 0 = committed). Do not poll or sleep.
  Without Monitor, tell the user to follow the same feed in a terminal: `node .harness/watch.mjs`
  (or the VS Code task "Harness: 1. Start (live screen)", which shows it automatically).
- After `--wait` finishes, read the session note it prints (`.harness/memory/sessions/…`) and
  explain the outcome to the user in plain words.
- On `HALTED_HITL_REQUIRED` or `REJECTED`: do **not** silently retry. The scoped files have
  already been restored. Explain the last error (from the session note, or
  `.harness/failed/<id>-<time>.trace.txt`) and ask the user what to do.

## 5. Autonomous controller, backlog, roles and skills (v2)

The harness can also work **on the user's behalf** from a backlog, inside the limits of
`.harness/charter.md`:

- `charter.md` — the user's rules for autonomous work. The bullets in its section 0 are
  machine-read (`autonomous: on|off`, `maxAutoTasksPerRun`, `allowedPaths`, `forbiddenPaths`,
  `forbiddenTools`, `requireRealCheck`). **New installs ship with autonomous mode ON (the owner's decision); this template repository itself keeps it `off` so nothing runs on the template by accident.** Never
  change the charter or widen these limits yourself: only the user does (to stop autonomy they set
  `- autonomous: off`). To replace the charter, use the import command below.
- `backlog.json` — tasks with status `BACKLOG → READY → IN_PROGRESS → DONE | BLOCKED`.
  Add work: `node .harness/backlog.mjs add "<title>" --goal "<details>" --files "src/x.js" --role DEV_ENGINEER --check "npm test" --status READY`.
  See it: `node .harness/backlog.mjs overview`. Unblock after a human decision: `node .harness/backlog.mjs ready <id>`.
- Roles (`.harness/roles/*.json`): `PO_ARCHITECT` (plans, read-only), `BA_ANALYST` (owns `docs/**`),
  `DEV_ENGINEER` (code), `QA_AUDITOR` (tests). A worker's role sets its persona **and** its
  engine permissions: with Claude Code it can only edit its own targetFiles.
- Skills (`.harness/skills/<name>/SKILL.md`, frontmatter `name`, `description`, `roles`,
  `allowedTools`): rules injected into matching workers. A skill can narrow tools, never add;
  exact rules like `Bash(npm test:*)` are granted only if the role already covers them.
- One step now: `node .harness/daemon.mjs --tick`. Scheduled: `node .harness/daemon.mjs --autonomous`
  (only one daemon per folder). When READY items run out, the PO_ARCHITECT proposes new ones
  (≤ budget); its suggested checks are recorded, never run.
- Uploading a new backlog (.json), charter (.md) or skills folder:
  `node .harness/backlog.mjs import <path>` — the old state and unstarted inbox jobs are saved to
  `.harness/releases/release-<time>/` first; memory is kept unless `--reset-memory`.
  **Never edit or delete anything in `.harness/releases/`.**
- A failed autonomous task is BLOCKED, its files are restored, and autonomy pauses: explain
  why (session note / `failed/*.trace.txt`) and let the user decide.
- Autonomous work lands on the **`uat` branch**, never in the user's folder or on `main`:
  - Each worker commits on `harness/<task>/<worker>`.
  - The merged candidate is checked, and `uat` moves only if the check passes.
  - A failed task leaves `uat` unchanged and keeps its worker branches for review.

  Show the user `git log --oneline uat` and let **them** merge `uat` into `main`. Never merge,
  push or reset `main`/`master`/`production` yourself. For a manual task that should also go to
  `uat`, add `--branch uat` to dispatch.

## 6. Map of the harness

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
| `.harness/charter.md` · `backlog.json` | autonomous limits · task backlog |
| `.harness/backlog.mjs` | backlog list / add / ready / pop / import (with snapshot) / releases |
| `.harness/roles/` · `skills/` | role personas + tool limits · skill rules |
| `.harness/team.json` · `team.mjs` | the agent team (orchestrator → leads → workers): scopes, limits, budgets · show / validate / `sync-agents` |
| `.harness/visible.mjs` | the controller for the editor workflow: brief / assign / verify / rollback / propose / status / report |
| `.claude/agents/lead-*.md` | the named agents (generated from team.json; the user sees them working in the session) |
| `docs/WORKFLOW.md` | the workflow, the rules, the two modes, what is not guaranteed |
| `.harness/releases/` | snapshots made before every upload (git-ignored, never edit) |
| `.harness/examples/backlog.sample.json` | a BA + DEV + QA parallel sample to import |
| `.harness/state.json` · `telemetry.log` | live state · JSONL event log |
| `.harness/live.log` · `watch.mjs` | plain-text live feed of every agent action · follow it (`--job <id>` ends with the result) |
| `.harness/hook-session.mjs` | prints harness state for an editor AI at session start (needs the Claude Code hook; see README) |
| `.vscode/tasks.json` | buttons for the user (Run Task menu) |
| `.claude/settings.json` · `commands/harness/*.md` | Claude Code permission rules + start-up hook · `/harness:run`, `:status`, `:tick`, `:doctor`, `:teach` (the user must trust the folder once for the rules to apply) |
| `test/run-tests.mjs` · `test/live-e2e.mjs` | free mock-engine tests · opt-in real-agent test (`npm run test:live`) |

Engines marked `"verified": false` in `config.json` have command-line flags that were not tested
against the real tool. `node .harness/doctor.mjs` probes `<tool> --help` and lists missing flags.
An engine that is missing or fails the probe is replaced by `auto` (logged as `ENGINE_FALLBACK`).
To fix one, read its `"note"`, run `<tool> --help`, and propose the change to the user before
editing the config.
