# The agent workflow and its rules

Khmer version (ភាសាខ្មែរ): [`docs/WORKFLOW.km.md`](WORKFLOW.km.md).

This is the detailed version of the workflow in the README. It is written for the person who owns a project that has
the harness installed, and for any team that copies the template into its own project.

## 1. The workflow in one picture

```
 YOU ──goal / READY backlog task──► CONTROLLER ──brief──► ORCHESTRATOR ──delegates──► NAMED AGENTS
                                    (.harness/)           (your editor session)       lead-ba · lead-dev · lead-qa
                                         ▲                                                    │
                                         └──────────── verify (files + real check) ◄──────────┘
                                         │
                                         └──► REPORT to you
```

| Who | What it is | What it does | What it may NOT do |
|---|---|---|---|
| **You** | the human | give a goal, add READY tasks, decide on anything the report flags | |
| **Controller** | `.harness/` scripts + `charter.md`, `backlog.json`, `team.json`, memory | holds the task and the rules; briefs the orchestrator; validates the delegation; checks every changed file; runs the real check; writes the report | it never writes your project code |
| **Orchestrator** | your Claude Code session | reads the brief, decides who gets which files, starts the agents, passes their reports to the controller, reports to you | edit project files, widen a scope, raise a limit, commit, push |
| **Named agents** | `lead-ba`, `lead-dev`, `lead-qa` (see `.claude/agents/`) | do the work on the files they were assigned | touch other files, `.harness/`, `.claude/`, secrets; run commands other than the test commands |

The agents are *named* on purpose: in Claude Code you see **`lead-dev`**, **`lead-qa`** … appear and work in your session, in parallel.

## 2. The rules ("agent law")

1. **Brief first.** `node .harness/visible.mjs brief` creates a run, snapshots the project and tells the orchestrator the task, the check, the team and the limits. Only one run can be open at a time.
2. **Delegation is validated before anything starts.** `assign` accepts a delegation only if every lead exists and may be delegated to, each lead appears once, every file is a safe relative path inside that lead's scope (and inside what you allowed with `--files`, and, in autonomous mode, inside the charter's allowed paths), and no two leads share a file. A rejected delegation starts nothing. Three rejections **escalate to you** and block the backlog item.
3. **Each agent owns only its files.** After the agents finish, `verify` compares the whole project with the snapshot. Any changed file that is not inside some agent's assigned files is a **violation** and is **reverted automatically**. The rules themselves (`charter.md`, `team.json`, `config.json`, roles, skills), `.claude/`, and root `.env*` files are watched too.
4. **Done means the real check passed.** `verify` runs the task's check (your `--check`, the backlog item's `verifyCmd`, or the best script in `package.json`). A failure goes back to the responsible agent; after **3 cycles** the run stops as `HALTED_HITL_REQUIRED`, every file is restored to how it was before the run, the backlog item becomes BLOCKED, and a lesson is saved.
5. **You decide about the result.** Nothing is committed, pushed or merged for you. A passed run leaves the changes in your working folder for you to review (`git diff`).
6. **The report says what tests cannot prove.** When UI files changed it reads **PASSED — NEEDS A VISUAL REVIEW** (open it at desktop and phone width, light and dark); skipped tests are counted and called out (a skipped visual test proves nothing); files the check itself created that git does not ignore (such as `dist/`) are flagged. The brief also warns when a project with UI files has a check that never opens a browser.
   It also flags test files that were changed after a failed check (were they fixed, or weakened until they passed?), existing tests that were deleted, and lists the task's acceptance criteria for you to confirm, because a passing check does not prove them by itself.
   `node .harness/doctor.mjs` also checks, for a project with UI files, whether a browser testing tool is installed (with `--deep` it launches a real browser once). If not, it prints a note with the install command; it never installs anything for you.
7. **A report always comes back**, in plain words: what each named agent did, the check result, what needs your decision. The report is also saved (`.harness/visible/<run>/report.md`) and a session note is written to memory.

### Autonomous mode (ON by default)

`/harness:auto` runs the same workflow by itself, task after task, inside `.harness/charter.md`:

- It acts on **READY tasks you put in the backlog** (`node .harness/backlog.mjs add "<title>" --status READY`).
- When nothing is READY it may **propose** small tasks, but only once you have replaced the placeholder under "Project objectives" in the charter, and only inside the team's scopes and the charter's allowed paths. Until then it plans nothing and spends nothing.
- It needs a **real check** (`requireRealCheck`), does at most `maxAutoTasksPerRun` tasks per session, and **pauses on the first failure**.
- When a Claude Code session opens, the start-up hook tells the AI that auto mode is on and which task is READY, so it starts by itself.
- **Turn it off:** set `- autonomous: off` in `.harness/charter.md` (or install with `node install.mjs <project> --autonomous off`).

