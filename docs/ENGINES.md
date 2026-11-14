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

- Aliases only, never pinned versions. `claude` uses `haiku`, `sonnet` and `opus`, which Claude Code resolves to the newest release.
- `null` means no `--model` flag, so the CLI uses its own newest default. This is the setting for `codex` today.
- `agy` has no aliases, so Antigravity uses exact IDs from `agy models`: `fast` = `gemini-3.8-flash-medium`, `medium` (coding) = `gemini-4-argon-medium`, `high` (planning) = `gemini-4-hydrogen-high`. Real runs on all three tiers passed on 2026-11-14 (Flash: create a file; Argon: write add(a, b); Hydrogen: write mul(a, b); each checked by a real command and COMMITTED).

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
| `antigravity` | binary `agy`, args `-p {prompt}` (prompt as argument), no auto-approve | verified on Windows 11 / Node 24 with `agy` 1.5.8 (2026-11-14): a scoped file task ran, the real check passed and the job was COMMITTED, also with a 3,049-character goal; all three model tiers (Flash, Argon, Hydrogen) passed real runs |
| `codex` | binary `codex`, args `exec --full-auto -`, prompt on stdin | unverified: not installed on the machines tested so far |

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
