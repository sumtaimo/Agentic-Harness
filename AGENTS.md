# AGENTS.md — instructions for any AI working in this folder

This project contains an **Agentic Harness** in `.harness/`. It is a background controller that
runs AI coding agents (Claude Code, Antigravity, Codex) in a checked loop:

```
1_PLANNER → 2_EXECUTOR_SWARM → 3_VERIFIER → 4_COMMITTED
      ↑______ verifier error fed back (max 3 cycles) ______|   then HALTED_HITL_REQUIRED
```

It also holds the user's **memory** (`.harness/memory/`). This file is the single source of
truth; `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursor/rules/harness.mdc`,
and `.windsurfrules` only point here.

### Using the harness vs. maintaining it (read this first)

- **In a project that uses the harness** (it has `.harness/MANIFEST.json`): you USE the harness. Never edit its core code
  (`.harness/*.mjs`, `.harness/lib/**`, `.harness/MANIFEST.json`); Claude Code blocks it and `doctor` flags any change.
  The project's own settings are fine to change with the user's OK: `config.json`, `charter.md`, `team.json`, `roles/`,
  `skills/`, `backlog.json`, `memory/`. If you find a bug or gap in the harness itself, do NOT patch it here: tell the user,
  and describe it for the template (see `docs/MAINTAINING.md`, "Reporting a gap"). The fix arrives by re-installing.
- **In the template repository itself** (it has `install.mjs` and `docs/MAINTAINING.md`): you MAINTAIN the harness. Its
  `lab` branch is the LAB (built and tried for real here); the `release` branch is the TEMPLATE users install and the
  landing page shows. Follow `docs/MAINTAINING.md`: every change passes `npm test` and `npm run audit`; the owner decides
  each push, and only the owner's "release" copies `lab` to `release`. A change to what the skill library reads or
  provides (skills, skill pointers, roles, the skill capability flags, how `install.mjs` calls it, `skillFetch`) is
  risk-checked with the skill library's maintainers before it ships; when the owner mentions the skill library, read the
  owner's local coordination notes first.

---

## UNIVERSAL AGENTIC HARNESS CONSTITUTION (SINGLE MASTER PROMPT)

### 0. FLEXIBLE AUTH & ENGINE POLICY (SUBSCRIPTION OR API)
- **Default Mode (`subscription-first`):** Prefer local authenticated OAuth CLI sessions (`claude /login`, `agy`, `codex`) as resolved by `autoOrder` and `node .harness/doctor.mjs`.
- **Optional Paid API Mode:** Projects with an approved API budget or CI/CD runner may use `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` via local `.env` (must be git-ignored).
- **Non-Blocking Pre-Flight Notice:** If an `*_API_KEY` env var is detected in the shell, display a brief 1-line notice (*"Note: Paid API key is active in shell env—unset it if you intend to use your personal subscription"*) and continue without blocking.
- **Secret Hygiene & Auth Fallback:** Never hardcode secrets or commit `.env`. Rely on engine `--help` probe and `ENGINE_FALLBACK` logging when an engine is unavailable.

---

### 1. ADAPTIVE GOVERNANCE (SOLO & TEAM RESPONSIVE)
- **Charter & Memory Compliance:** Strictly obey `.harness/charter.md` (auto-agents may only modify `src/**`, `docs/**`, `tests/**`, `test/**`, `__tests__/**`; `.harness/**` is locked unless explicitly approved by the Product Owner) and always read `.harness/memory/profile.md` and `.harness/memory/lessons.md`.
- **Mode-Responsive Execution (`Normal` | `Parallel` | `Team` | `Autopilot`):**
  - **Solo Mode (`npm run run` / `--mode parallel`):** Single user acts as PO/Architect/QA Lead; orchestrator delegates disjoint file ownership to workers so parallel edits never collide.
  <!-- docs-drift:ignore -->
  - **Team Mode (`--mode team`):** Orchestrator assigns scoped charters to leads (`lead-ba`, `lead-dev`, `lead-qa`, `lead-ux`):
    - `lead-ba`: specs and acceptance criteria; writes only `docs/**`.
    - `lead-qa`: tests and verification; writes only `tests/**`, `test/**`, `__tests__/**` and test files next to the code (`src/**/*.test.*`, `*.spec.*`).
    - `lead-ux`: UX/UI; writes only style files (`src/**/*.css`, `*.scss`, `*.less`) and UX flow/copy/wireframe specs (`docs/ux/**/*.md`), with the `ui-craft` and `brand-craft` rules.
    - `reviewer` and `security`: read-only check agents the orchestrator starts after the controller says PASSED (code changes only); they report findings, never edit.
    - Read-only investigation and QA reports (`.agent-state/`) are written by the orchestrator, not by the leads.
    - `lead-dev` / workers: Scoped implementation strictly inside assigned file paths; in team/hierarchy/visible runs, never create, edit, or delete test files (`tests/**`, `test/**`, `__tests__/**`, `*.test.*`, `*.spec.*`).
  - **Autopilot Mode (`npm run auto`):** Executes backlog tasks autonomously onto branch `uat` ONLY—never `main` or `prod`.
