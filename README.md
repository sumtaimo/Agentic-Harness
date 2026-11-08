# Agentic Harness

A reusable, **zero-dependency** harness that runs AI coding agents in the background of your
editor (VS Code, Antigravity, Cursor, Windsurf), checks their work automatically, **undoes their
changes if they fail**, keeps a **memory** of how you like to work, and can **work through a
backlog on its own** as a governed "act as me" controller with PO / BA / DEV / QA roles.
You can use it without being able to code.

```
 you ──► "New task" ──► 1 PLANNER ──► 2 EXECUTOR (1 or many AI workers) ──► 3 VERIFIER ──pass──► 4 COMMITTED
          (goal)        (AI can split          ▲                                │
                         the goal)             └──── fail: error fed back ──────┤ (max 3 cycles)
                                                                                └──► HALTED: files restored,
                                                                                     a human decides
```

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TOPOLOGY: SWARM-MESH (2W) [CLAUDE]                     CYCLE: 1/3 | LOCKS: 2 │
│ PHASE:    2_EXECUTOR_SWARM                            UPTIME: 42s | PID: 1273│
│           1_PLANNER > [2_EXECUTOR_SWARM] > 3_VERIFIER > 4_COMMITTED          │
├──────────────────────────────────────────────────────────────────────────────┤
│ TASK:    Create greet.js and shout.js                                        │
│ PLAN:    AI planner → 2 worker(s): greet[greet.js]  shout[shout.js]          │
│ SWARM:   1/2 worker(s) finished (last: greet)                                │
│ VERIFY:  Check: npm test  (auto-detected from package.json scripts: test)    │
│ QUEUE:   0 waiting  |  MEMORY: 4 taught rule(s), 1 auto lesson(s)            │
├──────────────────────────────────────────────────────────────────────────────┤
│ ENGINES: CLAUDE✓ ANTIGRAVITY· ORCA· GEMINI· CODEX·   (✓ installed)           │
│ LOGS: .harness/telemetry.log                       MEMORY: .harness/memory/  │
└──────────────────────────────────────────────────────────────────────────────┘
  ➜ AI workers are working. Their files are locked so they cannot collide.
