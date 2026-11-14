# Engines

Short version: the harness uses whichever AI command-line tool you have installed and logged in to.
You log in with your subscription, never with an API key. Run `node .harness/doctor.mjs` to see
which engine will be used.

## Engines and how one is picked

Engine profiles live in `.harness/config.json` under `profiles`: `antigravity`, `claude`, `codex`.

- `activeProfile` is `auto`. You can also pick one per job with `--engine <name>`
  (`node .harness/dispatch.mjs ... --engine antigravity`) or the `HARNESS_AGENT` environment variable.
- `auto` walks `autoOrder`: `antigravity`, `claude`, `codex`.
- It picks the **first** engine that is installed (its `binary` is on your `PATH`) **and** whose
  configured flags all appear in the output of `<binary> --help`.
- The logic is in `.harness/lib/common.mjs` (`probeEngine`, `resolveProfile`).

## Model tiers and "always latest" aliases

Each profile may have `"models": { "fast", "medium", "high" }` and `"modelArgs"` (e.g. `["--model", "{model}"]`).
The controller picks a tier per agent from the job's complexity. Small edits, docs and QA get `fast`, normal coding gets `medium`,
architecture planning gets `high`, and a failed check escalates one tier. The tier's alias is then passed to the CLI.

- Claude Code: the CLI's own aliases, which it resolves to the newest release, so nothing needs editing when a model ships.
- Codex: one model with a reasoning effort per tier, written `name@effort` and passed as `--model name -c model_reasoning_effort=effort`.
  This also overrides a high default effort in `~/.codex/config.toml`. Names come from `codex debug models`.
- Antigravity: `agy` has no aliases, so its tiers use exact IDs from `agy models`. Real runs on all three tiers passed on
  2026-11-14 (create a file, write add(a, b), write mul(a, b); each checked by a real command and COMMITTED).
- The model names themselves live only in `.harness/config.json` → `profiles.<engine>.models`.

## Every agent gets a model that fits its job

The controller never leaves the model to chance. Per agent it picks a tier from the job, then the model of that tier:

| Agent | Tier |
|---|---|
| orchestrator, PO architect (plan across modules) | high |
| lead-ba, lead-dev (split their own slice) | medium |
| lead-qa, docs/QA workers, 1-file small edits | fast |
| coding workers (several files) | medium |
| any retry after a failed check | one tier up |

Each tier maps to one model per engine in `.harness/config.json`; `node .harness/team.mjs show` prints the result.

- An empty tier uses the nearest configured one, so a CLI default is never used by accident. Only an engine with no
  model names at all runs on its own default, and `doctor` warns about it.
- In Claude Code, the named agents get their model too (`model:` in `.claude/agents/lead-*.md`, written by
  `node .harness/team.mjs sync-agents`): lead-ba and lead-qa get the fast tier, lead-dev the medium tier. Without it they
  would inherit your session model (often the most expensive one) for simple docs and tests.
- See every agent's model: `node .harness/team.mjs show`. The live feed prints the model each agent starts on.
- Override for one member: `"model"` in `team.json` (an alias or a tier name); for one task: `dispatch --model`.

## Saving quota: reroute, daily caps, usage report

