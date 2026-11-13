# Engines

Short version: the harness uses whichever AI command-line tool you have installed and logged in to.
You log in with your subscription, never with an API key. Run `node .harness/doctor.mjs` to see
which engine will be used.

## Engines and how one is picked

Engine profiles live in `.harness/config.json` under `profiles`: `gemini`, `antigravity`,
`claude`, `orca`, `codex`.

- `activeProfile` is `auto`. You can also pick one per job with `--engine <name>`
  (`node .harness/dispatch.mjs ... --engine gemini`) or the `HARNESS_AGENT` environment variable.
- `auto` walks `autoOrder`: `gemini`, `antigravity`, `claude`, `codex` (`orca` has a profile but is not in `autoOrder`; opt in with `--engine orca`).
- It picks the **first** engine that is installed (its `binary` is on your `PATH`) **and** whose
  configured flags all appear in the output of `<binary> --help`.
- The logic is in `.harness/lib/common.mjs` (`probeEngine`, `resolveProfile`).

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
| `gemini` | binary `gemini`, args `--approval-mode yolo -p ""`, prompt on stdin | unverified |
| `antigravity` | binary `agy`, args `-p ""`, prompt on stdin, no auto-approve | unverified |

New projects (made with `node install.mjs <folder>`) start with Gemini auto-approve OFF: the installer drops
`--approval-mode yolo` from the Gemini profile. To allow it for one project, add `"--approval-mode", "yolo"` to the
`gemini` args in that project's `.harness/config.json`.

Decided by the owner: the Antigravity command is `agy`; Gemini may auto-approve every tool call
(`--approval-mode yolo`) in this project. `agy` has no auto-approve flag on purpose.

Still to confirm on a real machine (the probe rejects the engine and falls back if a flag is wrong):

- `gemini --help` lists `-p` and `--approval-mode`.
- `agy --help` lists `-p`, that `agy` reads the prompt from stdin when `-p` is empty, and which flag (if any) it uses for approvals.
- `doctor` warns when your first-choice engine (first in `autoOrder`) is not installed.

To fix a profile: run `<binary> --help`, propose the change to the owner, then edit
`.harness/config.json` and run doctor again.
