# Engines

Short version: the harness uses whichever AI command-line tool you have installed and logged in to.
You log in with your subscription, never with an API key. Run `node .harness/doctor.mjs` to see
which engine will be used.

## Engines and how one is picked

Engine profiles live in `.harness/config.json` under `profiles`: `gemini`, `antigravity`,
`claude`, `codex`.

- `activeProfile` is `auto`. You can also pick one per job with `--engine <name>`
  (`node .harness/dispatch.mjs ... --engine gemini`) or the `HARNESS_AGENT` environment variable.
- `auto` walks `autoOrder`: `gemini`, `antigravity`, `claude`, `codex`.
- It picks the **first** engine that is installed (its `binary` is on your `PATH`) **and** whose
  configured flags all appear in the output of `<binary> --help`.
- The logic is in `.harness/lib/common.mjs` (`probeEngine`, `resolveProfile`).

## Model tiers and "always latest" aliases

Each profile may have `"models": { "fast", "medium", "high" }` and `"modelArgs"` (e.g. `["--model", "{model}"]`).
The controller picks a tier per agent from the job's complexity. Small edits, docs and QA get `fast`, normal coding gets `medium`,
architecture planning gets `high`, and a failed check escalates one tier. The tier's alias is then passed to the CLI.

- Aliases only, never pinned versions. `claude` uses `haiku`, `sonnet` and `opus`, which Claude Code resolves to the newest release.
- `null` means no `--model` flag, so the CLI uses its own newest default. This is the setting for `gemini`, `codex` and `agy` today.
- Override with `dispatch --model <tier|alias>` or `"model"` on a `team.json` member.

Details and the full rules: [`MULTI-MODEL-SETUP.md`](MULTI-MODEL-SETUP.md#6-model-tiers-the-right-sized-model-for-each-job-saves-tokens).

## Log in with your subscription (no API keys)

- Policy: subscription only. Do **not** set `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` in your
  environment or in any file in this project.
- Gemini: run `gemini` in a terminal once and choose **Login with Google**.
- Antigravity: log in through the tool itself with your account (the exact command is still
  open; see the last section).
- Claude Code: run `claude` once and log in with your subscription.

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

Cloud sessions (for example Claude Code on the web) have no browser, so you cannot do a
"Login with Google" there. Cloud sessions therefore use Claude Code. Gemini and Antigravity are
for your own machine.

## Unverified profiles and open questions

Profiles in `.harness/config.json` have `"verified": false` until a real run with that tool
succeeds. Today only `claude` is `"verified": true`.

| Profile | Configured now | Status |
|---|---|---|
| `gemini` | binary `gemini`, args `--skip-trust --approval-mode yolo -p ""`, prompt on stdin | unverified: flags exist in `--help` (0.68.0); a full headless run is not done yet |
| `antigravity` | binary `agy`, args `-p {prompt}` (prompt as argument), no auto-approve | unverified: `-p ""` with stdin fails (`empty prompt`); a full run with the argument form is not done yet |

New projects (made with `node install.mjs <folder>`) start with Gemini auto-approve OFF: the installer drops
`--approval-mode yolo` from the Gemini profile. To allow it for one project, add `"--approval-mode", "yolo"` to the
`gemini` args in that project's `.harness/config.json`.

Decided by the owner: the Antigravity command is `agy`; Gemini may auto-approve every tool call
(`--approval-mode yolo`) in this project. `agy` has no auto-approve flag on purpose.

Still to confirm on a real machine (the probe rejects the engine and falls back if a flag is wrong):

- Checked on Windows 11 / Node 24: `gemini --help` (0.68.0) lists `-p`, `--approval-mode` and `--skip-trust`. Without `--skip-trust`, an untrusted folder makes it override approval mode and exit 55.
- Checked: `agy --help` (1.5.0) lists `-p` (alias of `--print`), `--model`, `--effort`, `--mode`, `--dangerously-skip-permissions`. `agy` does NOT read the prompt from stdin when `-p` is empty. Still to confirm: that `-p "<prompt>"` runs a task. Windows limit: a command line is at most 32,767 characters (8,191 through `cmd.exe`, which `.cmd` shims use), so a very long prompt passed as an argument can fail; multi-line prompts also depend on Windows argument quoting.
- `agy.exe` lives in `~/.gemini/bin`, which was not on PATH; add it or doctor reports `agy` as not installed.
- `codex` was not installed, so nothing about it is confirmed.
- `doctor` warns when your first-choice engine (first in `autoOrder`) is not installed.

To fix a profile: run `<binary> --help`, propose the change to the owner, then edit
`.harness/config.json` and run doctor again.

## Removed: Orca

Orca was removed because its flags could not be verified. It can come back when someone tests it on a real machine and adds a profile to `config.json`. Using `--engine orca` now stops with a clear message.
