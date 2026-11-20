---
name: engine-profile-checks
description: Rules for adding or fixing an AI CLI engine profile in config.json and its probe, so a wrong flag falls back instead of hanging.
roles: ["DEV_ENGINEER", "QA_AUDITOR"]
allowedTools: ["Read", "Edit", "Write"]
keywords: ["probeengine", "engine profile", "engines.mjs", "autoorder", "antigravity", "engine-probe"]
autoApply: false
---
# Engine profile checks

1. Take flags from the real `<cli> --help` and from a real run, not from memory or the web. Mark a profile `"verified": false` until a real task ran on the owner's machine, and record what was tested in `docs/ENGINES.md`.
2. Do not assume a CLI reads its prompt from stdin. Test it. Example: `agy` fails with `error: empty prompt` when `-p` is empty, so its profile passes the prompt as an argument (`promptVia: "arg"`, `-p {prompt}`). Use stdin only for a CLI proven to read it (for example `claude -p`, `codex exec ... -`).
3. A long prompt on the command line can break the platform limit. The controller spills prompts over `maxArgPromptChars` to a file; keep that behaviour in mind when you change how a prompt is delivered.
4. On Windows a native `.exe` is spawned with `shell: false`; a `.cmd` shim goes through `winQuote` (`.harness/lib/common.mjs`).
5. Auto-approve flags (for example `--dangerously-skip-permissions`) are a per-project owner decision. Do not put them in a profile that new installs copy.
6. An installed, logged-in CLI is never used silently: the owner allows it per machine with `node .harness/engines.mjs allow <tool>` (saved in git-ignored `.harness/approvals.json`). Tests use fake engines and an `approvals.json` written by the test.
7. The probe (`probeEngine` in `.harness/lib/common.mjs`) only proves that flag names appear in `--help`. It cannot prove prompt delivery, so say what was not verified.
8. If `--help` prints nothing, only a `verified: true` profile is trusted; an unverified profile is rejected and `auto` falls through to the next engine.
9. The probe cache key includes `PROBE_VERSION` and the profile's `verified` value. Bump `PROBE_VERSION` whenever the probe logic changes.
10. `autoOrder` decides who runs first; doctor warns when the first-choice engine is missing. Tests use fake CLIs on a restricted `PATH` in `test/engine-probe.test.mjs`: compatible, incompatible and falls back, not installed, silent help, stale cache.