## 3. Two ways to run the same team

| | **Editor (visible)** | **Headless (background)** |
|---|---|---|
| Start | `/harness:run <goal>` · `/harness:auto` | `node .harness/dispatch.mjs --goal "…" --hierarchy --max-cost 2` (controller running: `node .harness/daemon.mjs`) |
| Orchestrator | your editor session | an AI call made by the controller |
| Agents | the named agents, visible in your session | separate background processes (their activity is in the live feed, `node .harness/watch.mjs`) |
| Each agent's file limits | enforced **after the fact**: violations are detected and reverted | enforced **by the engine while it works** (per-file permissions) |
| Money cap | **not measured** (the agent panel shows tokens) | **enforced**: `--max-cost`, per-agent caps |
| Autonomous work lands | in your working folder (you review it) | on the `uat` branch, never `main` |
| Best for | working with the agents in front of you | unattended runs, CI, terminals |

## Many sessions at once: Session A and its child sessions

Talk to one session only (**Session A**, `/harness:sessions`); it runs up to **4 child sessions**, one task each, in
their own worktrees, local or cloud. The board is `node .harness/sessions.mjs board`.

- Each task gets a clear name and branch: `FEAT-3 Login page` on `task/feat-3-login-page`.
- The child reports done through git (`sessions.mjs report <ID> done`), so Session A sees it locally or after a push.
- **WIP checkpoint & cross-engine handoff:** if a child stalls or switches tools mid-task, save uncommitted work on the child branch without marking it done (`node .harness/sessions.mjs checkpoint <ID> [--message "…"]`; any `Harness-Wip` commit newer than `Harness-Session` keeps/returns the task to `WORKING` until reported done again), inspect commits, dirty files, check command, and ready engines with `node .harness/sessions.mjs handoff [ID] [--checkpoint] [--prompt|--json]`, or finish the task headlessly inside its worktree via `node .harness/dispatch.mjs --cwd <worktree> --goal "…" --wait` (cannot combine `--cwd` with `--branch` or `--resume-visible`).
- **Merging needs your yes.** `sessions.mjs merge <ID>` merges in a temporary worktree and runs the check first; only
  then does the base branch move. Then that child's worktree and branch are removed automatically.
- **Nothing unfinished is ever deleted.** A child idle for 24 h, a failed check, or a task never started is shown as
  **HIGH RISK** on the board and at every session start, until you decide.

## Quota and consent (both modes)

- **Each AI tool is allowed once per person** (`node .harness/engines.mjs`); headless runs never use a tool you did not allow.
- **Big runs ask first** (team or parallel mode, 3+ workers, the high model). In autopilot, headless or in Claude Code,
  they are held as "Needs your OK" and the rest goes on; approve one with `node .harness/backlog.mjs approve <id>`.
- **Daily caps and a usage report** for headless runs: `config.json` → `dailyLimits`, `node .harness/usage.mjs`.
  Editor-mode agents run inside your editor session (`claude-code` by default, or pass `--editor antigravity` / `cursor`
  to `visible.mjs brief` and `visible.mjs assign`), so they are tracked under separate editor keys (`claude-code`,
  `antigravity-editor`, …) and never collide with your headless CLI engine limits.
- Details: [`ENGINES.md`](ENGINES.md).

## Switching sessions mid-run (cross-editor handoff & headless resume)

If an editor session stops, hits a usage cap, or needs to move into another editor or a terminal while a `visible.mjs` run
is still open (`BRIEFED`, `DELEGATED`, or `FAILED`):

1. **Hand off to another editor session:** run `node .harness/visible.mjs handoff [run] [--prompt] [--json]`. It compares
   the workspace with the run's pre-run snapshot, shows per-lead progress, missing files, out-of-scope edits, the last
   verify failure, and ready headless engines, and prints a copy-paste prompt that continues the exact same run ID without
   starting a duplicate run.
2. **Or finish headlessly in the controller:** run `node .harness/dispatch.mjs --resume-visible [run] [--engine <tool>] --wait`.
   - `DELEGATED` and `FAILED` runs convert the saved lead assignments into scoped headless workers, preserve partial edits
     already on disk, inherit the interface contract, acceptance criteria, backlog ID, and last verify error, and sync
     `.harness/visible/<run>/` (`run.json`, `report.md`, and backlog status) when finished.
   - `BRIEFED` runs auto-select team hierarchy (`team.json`) or the AI planner.
   - If the headless resume halts or rejects after 3 cycles, only the failed headless edits are rolled back so your
     pre-handoff work stays intact and `node .harness/visible.mjs rollback <run>` still restores all the way to before the run started.
