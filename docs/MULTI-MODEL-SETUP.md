# Multi-model setup: one team, several AI engines

The harness can give each role of the agent team its own AI engine. For example, `agy` does the
research and planning, `claude` writes the code and `codex` reviews it. This guide covers how that
works, how to log in to each tool, how to check that the tools really work, and how to change the routing.

## 1. How the harness talks to an engine

There is no server, SDK or API key. Each engine is a **command-line tool installed on your own machine**,
and the harness starts it as a local subprocess, the same way you would from a terminal:

```
harness controller ──spawn──▶ claude -p --output-format json ...   (prompt piped on stdin)
                   ──spawn──▶ agy -p ""                              (prompt piped on stdin)
                   ──spawn──▶ codex exec --full-auto -               (prompt piped on stdin)
```

- Each tool's command line is a **profile** in `.harness/config.json` → `profiles` (binary, args, how the prompt is passed).
- The tool uses **your own login** (your subscription), exactly as when you run it by hand. The harness never sees a password or a key.
- Before using a tool, the harness runs `<tool> --help` once. It checks that every flag in the profile is listed. A tool that fails this check is skipped (*flag probe*).
- Engine names in the harness: `claude` (Claude Code), `antigravity` (the `agy` command), `codex` (OpenAI Codex CLI), `gemini` (Gemini CLI).

## 2. Log in to each tool (once per machine, per person)

Everyone who uses the harness logs in with **their own** account on **their own** machine. Do not share logins,
and do not put API keys (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`) in this project.

| Engine | Install (see the tool's own docs) | Log in once |
|---|---|---|
| `claude` | Claude Code | run `claude` in a terminal and log in with your subscription |
| `antigravity` | Antigravity; its terminal command is `agy` | log in through the tool itself with your account |
| `codex` | OpenAI Codex CLI | run `codex` (or `codex login`) and sign in |
| `gemini` | Gemini CLI | run `gemini` and choose **Login with Google** |

Install only the tools you have a subscription for. **One engine is enough**: the harness then gives that
engine every role.

## 3. Check that each tool really works

Run these yourself in a terminal, one at a time. Each one is read-only.

1. **Is it on your PATH?** Windows: `where claude`. macOS/Linux: `which claude`. Do the same for `agy`, `codex` and `gemini`.
2. **Does it answer a prompt?** It should print a short reply and exit:
   ```bash
   echo "say hi" | claude -p
   ```
   ```bash
   echo "say hi" | agy -p ""
   ```
   ```bash
   echo "say hi" | codex exec -
   ```
   ```bash
   echo "say hi" | gemini -p ""
   ```
   If a tool asks you to log in instead, do step 2 for it first.
3. **Does the harness accept it?**
   ```bash
   node .harness/doctor.mjs
   ```
   Under **AI engines**, every tool you use should show `✔`:
   - `✖ … --help does NOT list: …` means the profile's flags don't match your version of the tool.
     Compare with `<tool> --help` and fix `args` for that profile in `.harness/config.json`.
   - `· not installed` means the tool is not on your PATH.

Today only the `claude` profile is verified end to end. The `antigravity`, `codex` and `gemini` profiles
follow those tools' documented flags but are marked `"verified": false` until someone confirms them with a
real run (see [`ENGINES.md`](ENGINES.md)).

## 4. Smart routing: give each role the right engine

```bash
node .harness/team.mjs auto-assign --dry-run    # show the routing it would use, change nothing
```
```bash
node .harness/team.mjs auto-assign              # write it into .harness/team.json
```

It detects which of `claude`, `agy`, `codex` and `gemini` pass the doctor's check on this machine, then routes by role:

| Engines usable on this machine | Planning / research<br>(`orchestrator` PO_ARCHITECT, `lead-ba` BA_ANALYST) | Coding<br>(`lead-dev` DEV_ENGINEER) | QA / review<br>(`lead-qa` QA_AUDITOR) |
|---|---|---|---|
| 3 or more (e.g. agy + claude + codex) | `agy` (else `gemini`) | `claude` | `codex` (else `claude`) |
| 2 (e.g. agy + claude) | the research engine (`agy`/`gemini`) | the other one | same as coding |
| 1 (any) | that engine | that engine | that engine |
| 0 | nothing changes: every member keeps `auto` | | |

With two engines and no research engine (e.g. claude + codex), planning goes to the one that is not
`claude`, so `claude` can do the coding and QA.

- **New installs do this automatically.** `node install.mjs <your-project>` runs `auto-assign` on the
  freshly installed `team.json`. To skip it, add `--no-auto-assign`. A `team.json` your project already had is never changed.
- **Only the `"engine"` field of each member changes.** Roles, scopes, budgets and skills stay as they are. Undo with
  `git checkout -- .harness/team.json`.
- **Logged in to a new tool later?** Run `auto-assign` again.
- See the result with `node .harness/team.mjs show` (each member shows `engine: …`) or in the doctor's "Agent team" section.
- `HARNESS_ENGINES="claude,codex" node .harness/team.mjs auto-assign` skips detection and routes to exactly those engines.

### Where the routing applies

- **Headless team mode** (`node .harness/dispatch.mjs --goal "…" --hierarchy`, the background controller and
  autonomous runs): the orchestrator, each lead and that lead's workers run on the member's engine.
- An explicit `--engine <name>` on a task **overrides** the routing for that whole task.
- If a routed engine is not usable when the task runs (logged out, uninstalled), that member **falls back to
  `auto`**. You see `ENGINE_FALLBACK` in the log, and the doctor warns about it.
- **Editor mode** (`/harness:run` inside Claude Code): the named agents run inside your Claude Code session, so
  they use Claude regardless of the routing.

## 5. Customize the routing by hand

Each member in `.harness/team.json` can carry an `"engine"`, which is any profile name from `config.json`:

```json
{ "id": "lead-qa", "level": "lead", "role": "QA_AUDITOR", "engine": "gemini", "scope": ["tests/**", "test/**"], ... }
```

- Remove the `"engine"` field (or don't set it) to use `auto` for that member (`autoOrder` in `config.json`).
- `node .harness/team.mjs validate` (and the doctor) reject an engine name that is not a profile in `config.json`.
- `orca` is never chosen by `auto-assign` or `auto`. You can still set `"engine": "orca"` by hand once its profile is fixed.
- After editing `team.json`, run `node .harness/team.mjs validate`.

## 6. Troubleshooting

| You see | Do this |
|---|---|
| `Usable AI engines on this machine: none` | Install and log in to at least one tool (section 2), then check it (section 3). |
| A tool works in your terminal but the doctor says `not installed` | The harness looks on `PATH`. Open a new terminal after installing, or add the tool's folder to `PATH`. |
| `--help does NOT list: …` | Your tool version has different flags. Fix that profile's `args` in `.harness/config.json`. |
| `ENGINE_FALLBACK` in `.harness/telemetry.log` | A routed engine was not usable at run time. Run the doctor, log in again, then `auto-assign`. |