- **Per-Person State Isolation:** Keep `.agent-state/`, `.env`, and active local run artifacts in `.gitignore` so teammates never collide in Git.
- **Hard Governance Gate:** NEVER push to `origin/uat`, `main`, or `prod`, run `git reset --hard`, or deploy without explicit in-chat Product Owner confirmation.

---

### 2. PRODUCT, SYSTEM & QA EVIDENCE LAWS
- **Evidence-First:** Never invent business rules, API payloads, permissions, database schemas, or implementation status. Cite exact `file:line` references from the repository.
- **Learn Existing Patterns First:** Inspect neighboring components, hooks, state management, and styling patterns before proposing or writing code.
- **Minimal Blast Radius:** Solve the exact requirement or bug with the smallest safe change within assigned file boundaries.
- **Two-Phase Root-Cause & Anti-Cheating (Bug Fixes):** Investigate read-only first and document `Symptom / Root Cause / Blast Radius` before editing; fix the root cause cleanly. Hardcoding returns, special-case test `if` hacks, disabling validation, weakening/skipping tests, or swallowing errors (`catch` ignore) to force exit `0` are strictly prohibited.
- **Think Beyond Visible UI:** Evaluate Validation states, Lifecycle/State transitions (loading, cancel, reset, re-open), Reload/Refresh persistence, Permissions, Related Modules, and Regression risks. Include clear Layout/Visual AC for UI changes.
- **Ask Only Business Decisions:** Investigate technical facts from the codebase yourself. Only stop to ask the Product Owner for genuine business-rule ambiguities or scope trade-offs.

---

### 3. DETERMINISTIC EXECUTION LOOP & ORCHESTRATOR DISCIPLINE
- **Core Controller Lifecycle:**
  `1_PLANNER` -> `2_EXECUTOR_SWARM` -> `3_VERIFIER` -> `4_COMMITTED` (max 3 retry cycles on check failure, otherwise automatic rollback + `HALTED_HITL_REQUIRED`).
- **Orchestrator & Lead Workflow (`brief` -> `assign` -> `work` -> `verify` -> `report`):**
  <!-- docs-drift:ignore -->
  1. **Brief & Assign:** Define exact task scope, allowed file paths, and deterministic verification command (`npm test`, typecheck, lint) before any worker edits code. On bug fixes, keep test files isolated to `lead-qa` and either run Red-Green sequencing — assign `lead-qa` and `lead-dev` in one `assign` call (run `lead-qa` first [Red] to confirm the bug test fails before running `lead-dev` [Green], then run `visible.mjs verify`), or run two separate `brief` runs (a Red reproduction run first, then a Green fix run), because `visible.mjs verify` transitions the run to `FAILED` which blocks calling `assign` again on the same `RUN_ID` — or require `lead-dev` to report `Symptom / Root Cause / Blast Radius`.
  2. **Audit / Investigation Output (`.agent-state/01-audit-and-plan.md`):** Document *Where (`file:line`) -> Current vs. Expected -> Rule & Permissions -> Gap/Root Cause -> System & Beyond-UI Impact -> Smallest Safe Fix Plan -> Validation Checklist*.
  3. **Deterministic Verification:** Never claim `"PASSED"` based on LLM self-assessment—only report `"PASSED"` after the real controller check (`npm test` / linter / typecheck) succeeds, `scanPatchSafety` finds no newly introduced secrets/credentials (reported `(redacted)` only) or unresolved merge conflict markers, and out-of-scope edits are reverted. Failed checks receive deterministic `[FAILURE DIAGNOSIS]` / `[REPEAT FAILURE]` triage.
  4. **QA & Agent Report Audit (`.agent-state/02-qa-verdict.md`):** Verify `git diff` against acceptance criteria for missing requirements, scope creep, state/reload bugs, and regression risks; for bug fixes, enforce Adversarial Fail-First QA and a Root-Cause & Anti-Cheating Diff Audit (`reviewer` rejects fixes lacking a clear Root-Cause explanation or relying on hacks/weakened tests).