3. **Interactive menu & quick status (any terminal or editor):** run `npm start` (`node .harness/start.mjs`, or `--summary` for just the overview banner) for `[1]`–`[6]` guided actions (handoff/resume, dispatch, tool consent, backlog approvals, session board + WIP checkpoint/handoff, quota & memory), or run `node .harness/hook-session.mjs --brief` for a 4–8 line status snapshot in Antigravity, Cursor, VS Code, or any shell. For a child task branch/worktree, use `node .harness/sessions.mjs handoff [ID] [--checkpoint]` and `node .harness/dispatch.mjs --cwd <worktree> --goal "…" --wait`.

## 4. What is NOT guaranteed (read this before trusting it with a real project)

- **Editor mode catches violations after the fact.** Claude Code cannot restrict a sub-agent to specific files, so an agent *can* write outside its files; the controller then reverts it and fails the run. It cannot undo anything done **outside the project folder**, or in a git-ignored place other than `.env*`.
- **Secrets are compared by hash only** (never copied). If an agent edits a root `.env*` file, the controller reports it loudly but **cannot restore it**; you must.
- **Editor mode does not measure cost.** Use the headless mode when you need a hard dollar cap.
- **`node --test` / `npm test` execute your project's test code.** That is the price of letting agents check their own work.
- **A project with more than 20,000 files** is not supported by the editor workflow (use headless).
- Claude Code **ignores a project's permission rules until you trust the folder** (a one-time dialog in the editor), and loads the named agents **at session start** (restart the session after installing or after `team.mjs sync-agents`).

## 5. Make it yours

| To change… | Edit | Then |
|---|---|---|
| who is on the team, what each may own, limits, default skills | `.harness/team.json` | `node .harness/team.mjs validate`, then `node .harness/team.mjs sync-agents`, restart the Claude Code session |
| a role's persona or tools | `.harness/roles/*.json` | `node .harness/team.mjs sync-agents` |
| rules injected into agents | `.harness/skills/<name>/SKILL.md` | |
| what autonomous mode may touch / how much it may do | `.harness/charter.md` (section 0) | `node .harness/doctor.mjs` |
| what the AIs should remember | `node .harness/memory.mjs remember "<rule>"` (or `/harness:teach`) | |

`node .harness/doctor.mjs` checks all of it, including that the named agents match `team.json`.

## 6. Permission rules (already included: no prompts for the workflow)

`.claude/settings.json` ships with narrow rules, so the workflow runs without asking you for every command (the folder must be trusted):

- **Allowed without asking:** only the workflow commands (`visible.mjs brief | assign | verify | handoff | propose | status | report`, `sessions.mjs board`, `status`, `doctor`, `team`, `dispatch`, the read-only `backlog` and `memory` commands) and the two test commands the agents use to check their own work: `npm test` and `node --test`. Never a whole interpreter (`node`, `git`, `npm`).
- **Always asks:** `visible.mjs rollback`, `sessions.mjs merge`, editing `.harness/team.json`, `.harness/charter.md` or `.harness/config.json`, `backlog import | ready | block`, `memory forget`, `daemon --autonomous`, `git push`.
- **Denied:** editing `.harness/releases/**`, force-pushing.

For a project that already has its own `.claude/settings.json`, `node install.mjs <project>` **merges** these rules in (your rules stay; a rule you put in a stricter list is never loosened).
`npm test` and `node --test` run your project's test code, so only trust a project whose tests you are happy to run.

## 7. Troubleshooting

| You see | Why | Do |
|---|---|---|
| no `lead-…` agents appear | the session was open before the agents existed | restart the Claude Code session; run `node .harness/team.mjs sync-agents --check` |
| it asks permission for every command | the folder is not trusted yet (Claude Code ignores a project's permission rules until you trust it) | accept the trust dialog once (section 6 lists the rules) |
| "Run V-… is not finished" | an earlier run was neither verified nor rolled back | `node .harness/visible.mjs verify <run>` or `rollback <run>` |
| auto mode does nothing | nothing is READY and the charter objectives are still the placeholder | add a READY task, or describe your goals in the charter |
| "NO REAL CHECK" | the project has no test script | add a `test` script to `package.json`, or pass `--check "<command>"` |
| `STOPPED — a human decision is needed` | 3 cycles failed | read the report; the files were restored; fix the task and run it again |