- **Out of quota → another tool.** When a tool stops on its usage limit (or its daily cap), the same agent retries once
  on another tool you allowed, on the same tier: claude → agy (Antigravity's Claude models), codex → agy, agy → claude.
  It switches at most once, so two empty tools never loop. The live feed shows `⇄ codex usage limit → continuing on
  antigravity`; the log has `QUOTA_FALLBACK`. Tested on 2026-11-14 with a real Codex usage limit: agy finished the task.
  Set in `config.json` → `quotaFallback`; remove an entry to turn it off.
- **Daily caps.** `config.json` → `dailyLimits`, per engine: `calls`, `tokens` (engines that report them, e.g. Claude)
  and `usd`. The template ships with **antigravity: 80 calls/day** and **claude: $5 or 60 calls/day** (whichever comes
  first); change or remove them there. When a cap is reached the agent is not started (`DAILY_LIMIT`);
  Claude work can still continue on agy. Counted by the controller from its own log, per UTC day.
- **Where did it go?** `node .harness/usage.mjs` (or `npm run usage`) lists calls, tokens, cost and minutes per day,
  engine and model. Antigravity does not report tokens, so it is counted in calls.
- **Renamed models.** `doctor` runs `agy models` and warns when a configured model ID no longer exists.

## Each AI tool is allowed once

A tool that is already installed and logged in on your machine (`claude`, `agy`, `codex`) is **never used silently**.
The first time the harness would use it, it asks in the terminal: *Let the harness use it? It spends your own
subscription / quota. [y/n]*. After a yes it is used automatically; after a no it is skipped. Answers are saved per
person in `.harness/approvals.json` (git-ignored), so every teammate decides for their own machine.

```bash
node .harness/engines.mjs              # list the tools and answer the ones not decided yet
node .harness/engines.mjs allow agy    # or: deny agy
```

Without a terminal (an AI or a script calling dispatch) nothing is asked: if no tool is allowed, dispatch starts nothing
and exits with `ENGINE_APPROVAL_NEEDED` (code 3). `doctor` shows each tool as ALLOWED, not allowed, or waiting for your OK.

## Big runs ask first

`dispatch.mjs` asks in the terminal before a run that may use a lot of tokens or quota: team or parallel mode, 3 or more
workers, or `--model high` (or a high-tier model by name). A normal one-worker run is never asked. Answer `y` (start),
`n` (stop) or `a` (start, and do not ask again for that kind of run; saved per person in `.harness/approvals.json`,
which is git-ignored). `--yes` skips the question. With no terminal (an AI or a script calling it) it starts nothing and
exits with `APPROVAL_NEEDED` (code 3): the AI must ask you in chat and re-run with `--yes` only if you agree.

**Autopilot (`npm run auto`)** runs normal tasks without asking. A READY task that would be a big run is **held**:
it becomes BLOCKED with *Needs your OK*, its files are untouched, and autopilot moves on to the next task. Approve it with
`node .harness/backlog.mjs approve <id>`. Autopilot also never moves up to the high (most expensive) model on its own:
a retry that would reach it stays on medium (`AUTO_TIER_CAPPED` in the log) unless that task was approved, or you
answered `a` for `--model high` once.
- Override with `dispatch --model <tier|alias>` or `"model"` on a `team.json` member.

Details and the full rules: [`MULTI-MODEL-SETUP.md`](MULTI-MODEL-SETUP.md#6-model-tiers-the-right-sized-model-for-each-job-saves-tokens).

## Log in with your subscription (no API keys)

- Policy: subscription only. Do **not** set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in your
  environment or in any file in this project.
- Antigravity: log in through the Antigravity app with your Google account.
- Claude Code: run `claude` once and log in with your subscription.
- Codex: run `codex` once and log in.

## Check your setup with doctor

```bash
node .harness/doctor.mjs     # or: npm run doctor
```

Doctor runs `<binary> --help` for each engine and lists any configured flag that is missing.
An engine with a missing flag will not be used.

## What ENGINE_FALLBACK means

If you choose an engine explicitly and it is not installed, or its `--help` lacks a configured
flag, the harness does not stop. It falls back to `auto` and writes an `ENGINE_FALLBACK` line to
`.harness/telemetry.log`, saying which engine was unavailable, why, and which one it used instead.
If you see it, run doctor and fix the engine (install it, log in, or correct its flags).
The task stops only if no engine is usable at all.

## Cloud sessions

Cloud sessions (for example Claude Code on the web) have no browser, so you cannot log in to
Antigravity there. Cloud sessions therefore use Claude Code. Antigravity is for your own machine.

## Verified and unverified profiles

Profiles in `.harness/config.json` have `"verified": false` until a real run with that tool
succeeds. Today `claude` and `antigravity` are `"verified": true`.

| Profile | Configured now | Status |
|---|---|---|
| `claude` | binary `claude`, `-p`, prompt on stdin | verified |
| `antigravity` | binary `agy`, args `-p {prompt}` (prompt as argument), no auto-approve | verified on Windows 11 / Node 24 with `agy` 1.5.8 (2026-11-14): a scoped file task ran, the real check passed and the job was COMMITTED, also with a 3,049-character goal; all three model tiers passed real runs |
| `codex` | binary `codex`, args `exec --sandbox workspace-write -`, prompt on stdin, `--model` + reasoning effort | partly verified with codex-cli 0.169.0 (2026-11-14): flags, model and effort accepted (`approval: never`, `sandbox: workspace-write`); a full task has not completed yet, so not marked verified |

Notes for Antigravity:

- `agy.exe` lives in `~/.gemini/bin`, which is not on PATH by default. Add that folder to PATH, or doctor reports `agy` as not installed.
- `-p` is an alias of `--print`. `agy` does NOT read the prompt from stdin when `-p` is empty (`error: empty prompt`), so the prompt is passed as an argument.
- Windows limit: a command line is at most 32,767 characters (8,191 through `cmd.exe`, which `.cmd` shims use). 3,049 characters worked; a much longer prompt can still fail.
- `agy` has no auto-approve flag in the profile on purpose (it has `--dangerously-skip-permissions` and `--mode`). Scoped file edits worked without it.

To fix a profile: run `<binary> --help`, propose the change to the owner, then edit
`.harness/config.json` and run doctor again.

## Removed engines

- **Gemini CLI** (removed 2026-11-14). A real run on Windows stopped at login with
  `IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals`,
  and Google points those accounts to Antigravity. Use `antigravity` instead. Using `--engine gemini`
  now stops with a clear message, and the installer (also `install.mjs --reset`) drops a leftover
  `gemini` profile from a project's `config.json`. `GEMINI.md` stays, because Antigravity reads it.
- **Orca**: removed because its flags could not be verified. It can come back when someone tests it
  on a real machine and adds a profile to `config.json`. Using `--engine orca` stops with a clear message.