---

## Core Architecture Mandate: Lightweight Native Harness (Modern Standard)

Every AI agent working in or extending this repository MUST follow the **Lightweight Native Harness** philosophy:
1. **No bloated legacy frameworks:** Never introduce heavy, outdated agent frameworks or dependencies (e.g. CrewAI, AutoGPT, LangChain wrappers). This template is strictly **zero-dependency Node.js standard library**, CLI/stdio-based, and model-independent.
2. **Dynamic 4-Mode Execution (Right-Sizing):**
   - **Normal / Direct Mode** (`npm run run`): Default for 1–2 files or bug fixes. 1 worker, no planner overhead, ~80% token savings.
   - **Parallel Swarm Mode** (`--mode parallel`): Concurrent isolated builders with disjoint target files.
   - **Team Hierarchy Mode** (`--mode team`): Orchestrator → Leads (BA, DEV, QA, UX) → Workers for multi-layer features.
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

## 1. At the start of every conversation (editor, terminal CLI, or cloud)

1. Read `.harness/memory/profile.md` (the shared project profile) and, if it exists, `.harness/memory/me.md` (the person at
   this machine: name, language, answer style, hats; git-ignored, one per person). `me.md` wins over `profile.md`.
   **Hats** (`po`, `ba`, `ux`, `dev`, `qa`, combinable) shape how you talk to that person and what you check first; they
   are not AI roles (`team.json`) and never change any scope, approval or permission. Personal skills listed in `me.md`
   are for the chat AI only, never for harness workers.
2. Read `.harness/memory/lessons.md` — permanent rules the user taught (git-tracked). **These override your defaults.**
3. Skim `.harness/memory/auto-lessons.md` (git-ignored mistakes, retry recoveries, scope violations, and local technical lessons recorded by the harness or via `learn`), or retrieve task-ranked entries with `node .harness/memory.mjs context --goal "<task>" --files "<paths>"`.
4. If the session start says there is no personal profile (or that `profile.md` belongs to someone else), ask the user
   a few at a time, in simple words: name, language, coding experience, how they like answers, and their hats. Save them
   with `node .harness/memory.mjs me set --name "…" --language "…" --experience "…" --style "…" --hats "po,qa"`.
   Never write one person's preferences into the shared `profile.md`: it describes only the project. When the session
   start says an older `profile.md` still holds personal lines, offer `node .harness/memory.mjs me from-profile` (it
   moves them into `me.md`; ask first, because it edits the shared file).
5. **The team page** `.harness/memory/people.md` (committed) lists what each person chose to share: name, hats, what to
   ask them about, languages for handoffs, git name. Session start shows it as "Decisions by hat". When a decision needs
   a hat the current person does not wear (for example a scope decision needs `po`), say who on the team page to ask.
   A person adds or updates only their own section with `node .harness/memory.mjs me share [--ask "…"] [--language] [--git]`
   (offer it; never share for them). It never holds answer style, experience, personal skills or contact details.

6. **Product foundation** (`docs/foundation/product.md`, `domain.md`, `brand.md`): the *why* (users, business rules, states,
   permissions, brand feel, anti-patterns). Read them **by task, not at session start**: `brand.md` + `product.md` for UI/UX work;
   `product.md` + `domain.md` for features and business logic. Never paste whole files into prompts or import them into
   `CLAUDE.md`. A line that still says `(fill me)` is unknown: never invent it. For a feature or UI task whose relevant
   fields are blank, ask at most 3 short questions (the user may answer "skip"); for bug fixes, typos and routine chores,
   do not ask. Details: `docs/WORKFLOW.md`, "Product foundation and the intake question".

## 2. Learning from mistakes and from the user (the "memory" rules)

- When the user **corrects you, states a preference, or approves a way of working** that should apply across machines and teammates, save a permanent rule (`lessons.md`):
  ```bash
  node .harness/memory.mjs remember "<one clear sentence, written as a rule>"
  ```
  Then tell them in one line: *"I'll remember: …"*. Write rules, not stories
  (good: "Explain every change in plain English before showing code").