```

---

## 1. Get it

Pick one:

| You want… | Do this |
|---|---|
| A **new project** | On GitHub click **Use this template → Create a new repository**, then open it in your editor. |
| A copy without GitHub | Click **Code → Download ZIP**, unzip it, open the folder in your editor. |
| Add it to an **existing project** | Download/clone this repo, then run `node install.mjs /path/to/your/project`. It never overwrites your files: existing `AGENTS.md`, `CLAUDE.md`, `.vscode/tasks.json` etc. get a harness section *added*. |

## 2. One-time setup (about 10 minutes)

1. **Install Node.js 18 or newer** from <https://nodejs.org> (the LTS button).
2. **Install at least one AI engine.** Claude Code is the one tested end-to-end:
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
   Then run `claude` once in a terminal and log in.
3. **Open the project folder** in your editor.
4. When the editor asks *"Allow automatic tasks in this folder?"*, choose **Allow**.
   (If it doesn't ask: Command Palette → `Tasks: Manage Automatic Tasks` → **Allow**.)
   The harness screen now opens by itself every time you open the folder.
5. Command Palette (**Ctrl+Shift+P** / **Cmd+Shift+P**) → **Tasks: Run Task** → **Harness: Doctor (check my setup)**.
   Fix anything marked ✖. Doctor also tests each installed AI engine's command-line flags.
6. Recommended: let your AI fill in your profile. In your editor's AI chat, type:
   > Read AGENTS.md and fill in my profile.

## 3. Everyday use — no coding needed

Everything is in **Command Palette → Tasks: Run Task**:

| Task | What it does |
|---|---|
| **Harness: 1. Start (live screen)** | Starts the background harness and shows the live screen (auto-starts on folder open). |
| **Harness: 2. New task (type what you want)** | Asks: *what to do*, *which files/folders it may change* (optional), *how to check it* (optional), *which AI*, and *split into parallel workers?* Then runs it and tells you **COMMITTED ✔** or **NOT DONE ✖**. |
| **Harness: 3. Teach the AI something** | Saves a rule, e.g. *"Always explain changes in simple English"*. Every AI in this folder follows it from then on. |
| **Harness: 4. Show memory** | Lists what the AI remembers. |
| **Harness: 5. Status + recent events** | What is happening now and the last events. |
| **Harness: 6. Start Autonomous Controller** | Works through the backlog on a schedule (see section 4). Stop task 1 first: one controller per folder. |
| **Harness: 7. Run Autonomous Controller Tick** | Does one autonomous step now (works with or without task 1 running). |
| **Harness: 8. View Backlog & Releases** | The backlog by status, and the saved release snapshots. |
| **Harness: 9. Import New Goal/Backlog with Snapshot** | Replace the backlog (.json), charter (.md) or skills (folder). The old one is saved first. |
| **Harness: 10. Add a goal to the backlog** | Add one item, READY to run or as an idea. |
| **Harness: Run Self-Test Cycle** | Proves the harness itself works (no AI needed). |

Or just **talk to your editor's AI chat**. It reads `AGENTS.md`, so you can say things like:
> Use the harness to add a contact form to the homepage, and check it with the tests.

> Remember that I want every answer as short numbered steps.

### The check (verifier)
The check is what makes this safe: the work is only accepted when the check command succeeds.
- If you give one (`--check "npm test"`), that is used.
- If you don't, the planner picks the strongest check from your `package.json` scripts:
  `check` → else `typecheck` + `test` → else `build` → else `lint`.
- If there is none, **nothing really checks the work**, and the harness warns you.
  Ask your AI chat to add a test script.

### The AI planner (parallel workers)
Answer **yes** to *"Split into parallel AI workers?"* (or use `--auto-plan`). An AI first
**reads** the project (read-only, so it cannot change anything) and splits your goal into up to
4 workers. Each worker gets **its own files**. The plan is rejected if two workers would share
a file, if a path is unsafe (`..`, `.git`, `.harness`), or if it goes outside the files you
allowed. The planner gets one chance to fix a rejected plan, and is then stopped. It may
*suggest* a check command; that suggestion is written in the session note and **never run
automatically**.

### The safety net
- **Undo on failure.** Before the AI touches anything, every file and folder it is allowed to
  change is copied to `.harness/staging/<task>/`. If the task ends in failure (stopped after 3
  cycles, or rejected), those files are put back exactly as they were, and new files it created
  are removed. A successful task keeps its changes and deletes the backup.
  *Limit:* a single worker with **no** files listed can't be backed up (the screen and log say
  so). Use `--files`, the AI planner, or git.
- **Failed jobs are kept** in `.harness/failed/<id>-<time>.json` together with a `.trace.txt`
  that holds the error from every cycle (a "dead-letter queue").
- **No runaway loops.** It stops after 3 cycles, and workers cannot start new jobs.

### Watching the agents inside your editor
Three ways to see the agents work, all fed by the same plain-text feed (`.harness/live.log`):
1. **VS Code / Antigravity / Cursor:** task "Harness: 1. Start (live screen)" opens a terminal panel when the folder
   opens. It shows the dashboard while idle and one line per agent action while a task runs.
2. **Any terminal:** `node .harness/watch.mjs` follows the feed. `node .harness/watch.mjs --job <id>` stops
   with the result (exit 0 = committed).
3. **Inside an AI chat (Claude Code):** ask the chat to run your task "through the harness". `AGENTS.md` tells
   it to start the controller in the background, dispatch, and stream `watch.mjs` with its `Monitor` tool,
   so each agent action arrives in the chat as it happens, ending with the result.

`.harness/hook-session.mjs` prints a short harness status (controller running? backlog? autonomy?) for
an editor AI when a session starts. It is designed to run as a Claude Code `SessionStart` hook.

## 4. Autonomous controller ("act as me")

The controller works **on your behalf**, but only inside the rules you write in
**`.harness/charter.md`**. The first bullets of that file are read by the harness:

```
- autonomous: off            ← switch to "on" when the objectives below describe your project
- maxAutoTasksPerRun: 3      ← most tasks it may start in one run (one start of task 6, or one tick)
- allowedPaths: src/**, docs/**, tests/**, test/**
- forbiddenPaths: .git/**, .harness/**, node_modules/**, .env*, production-credentials/**
- forbiddenTools: Bash(git push:*), Bash(git remote:*), Bash(rm -rf:*), Bash(npm publish:*)
- requireRealCheck: yes      ← never run autonomous work that nothing can check
```

**How it decides what to do** (on every interval, and whenever the queue empties):
1. If `.harness/backlog.json` has a **READY** item, it runs the highest-priority one
   (lowest `priority` number first).
2. If nothing is READY, the **PO_ARCHITECT** reads the charter, the project and the backlog,
   with **read-only** tools, and writes the next tasks: at most the remaining budget, each with
   roles, files, acceptance criteria and an interface contract. Tasks that break the charter or a
   role's limits are dropped. Then it runs the first one.
3. It stops when the budget is used. If an autonomous task **fails**, its files are restored, the
   item becomes **BLOCKED** with the reason, and autonomy **pauses**: you decide. Fix it, run
   `node .harness/backlog.mjs ready <id>`, and start again.

**Backlog states:** `BACKLOG` (an idea) → `READY` → `IN_PROGRESS` → `DONE` or `BLOCKED`.
Add items with task 10 or `node .harness/backlog.mjs add "…"`; see them with task 8.
Try it with the BA + DEV + QA sample: task 9 with `.harness/examples/backlog.sample.json`.

### Where autonomous work lands: the `uat` branch (your `main` and your folder are never touched)
Autonomous tasks need a git repository. For each task:
1. Every worker gets **its own branch and worktree** (`harness/<task>/<worker>`), cut from `uat`.
   `uat` is created from your current commit the first time.
2. When a worker finishes, only the files it was allowed to change are committed on its branch.
   Anything else it touched is thrown away.
3. All worker branches are merged into a **candidate** in a separate integration worktree, and
   **the check runs on that candidate**.
4. Only if the check passes does `uat` move to the candidate. If it fails, `uat` stays exactly as
   it was, and the worker branches are kept for you to review.

Your own folder, its checked-out branch, and `main`/`master`/`production` are never written
(the log records `PROTECTED_BRANCHES_UNCHANGED` after every task). If `uat` happens to be
checked out in your folder, it is fast-forwarded there, but only when you have no uncommitted
changes. See the result with `git log --oneline uat`, and merge `uat` into `main` yourself when
you're happy.

Manual tasks keep editing your folder, unless you ask for the branch: `dispatch.mjs --branch uat …`.
Change this in `config.json` → `git` (`integrationMode`: `autonomous` | `always` | `off`).

**The PO is not re-asked needlessly.** On every heartbeat with an empty backlog, the PO would
otherwise be asked again (a paid AI call every minute). Instead the harness remembers a fingerprint of the
charter, backlog and `uat` tip (`.harness/auto-state.json`). If the PO said "nothing to do" and
nothing changed, the tick is skipped (`--tick --force` asks again). The PO also reads the `uat` version of
the project (a temporary worktree), not whatever branch your folder is on.

### Watching the agents live
While a task runs, the terminal shows what each agent does, as it happens, one line per action:
```
  [worker-dev]       ▶ agent started (…) in .harness/worktrees/UAT-AUTO-001-…/worker-dev
  [worker-qa]        💬 I'll write the test file now.
  [worker-dev]       🔧 Write src/greeter.js
  [worker-dev]       ⚠ This command requires approval
  [worker-dev]       ✔ finished in 10.5s · $0.167 · ⛔ denied: Bash node -e …
```
`config.json` → `"liveAgentOutput": false` (or env `HARNESS_LIVE=0`) turns it off. The
full-screen dashboard returns whenever the harness is idle.

### Roles and skills
| Role | Does | May own files | Engine tools (Claude Code) |
|---|---|---|---|
| `PO_ARCHITECT` | plans the backlog from the charter | none (read-only) | Read, Glob, Grep, `git status`/`git log` |
| `BA_ANALYST` | requirements, edge cases, acceptance criteria | `docs/**` | Read + Edit/Write **only its own files** |
| `DEV_ENGINEER` | implements code | anything allowed | Read + Edit/Write its own files, `npm`, `node`, read-only git |
| `QA_AUDITOR` | writes/runs tests against the criteria | `tests/**`, `test/**`, `*.test.*`, `*.spec.*` | Read + Edit/Write its own files, `npm test` |

Roles live in `.harness/roles/*.json` (persona, tools, allowed paths), so you can edit them or add
new ones. With Claude Code, the file limits are **enforced by the engine**: a live Claude Code call
with the BA role's exact rules had its write to `src/` denied (`permission_denials`). The charter's forbidden paths
and tools are added as deny rules for every worker.

**Skills** are folders `.harness/skills/<name>/SKILL.md` with a small header:
```
---
name: code-craft
description: …
roles: ["DEV_ENGINEER", "QA_AUDITOR"]
allowedTools: ["Read", "Edit", "Write"]
---
rules in plain words…
```
In `allowedTools` a skill lists, per tool, either a bare name (`Edit`: keep the role's rules for it)
or **exact rules** (`Bash(npm test:*)`: replace the role's rules for that tool by these, but only
those the role already covers, so `Bash(npm:*)` in the role covers `Bash(npm test:*)`).
`allowedTools` is the default list for every role the skill names; a line like
`allowedTools.DEV_ENGINEER: [...]` replaces it for that one role. The shipped `code-craft` skill uses both:
- **DEV_ENGINEER:** Read/Edit/Write its files, `npm test` and `node --test`, and nothing else. DEV can test its own
  code, but cannot use `git`, `rm`, `npm run`, or `node -e` (a live Claude Code call confirmed `node --test`
  runs and `node -e "…writeFileSync…"` is denied).
- **QA_AUDITOR:** Read/Edit/Write its files and `npm test` only.

Doctor warns if a skill asks a role for a rule the role doesn't allow, and the log records it
(`SKILL_RULE_NOT_GRANTED`). Note that `node --test` still runs the project's test files, which is code:
in `uat` mode anything outside the worker's files is discarded before commit, and the check runs on the merged candidate.

A worker gets a skill when its task lists it (`"skills": ["code-craft"]`) or when the AI
planner or PO picks it. A skill is only given to the roles it names, and a skill can only
**narrow** a role's tools, never add to them. The sample `code-craft` skill requires a
`@governed-by PO_ARCHITECT` JSDoc header in generated files.

### Uploading a new backlog, charter or skills (release snapshots)
`node .harness/backlog.mjs import <file-or-folder>` (task 9) never just overwrites:
- The upload is checked first; a broken file changes nothing.
- The current `charter.md`, `backlog.json` (and the skills, for a skills upload), plus a
  `completed-summary.md` of what was done, are saved to `.harness/releases/release-<time>/`.
- **Unstarted inbox jobs** from the old upload are moved into that snapshot, so the new upload
  starts clean.
- Memory (`lessons.md`, `auto-lessons.md`) is **kept**, so lessons compound. Add `--reset-memory`
  to save it in the snapshot and start fresh.
- An import is refused while a task is running.

## 5. The memory ("brain")

All memory is plain text in `.harness/memory/`, which you can open and edit yourself:

| File | Written by | Used for | In git? |
|---|---|---|---|
| `profile.md` | you / your AI | who you are, your level, your language, how you like answers | yes (generic starter) |
| `lessons.md` | **you** (Teach task, or the AI when you correct it) | rules every AI must follow, with the highest priority | yes (generic starter) |
| `auto-lessons.md` | the harness | what went wrong before | **no**: personal history |
| `sessions/*.md` | the harness | one record per task: plan, check, errors, result, rollback | **no**: personal history |

How it reaches each AI:
- **Harness workers** get the memory in their prompt. Lessons are de-duplicated and capped at
  50 lines (taught rules first). If the engine already loads `profile.md` and `lessons.md` itself
  (Claude Code via `CLAUDE.md` `@imports`), they are **not** injected a second time.
- **Editor AIs** are told by their own instruction file to read it first:

| Editor / AI | File it reads | Status |
|---|---|---|
| Claude Code | `CLAUDE.md` (auto-imports AGENTS.md + memory) | tested |
| Codex, Cursor, Windsurf, many others | `AGENTS.md` | standard file, not tested here |
| Gemini CLI / Antigravity | `GEMINI.md` → AGENTS.md | not tested here |
| Cursor | `.cursor/rules/harness.mdc` | not tested here |
| Windsurf | `.windsurfrules` | not tested here |
| GitHub Copilot | `.github/copilot-instructions.md` | not tested here |

> **Honest note:** this does **not** train or change any AI model on your machine. The AI
> "learns" because your rules and history are written down and given back to it every time.
> You can read, edit or delete anything it remembers. Never put passwords or API keys in memory.
> `profile.md` and `lessons.md` are committed. If your project is **public** and they hold
> personal details, uncomment the two lines at the bottom of `.gitignore`.

## 6. AI engines

Set in `.harness/config.json` → `"activeProfile"`. The default is `"auto"`; you can also force
`"claude"`, `"antigravity"`, `"orca"`, `"gemini"` or `"codex"`, per task or globally.

- **The prompt always goes to the engine on stdin** (`"promptVia": "stdin"`), so no
  command-line flag can accidentally swallow it. `"arg"` (with `{prompt}` in `args`) and
  `"after--"` are available if a CLI needs them.
- **Flag probe:** before an engine is used, the harness runs `<engine> --help` (or
  `<engine> <subcommand> --help`) once and checks every configured flag is listed. The result is
  cached in `.harness/engine-probe.json`.
- **Graceful fallback:** if the engine you asked for is not installed or fails the probe, the
  harness uses `auto` instead (the first engine in `"autoOrder"` that is installed and passes),
  and shows/logs why (`ENGINE_FALLBACK`). It stops only if no engine is usable at all.

| Engine | Status |
|---|---|
| `claude` (Claude Code) | ✅ verified end-to-end, including the AI planner and two parallel workers |
| `antigravity` | ⚠️ flags from the original spec, **not verified**; Doctor's probe will tell you |
| `orca` | ⚠️ flags from the original spec, **not verified**; Doctor's probe will tell you |
| `gemini` (Gemini CLI) | ⚠️ not verified here (uses `--yolo`, which auto-approves everything) |
| `codex` (OpenAI Codex CLI) | ⚠️ not verified here |

## 7. Settings (`.harness/config.json`)

| Key | Default | Meaning |
|---|---|---|
| `maxCycles` | 3 | tries before it stops and asks a human (`HALTED_HITL_REQUIRED`) |
| `workerTimeoutMs` / `verifyTimeoutMs` | 5 min / 10 min | kill a stuck worker / check |
| `rollbackOnFailure` | true | back up scoped files and restore them if the task fails |
| `useGitWorktrees` | false | **true** = each AI worker runs in its own git copy; only changes to its allowed files come back (strict enforcement, instead of the backup). Needs a git repo with at least one commit; workers then see the last *commit*, not uncommitted edits. |
| `autoGitCommit` | false | **true** = make a git commit after each task passes |
| `planner.defaultAutoPlan` | false | use the AI planner even without `--auto-plan` |
| `planner.maxWorkers` / `maxAttempts` | 4 / 2 | most workers per plan / planning tries |
| `planner.allowedTools` | Read, Glob, Grep | tools the planner may use (read-only) |
| `defaultVerifyCmd` | always passes | the check used when there is no `--check` and no usable package.json script |
| `memory.maxLessonLines` | 50 | most lesson lines put into a worker prompt |
| `autonomous.intervalSeconds` (or `heartbeatIntervalSeconds`) | 60 | heartbeat: how often the autonomous controller wakes (`--interval <s>` / `--schedule <min>` override) |
| `liveAgentOutput` | true | stream each agent's actions into the terminal |
| `git.integrationBranch` / `integrationMode` | `uat` / `autonomous` | where work lands (see section 4); `always` = every task, `off` = in your folder |
| `git.protectedBranches` | main, master, production, prod | never written; refused as a target |
| `git.keepFailedBranches` | true | keep `harness/<task>/*` branches of failed tasks for review |
| `git.linkIntoWorktrees` | `node_modules` | shared folders linked into worktrees so checks can run |
| `memory.*` | on | turn memory injection, session notes and auto lessons on/off |

## 8. For developers

```bash
node .harness/daemon.mjs                 # watch mode with live HUD (also: --once, --self-test)
node .harness/daemon.mjs --autonomous --interval 300   # scheduled autonomous controller
node .harness/daemon.mjs --tick          # one autonomous step, then exit (--force: ask the PO even if nothing changed)
node .harness/daemon.mjs --status        # same as status.mjs
node .harness/backlog.mjs overview|add|ready|block|pop|import|releases
node .harness/dispatch.mjs --help        # all options: --goal --files --check --engine --auto-plan --wait, swarm --worker id:files:prompt
node .harness/memory.mjs list|remember|forget|context|sessions
node .harness/doctor.mjs                 # setup check + engine flag probe
node .harness/status.mjs --log 25        # state + recent JSONL events
node .harness/watch.mjs --job <id>       # live feed of every agent action until that job finishes
node test/run-tests.mjs                  # 61 end-to-end tests with a mock engine (no AI account needed)
```

Job file format (`.harness/inbox/*.json`):
```json
{
  "id": "job-1", "title": "Build API & Tests", "engine": "claude", "verifyCmd": "npm test",
  "subtasks": [
    { "id": "api",   "targetFiles": ["src/api.ts"],      "prompt": "Implement the endpoint" },
    { "id": "tests", "targetFiles": ["src/api.test.ts"], "prompt": "Write tests" }
  ]
}
```
Or let the AI plan it: `{ "id": "job-2", "title": "…", "autoPlan": true, "goal": "…", "targetFiles": ["src/"] }`
(`targetFiles` here limits what the planner may hand out). A subtask with `cliCommand` and no
`prompt` runs a plain shell command instead of an AI.

**Guarantees, each covered by an automated test:**
- Plans where two workers claim the same file, or one claims a folder that holds another's file,
  are rejected before any worker starts. This applies to hand-written and AI plans alike.
- AI plans with unsafe paths, paths outside the allowed files, or invalid JSON are rejected.
- A failed check feeds its error into the next cycle, and the loop stops after `maxCycles`.
- Failed tasks restore the scoped files and land in `failed/` with a full trace.
- An unavailable engine falls back to `auto`, and a missing engine flag is caught by the probe.
- The check is auto-detected from `package.json`.
- Memory is de-duplicated, capped, and never injected twice.
- State is written atomically, only one daemon runs per folder, and workers cannot dispatch jobs.
- Autonomous mode (v2):
  - READY items are promoted in priority order and marked DONE or BLOCKED.
  - The PO_ARCHITECT is read-only and capped by the budget, and its tasks are validated against
    the charter and roles.
  - The run budget is enforced, a failure pauses autonomy and restores the files, and
    `requireRealCheck` blocks autonomous work that nothing can check.
- Role and skill handling (v2): each role gets its own tool list, skills only reach the roles they
  name and can only narrow tools, and a role's write paths, the forbidden paths, unknown roles and
  unknown skills are all rejected before any worker starts. BA, DEV and QA truly run in parallel.
- Uploads (v2): the old state and unstarted inbox jobs are snapshotted, memory is kept (or reset
  on request), invalid uploads are rejected, and an upload during a running task is refused.
- uat mode (v2.1):
  - Workers get their own branches, out-of-scope edits are discarded, and the candidate is checked
    before `uat` moves. A failed check leaves `uat` unchanged, and retries continue on the same
    branch.
  - Parallel workers are merged into one candidate. A `uat` checked out in your folder is
    fast-forwarded there, or refused if the folder is dirty.
  - Protected targets and autonomous work without git are refused, and `--branch` opts manual
    tasks in.
- Live output and heartbeat (v2.1): live output is rendered, permission denials are logged, and
  the heartbeat wakes up to work added later.

### Changes from the original master prompt
The original `setup-harness.mjs` was run first, unchanged, and passed its own self-audit. These
problems were then found and fixed:
1. **Real agents never ran.** The prompt was passed after `--allowedTools`, which Claude Code
   reads as more tool names, so every cycle failed with *"Input must be provided…"*. All prompts
   now go on stdin.
2. A lock collision was retried 3 times instead of being rejected before spawning. Failed jobs
   stayed in the inbox and re-ran on every restart, and jobs arriving while it was busy could be
   skipped.
3. `--allowedTools` and `--mcp-config` (Claude flags) were sent to every engine. Engine commands
   are now per-profile and checked by the probe. MCP is off by default: it downloaded a server on
   every run, and its tools weren't allowed anyway.
4. The default engine `antigravity` has unverified flags, so the default is now `auto`.
5. HUD lines were wider than the box. The HUD now fits, shows a plain-language next step, and the
   background task is visible instead of hidden.
6. v1.0 added: the AI planner, undo on failure, the dead-letter queue, check auto-detection, the
   engine probe and fallback, memory de-duplication and cap, and a privacy-safe `.gitignore`.
7. v2.0 added the autonomous controller, backlog, roles, skills and release snapshots. The v2
   master prompt's `setup-harness-v2.mjs` was first run unchanged in a throwaway copy. It passed
   its own gate, but:
   - All **18 of its 18 generated QA tests failed** against the DEV code. The two agents ran in
     parallel without a shared interface contract, and the check only tested that the files
     existed.
   - The backlog item stayed `IN_PROGRESS` forever.
   - It had no PO generation, no budget, and no inbox move on import.
   - It would have replaced the v1.0 daemon (memory, planner, probe, rollback of folders, tests).

   v2 was therefore built into v1.0, not over it. The sample now carries an interface contract,
   and its check runs the tests. Role tool rules use valid Claude Code syntax (`Bash(git status)`,
   not `Bash(git:status)`), with git narrowed to read-only because the charter forbids pushes and
   remote changes.
8. v2.1 added the `uat` integration branch, live agent output and the heartbeat. The prompt's
   `setup-autonomous-uat.mjs` was first run unchanged in a throwaway repo. It met its own criteria,
   but:
   - `--output-format text` showed **nothing for 14 seconds**, then only a final summary, so it
     wasn't live.
   - It ran `git checkout uat` in **your** folder.
   - It merged *before* checking, so a **failed task's code stayed on `uat`** (proven with a
     failing task).
   - Workers ran one at a time, and `git add .` committed out-of-scope files.
   - Inbox jobs present at startup were ignored, backlog items stayed `IN_PROGRESS`, and there was
     no retry.

   v2.1 fixes all of these (see section 4).
9. v2.2 let DEV run `npm test`/`node` (exact skill rules), added `--status`, Doctor git-cleanliness
   checks and the PO throttle. Its live run found a **v2.1 bug**: modifying an existing file in `uat`
   mode lost the first letter of its path (git's `" M path"` was trimmed), so the edit was discarded as "out
   of scope" and the task failed 3 times. `uat` stayed safe, but good work was thrown away. Fixed, with a
   regression test that fails when the bug is put back.

## License

[MIT](LICENSE) © 2026 sumtaimo
