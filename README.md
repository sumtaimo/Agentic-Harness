# Agentic Harness

A reusable, **zero-dependency** harness that runs AI coding agents in the background of your
editor (VS Code, Antigravity, Cursor, Windsurf), checks their work automatically, and keeps a
**memory** of how you like to work. You can use it without being able to code.

```
 you ──► "New task"  ──►  1 PLANNER  ──►  2 EXECUTOR (1 or many AI workers)  ──►  3 VERIFIER ──pass──► 4 COMMITTED
                              ▲                                                    │
                              └─────────── fail: the error goes back (max 3x) ─────┘──► HALTED: a human decides
```

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TOPOLOGY: SWARM-MESH (2W) [CLAUDE]                     CYCLE: 1/3 | LOCKS: 2 │
│ PHASE:    2_EXECUTOR_SWARM                            UPTIME: 42s | PID: 1273│
│           1_PLANNER > [2_EXECUTOR_SWARM] > 3_VERIFIER > 4_COMMITTED          │
├──────────────────────────────────────────────────────────────────────────────┤
│ TASK:    Build API & Tests                                                   │
│ SWARM:   1/2 worker(s) finished (last: api)                                  │
│ VERIFY:  Running: npm test                                                   │
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
   Fix anything marked ✖.
6. Recommended: let your AI fill in your profile. In your editor's AI chat, type:
   > Read AGENTS.md and fill in my profile.

## 3. Everyday use — no coding needed

Everything is in **Command Palette → Tasks: Run Task**:

| Task | What it does |
|---|---|
| **Harness: 1. Start (live screen)** | Starts the background harness and shows the live screen (auto-starts on folder open). |
| **Harness: 2. New task (type what you want)** | Asks: *what to do*, *which files it may change* (optional), *how to check it* (optional), *which AI*. Then runs it and tells you **COMMITTED ✔** or **NOT DONE ✖**. |
| **Harness: 3. Teach the AI something** | Saves a rule, e.g. *"Always explain changes in simple English"*. Every AI in this folder follows it from then on. |
| **Harness: 4. Show memory** | Lists what the AI remembers. |
| **Harness: 5. Status + recent events** | What is happening now and the last events. |
| **Harness: Run Self-Test Cycle** | Proves the harness itself works (no AI needed). |

Or just **talk to your editor's AI chat**. It reads `AGENTS.md`, so you can say things like:
> Use the harness to add a contact form to the homepage, and check it with the tests.

> Remember that I want every answer as short numbered steps.

**About the "check":** the verifier is what makes this safe. If you leave the check empty and
the project has no tests, nothing really checks the work, and the harness tells you so. Ask
your AI chat to suggest a check command for your task.

## 4. The memory ("brain")

All memory is plain text in `.harness/memory/`, which you can open and edit yourself:

| File | Written by | Used for |
|---|---|---|
| `profile.md` | you / your AI | who you are, your level, your language, how you like answers |
| `lessons.md` | **you** (Teach task, or the AI when you correct it) | rules every AI must follow, with the highest priority |
| `auto-lessons.md` | the harness | what went wrong before (a task failed and then recovered, or stopped) |
| `sessions/*.md` | the harness | one record per task: what was asked, errors, result |

How it reaches each AI:
- **Harness workers** get profile + rules + recent lessons inside their prompt, every time.
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
> That makes it reliable and visible: you can read, edit or delete anything it remembers.
> Never put passwords or API keys in memory. If your repository is **public**, your memory is
> public too, so add the memory files to `.gitignore` if they are private.

## 5. AI engines

Set in `.harness/config.json` → `"activeProfile"`. The default `"auto"` uses the first
installed engine in `"autoOrder"`.

| Engine | Status |
|---|---|
| `claude` (Claude Code) | ✅ verified end-to-end (real agent edited a file, followed a memory rule, passed the verifier) |
| `antigravity` | ⚠️ flags copied from the original spec, **not verified** against a real CLI |
| `orca` | ⚠️ flags copied from the original spec, **not verified** |
| `gemini` (Gemini CLI) | ⚠️ not verified here (uses `--yolo`, which auto-approves everything) |
| `codex` (OpenAI Codex CLI) | ⚠️ not verified here |

To fix or add an engine, edit its `"args"`: put `{prompt}` where the prompt goes (leave it out
to send the prompt on stdin) and `{allowedTools}` where the tool list goes. Run
`<tool> --help` to see the real flags.

## 6. Settings (`.harness/config.json`)

| Key | Default | Meaning |
|---|---|---|
| `maxCycles` | 3 | tries before it stops and asks a human (`HALTED_HITL_REQUIRED`) |
| `workerTimeoutMs` / `verifyTimeoutMs` | 5 min / 10 min | kill a stuck worker / check |
| `useGitWorktrees` | false | **true** = each AI worker runs in its own git copy; only changes to its allowed files come back (real enforcement). Needs a git repo with at least one commit. Workers then see the last *commit*, not uncommitted edits. |
| `autoGitCommit` | false | **true** = make a git commit after each task passes |
| `defaultVerifyCmd` | always passes | the check used when a task has none and the project has no tests |
| `memory.*` | on | turn memory injection, session notes and auto lessons on/off |

## 7. For developers

```bash
node .harness/daemon.mjs                 # watch mode with live HUD (also: --once, --self-test)
node .harness/dispatch.mjs --help        # all dispatch options, incl. swarm --worker id:files:prompt
node .harness/memory.mjs list|remember|forget|context|sessions
node .harness/doctor.mjs                 # setup check
node .harness/status.mjs --log 25        # state + recent JSONL events
node test/run-tests.mjs                  # 16 end-to-end tests with a mock engine (no AI account needed)
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
A subtask with `cliCommand` and no `prompt` runs a plain shell command instead of an AI.

**Guarantees, each covered by a test:** a plan where two workers claim the same file (or one
claims a parent folder of another's file) is rejected before any worker starts; a missing engine
is rejected at once instead of being retried; a failed check feeds its error into the next
cycle; the loop stops after `maxCycles`; jobs end up in `completed/` or `failed/` (never stuck in
the inbox); state is written atomically; only one daemon runs per folder; workers cannot
dispatch new jobs (no runaway agent loops).

### Changes from the original master prompt
The original `setup-harness.mjs` was run first, unchanged, and passed its own self-audit. These
problems were then found and fixed:
1. **Real agents never ran.** The prompt was passed after `--allowedTools`, which Claude Code
   reads as more tool names → *"Input must be provided…"* on every cycle. The prompt now goes on stdin.
2. A lock collision was retried 3 times instead of being rejected before spawning; failed jobs
   stayed in the inbox and re-ran on every restart; jobs arriving while busy could be skipped.
3. `--allowedTools` / `--mcp-config` (Claude flags) were sent to every engine; engine commands
   are now per-profile templates. MCP is off by default (it downloaded a server on every run and
   its tools weren't allowed anyway).
4. The default engine `antigravity` has unverified flags, so the default is now `auto`.
5. HUD lines were wider than the box; it now fits, shows a plain-language next step, and the
   background task is visible (`reveal: always`) instead of hidden.
6. Added: memory, session notes, editor instruction files, `dispatch --goal/--files/--check/--wait`,
   doctor, status, installer, tests.