- When **you or the user** in any session (editor chat, terminal CLI, or cloud) discover and fix a **local or technical mistake/gotcha** that shouldn't happen again without cluttering shared `lessons.md`, save a local auto-lesson (`auto-lessons.md`, git-ignored):
  ```bash
  node .harness/memory.mjs learn "<one clear technical rule or pitfall>"
  ```
  If a local lesson proves valuable for everyone on the repo, promote it with `node .harness/memory.mjs promote <id>` (e.g. `L2`).
- Retrieve relevant rules and task-ranked `auto-lessons.md` before non-trivial work via `node .harness/memory.mjs context --goal "<task>" --files "<paths>"`.
- If a saved rule is wrong or outdated, remove it: `node .harness/memory.mjs forget L3` (or `forget-auto L2`).
- **Never** store passwords, API keys, tokens or private personal data in memory or source diffs (`scanPatchSafety` blocks newly introduced secrets and merge conflict markers).
- Memory is plain Markdown. It does not train or change any AI model; it works because every
  AI re-reads it (orchestrators/chats via this file and its 5 aligned rule pointers, harness workers via task-ranked prompt injection).

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

Check it is ready: `node .harness/doctor.mjs` · current state: `node .harness/status.mjs` · interactive menu: `npm start` (`node .harness/start.mjs`, `--summary` for overview only).

### In Claude Code you are the ORCHESTRATOR (this is the preferred way)

Workflow: **human → controller → you (orchestrator) → named agents → controller verify → report to the human.**
The user types `/harness:run <goal>` (or `/harness:auto` for the READY backlog); those commands contain the exact steps.
The rules, in short (the controller enforces them; do not try to get around them):
0. For feature or UI/UX work (skip without a word on bugfixes/chores): read relevant `docs/foundation/` files (`product.md` + `brand.md` for UI/UX; `product.md` + `domain.md` for features), ask at most 3 skippable questions for blanks still marked `(fill me)`, and pass existing foundation files to leads by reference ("First read …") — never paste whole files.
1. `node .harness/visible.mjs brief …` first: it gives you the task, the check, the team and each lead's scope.
<!-- docs-drift:ignore -->
2. You only **plan and delegate**: give every file to exactly one lead, inside that lead's scope (`docs/ux/**/*.md` + styles belong to `lead-ux` with `ui-craft` + `brand-craft`; test files `tests/**`, `test/**`, `__tests__/**`, `*.test.*`, `*.spec.*` belong strictly to `lead-qa`, never `lead-dev`), and put the exact shared names/formats in
   the interface contract. `visible.mjs assign <run> '<json>'` validates it before anything starts (3 bad tries escalate to the user).
