# Agentic Harness

A reusable, **zero-dependency** harness that runs AI coding agents in the background of your
editor (VS Code, Antigravity, Cursor, Windsurf), checks their work automatically, **undoes their
changes if they fail**, and keeps a **memory** of how you like to work. You can use it without
being able to code.

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

## 4. The memory ("brain")

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

## 5. AI engines

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

## 6. Settings (`.harness/config.json`)

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
| `memory.*` | on | turn memory injection, session notes and auto lessons on/off |

## 7. For developers

```bash
node .harness/daemon.mjs                 # watch mode with live HUD (also: --once, --self-test)
node .harness/dispatch.mjs --help        # all options: --goal --files --check --engine --auto-plan --wait, swarm --worker id:files:prompt
node .harness/memory.mjs list|remember|forget|context|sessions
node .harness/doctor.mjs                 # setup check + engine flag probe
node .harness/status.mjs --log 25        # state + recent JSONL events
node test/run-tests.mjs                  # 28 end-to-end tests with a mock engine (no AI account needed)
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

## License

[MIT](LICENSE) © 2026 sumtaimo