3. Start **all** assigned named agents (`lead-ba`, `lead-dev`, `lead-qa`, `lead-ux`; subagent_type = the lead's id) **in one message** so they run in
   parallel and the user sees them work. Use the prompts `assign` prints. **Never do their work or edit project files yourself.**
   <!-- docs-drift:ignore -->
   On bug fixes, you may run Red-Green sequencing — either assign `lead-qa` and `lead-dev` in one `assign` call (run `lead-qa` first [Red] to confirm the bug test fails before running `lead-dev` [Green], then run `visible.mjs verify`) or run two separate `brief` runs (a Red reproduction run first, then a Green fix run), because `visible.mjs verify` transitions the run to `FAILED` which blocks calling `assign` again on the same `RUN_ID` — or require `lead-dev` to include `Symptom / Root Cause / Blast Radius` in its report (audited by `reviewer` after PASSED in `/harness:run`).
4. When they report, run `visible.mjs verify <run> --reports '{…}'`. The controller reverts every change outside the assignments, runs the
   real check and writes the report. Send failures back to the responsible lead (3 cycles at most).
4b. **Judge & visual gate (after PASSED when code/UI changed):** run read-only `reviewer` (`Done vs Good`: `intentFit`, `states`, `craft`, `doneVsGood`) and record its JSON verdict via `node .harness/visible.mjs judge <run> --agent reviewer --file <report>` (plus `security` when input/auth/files/network/secrets/deps are touched). When UI changed (`NEEDS A VISUAL REVIEW`), either attach post-change screenshots via `visible.mjs visual attach <run> --screenshot … --note "…"` and pass them to `reviewer`, OR have the human confirm (`visible.mjs visual confirm <run> --by "<name>"` — guarded by Claude Code's `ask` rule, or by an interactive terminal `[y/N]` prompt in other editors so an AI orchestrator cannot self-approve).
5. **Report to the human in plain words**: which named agent did what, whether the controller said PASSED, any `Done vs Good` / visual status, and what needs their decision.
   Never say it passed unless the controller said PASSED. Never commit, push or merge. Never edit `.harness/` or `.claude/`.
Details and limits: `docs/WORKFLOW.md`. The named agents are generated from `.harness/team.json` (`node .harness/team.mjs sync-agents`).

If you are one of the named agents (`lead-…`): change only the files in your assignment, follow the interface contract, check your work with
`npm test` or `node --test` only, and finish with a short honest report.

In **Antigravity, Cursor, or VS Code** (where `/harness:run` is not a built-in slash command): check live status at session start with `node .harness/hook-session.mjs --brief` (4–8 line summary) or `npm start` (`node .harness/start.mjs` interactive menu). For any multi-file, feature, or UI/design task, follow the same controller protocol (`docs/foundation/` intake → `node .harness/visible.mjs brief --editor antigravity ...` → `assign` with `lead-ux` for styles/`docs/ux/**/*.md` → parallel subagents → `verify` → `judge` `Done vs Good` + `visual attach` screenshots or human terminal `visual confirm`), or run the headless controller below when subagents are unavailable. **Big features and bug hunts work in these editors too** (no slash commands needed): `node .harness/feature.mjs "<goal>"` and `node .harness/hunt.mjs "<area>"` (or the VS Code buttons *Big feature* / *Bug hunt*) use whichever AI tool in `config.json` the person allowed (Claude, Antigravity or Codex). An editor agent can do the AI step itself: `node .harness/feature.mjs prompt F1` prints the exact prompt, give it to a read-only agent, save its JSON reply to a file, then `node .harness/feature.mjs expand F1 --from <file>` (same for `hunt.mjs prompt` / `run H1 --from <file>`). Keeping `--editor <name>` (e.g. `antigravity`, `cursor`, `vscode`) attributes session usage cleanly without colliding with headless CLI quotas.

**Stopping or switching sessions mid-run (cross-editor handoff & headless resume):**
- If an editor session stops, freezes, or hits a usage cap mid-run, inspect what is already on disk and print a continuation prompt:
  `node .harness/visible.mjs handoff [RUN_ID]` (add `--prompt` for raw prompt text, or `--json` for tooling).
- Or finish that same unfinished editor run directly in the headless controller (keeping partial edits, inheritance of contract/criteria/last error, and updating `.harness/visible/<run>/` on completion or failure):
  `node .harness/dispatch.mjs --resume-visible [RUN_ID] [--engine <tool>] --wait` (also available in `npm start` → `[1]`).
- For a `/harness:sessions` child task/worktree (`sessions.mjs`), save uncommitted WIP with `node .harness/sessions.mjs checkpoint <ID> [--message "…"]`, inspect progress and get a cross-engine handoff prompt with `node .harness/sessions.mjs handoff [ID] [--checkpoint] [--prompt|--json]`, or finish it headlessly inside the child worktree using `node .harness/dispatch.mjs --cwd <worktree> --goal "…" --wait` (also in `npm start` → `[5]`; `--cwd` cannot be combined with `--branch` or `--resume-visible`).

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
  `node .harness/team.mjs validate` must pass; Doctor checks it too. (On non-`src/` project layouts like `app/`, `cmd/`, or `styles/`, preview additive scope updates with `node .harness/team.mjs adapt-scopes` and ask the user before running `--apply`.)

Rules for you when dispatching:
- **AI tools need the person's OK once.** If dispatch exits with `ENGINE_APPROVAL_NEEDED`, tell the user which tools are
  installed but not allowed and ask them to run `node .harness/engines.mjs` themselves (it spends their quota). Never
  run `engines.mjs allow` for them without a clear yes for that tool.
- **Autopilot holds big runs.** A backlog item BLOCKED with "Needs your OK" waits for the user; run
  `node .harness/backlog.mjs approve <id>` only after they say yes for that item.
- **Big runs need the person's OK.** If dispatch exits with `APPROVAL_NEEDED` (code 3), show the user the reasons it
  printed (mode, number of workers, high-tier models) and ask in chat. Add `--yes` only after a clear yes for THAT run.
- **Make sure there is a real check.** Without `--check`, the harness auto-detects one from
  `package.json` (`check` > `typecheck`+`test` > `build` > `lint`), Node/TS workspaces (`npm`/`pnpm`/`yarn`/`bun`), Python (`pytest`/`unittest`), Go (`go test`), Rust (`cargo test`), PHP/Laravel (`artisan`/`composer test`/`phpunit`), or `Makefile` (`check`/`test`). If dispatch prints
  "NO real check", the verifier passes anything: tell the user, and propose a test or `--check`.
- `--files` limits what a worker may change, and lets the harness **back those files up and
  restore them if the task fails**. With no files and no `--auto-plan`, there is no automatic
  undo. With `useGitWorktrees: true` the scope is strictly enforced (out-of-scope edits are
  discarded); otherwise it is an instruction plus the backup, and new files created outside the assigned files are moved
  aside to `.harness/staging/<task>-out-of-scope/` (in a git repository; never deleted).
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
  `DEV_ENGINEER` (code), `QA_AUDITOR` (tests), `UX_DESIGNER` (style files and `docs/ux/` specs), and read-only `REVIEWER`, `SECURITY`
  and `COORDINATOR` (Session A for `/harness:sessions`). A worker's role sets its persona **and** its
  engine permissions: with Claude Code it can only edit its own targetFiles.
- Skills (`.harness/skills/<name>/SKILL.md`, frontmatter `name`, `description`, `roles`,
  `allowedTools`): rules injected into matching workers. A skill can narrow tools, never add;
  exact rules like `Bash(npm test:*)` are granted only if the role already covers them. With several skills, each
  narrows on its own and the worker gets the union (never more than the role). A lead's `skills` list in `team.json`
  is added to: every skill for its role with `autoApply: true`, and every skill for its role whose `keywords` appear in
  the task as whole words or phrases (a plural is fine; "token" does not match "tokenizer"). BA expanding a `feature` and QA running a `hunt` get skills the same way (role + keywords). A worker without a role gets
  no skills: give headless tasks one with `dispatch --role <ROLE>`. At most 2 skills reach one worker (best match first). A
  skill from the skill library that is not installed yet but fits a worker's role and task is added by the controller before the
  workers start ("automatic, then tell": the result names it and why); when you report a run, tell the user which
  skills were added. A skill whose `roles` exclude the worker's role is never injected. Only skills in the explicit list may
  narrow a worker's tools; a skill added by keyword or `autoApply` brings its rules, never takes a tool away.
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
| `.harness/memory.mjs` | remember / learn / promote / list / forget / forget-auto / context (`--goal`, `--files`) / sessions |
| `.harness/doctor.mjs` · `status.mjs` | setup check (incl. duplicate `agy` PATH guard & cross-tool rule parity) · current state |
| `.harness/config.json` | engines, max cycles, timeouts, worktrees, auto git commit |
| `.harness/memory/` | `profile.md` (shared project profile), `lessons.md` (committed); `me.md` (each person's own profile and hats), `auto-lessons.md`, `sessions/` (git-ignored) |
| `.harness/inbox/` → `completed/` or `failed/` | job files (`failed/` also has `.trace.txt`) |
| `.harness/staging/` | backups of scoped files while a task runs (restored on failure) |
| `docs/foundation/` | `product.md`, `domain.md`, `brand.md`: short forms for the product owner, analysts and designers (why, rules, states, brand feel, anti-patterns); passed to roles by reference, never always-loaded |
| `.harness/charter.md` · `backlog.json` | autonomous limits · task backlog |
| `.harness/backlog.mjs` | backlog list / add / ready / pop / import (with snapshot) / releases |
| `.harness/roles/` · `skills/` | role personas + tool limits · skill rules |
| `.harness/team.json` · `team.mjs` | the agent team (orchestrator → leads → workers): scopes, limits, budgets · show / validate / `sync-agents` / `adapt-scopes` |
| `.harness/visible.mjs` | the controller for the editor workflow: brief / assign / verify / judge / visual / handoff / rollback / propose / status / report |
| `.harness/lib/guard.mjs` | LLM judge gate (rubric incl. `intentFit` / `states` / `craft` and the "Done vs Good" answer, JSON verdict the controller decides on; `visible.mjs judge` → `REVIEW_BLOCKED`) and the visual gate (UI changes are not DONE until a human confirms or screenshot evidence is attached: `visible.mjs visual attach|confirm|reject`) and prompt-injection guard (a "data, not instructions" rule in every prompt; injected backlog or proposed tasks are held or rejected) |
| `.harness/hook-guard.mjs` | Claude Code PreToolUse guard: blocks edits to `.env*`, `.git/**`, `.harness/releases/**` (and the core in installed projects), hard resets, `git clean -f`, force pushes and pushes to protected branches **before** they happen |
| `.harness/feature.mjs` · `/harness:feature` | a big feature from a short goal: BA (read-only) grows it into the whole user workflow (`new`/`expand`/`prompt`), the owner keeps steps (`approve F1 --keep 1,2`), kept steps become READY backlog items with `dependsOn` (journey order); stored in `backlog.json` `features` |
| `.harness/hunt.mjs` · `/harness:hunt` | bug hunt: QA (no Edit/Write; may run tests) reports findings with evidence (✅ confirmed / 🟡 suspect); the owner keeps them (`approve H1 --keep 1,3`); each becomes a READY `bugfix` item fixed Red-Green; stored in `backlog.json` `hunts` |
| `.harness/lib/waiting.mjs` | the one "Needs you" list (`status`, `status --json` `needsYou`, session start): drafts, 🟡 decisions, held and BLOCKED items, failed jobs |
| `.harness/sessions.mjs` · `/harness:sessions` | session board: Session A (role COORDINATOR) runs up to 4 child sessions, one task each; `checkpoint` saves WIP, `handoff` inspects & prepares cross-engine resume (`dispatch.mjs --cwd`), merge only with the owner's yes; merged tasks are cleaned up, unfinished ones flagged HIGH RISK, never deleted |
| `.claude/agents/lead-*.md` | the named agents (generated from team.json; the user sees them working in the session) |
| `docs/WORKFLOW.md` | the workflow, the rules, the two modes, what is not guaranteed |
| `.harness/releases/` | snapshots made before every upload (git-ignored, never edit) |
<!-- docs-drift:ignore -->
| `.harness/examples/backlog.sample.json` | a BA + DEV + QA parallel sample to import |
| `.harness/state.json` · `telemetry.log` | live state · JSONL event log |
| `.harness/live.log` · `watch.mjs` | plain-text live feed of every agent action · follow it (`--job <id>` ends with the result) |
| `.harness/start.mjs` · `usage.mjs` | interactive `[1]`–`[6]` launcher + live banner (`--summary`, `--json`, `npm start`) · daily/7d/30d quota & 80% pre-flight/banner warnings (`npm run usage`) |
| `.harness/ui.mjs` | read-only local web dashboard on `127.0.0.1:4173` (`npm run ui`, `--port <n>`, `--no-open`; status, backlog, quota, visible runs, sessions, logs) |
| `.harness/lib/update-check.mjs` | tells an installed project when a newer harness is released (cached, background refresh, `HARNESS_OFFLINE=1` / `"updateCheck": false` to turn off); when it says so, tell the user and ask before running the update |
| `.harness/hook-session.mjs` | prints harness state at session start (`--brief`: 4–8 line read-only summary for any editor/shell) |
| `.vscode/tasks.json` | buttons for the user (Run Task menu) |
| `.claude/settings.json` · `commands/harness/*.md` | Claude Code permission rules + start-up hook · `/harness:run`, `/harness:feature`, `/harness:hunt`, `/harness:auto`, `/harness:sessions`, `/harness:status`, `/harness:tick`, `/harness:team`, `/harness:doctor`, `/harness:teach` (the user must trust the folder once for the rules to apply) |
| `test/run-tests.mjs` · `test/live-e2e.mjs` | free mock-engine tests · opt-in real-agent test (`npm run test:live`) |
| `CHANGELOG.md` | release notes, one entry per version (what changed, who is affected, config/permission/hook changes, migration); the installer prints the newer headlines on upgrade |
| `test/evals/golden.json` · `test/eval-live.mjs` | golden judge/injection cases (run by `npm test`) · opt-in live eval with a real engine: hidden checks, injection resistance, judge verdicts, regression vs the last run (`npm run eval -- --engine <name>`) |

Engines marked `"verified": false` in `config.json` have command-line flags that were not tested
against the real tool. `node .harness/doctor.mjs` probes `<tool> --help` and lists missing flags.
An engine that is missing or fails the probe is replaced by `auto` (logged as `ENGINE_FALLBACK`).
To fix one, read its `"note"`, run `<tool> --help`, and propose the change to the user before
editing the config.
