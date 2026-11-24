# Prompt to continue the work in a new session (any account, any editor)

Copy everything in the block below into the new session as your first message.
Keep this file current: whoever finishes a piece of work updates it and the handoff note
(`docs/notes/handoff-2026-11-23-step2.md`) in the same commit.

```text
You are continuing work in the Agentic Harness TEMPLATE repository (sumtaimo/Agentic-Harness). Earlier sessions finished Steps 1–4 on branch `lab`: product foundation & intake, Done vs Good + UX `docs/ux/` + visual gate, Antigravity model update + automatic model fallback (`0520001`), charter `UX_DESIGNER` update, old-project design & slash-command upgrade support (`install.mjs`), and non-TTY `visual confirm` hardening.

Start by reading, in this order:
1. AGENTS.md
2. .harness/memory/lessons.md
3. docs/notes/handoff-2026-11-23-step2.md (current state, remaining tasks, risks)
4. docs/MAINTAINING.md (the maintainer flow)

Rules:
- You MAINTAIN the harness here. Work only on branch `lab`. Do not create branches or worktrees (lesson L2).
- Before you start, run `git fetch origin lab && git pull --ff-only` so you do not overwrite another session's work. Pull again before every commit.
- Do NOT run `git push`, and never touch `release`, until I say "push" or "release" in this chat.
- No version bump and no CHANGELOG entry until I say so.
- Ask me before editing .harness/charter.md or .harness/config.json.
- Every change must pass `npm test` and `npm run audit`.
- Do not edit .harness/releases/ or anything under node_modules.

Your tasks, in order:
1. Run `git checkout lab && git pull --ff-only`, then `git log --oneline -5`. Confirm the latest Step 2/Step 3 commits are present.
2. Run `npm test`, `npm run audit` and `npm run audit -- --site` if code changed since the last check (if the website build fails once, run `cd website && npm ci` and retry).
3. Check the remaining external/release items (items 2, 3, and 7) in `docs/notes/handoff-2026-11-23-step2.md` (items 1, 4, 5, 6 are done): skill-library risk check with maintainers, Skill Foundry `spec-writer` Flow & State Table (separate repo), and release (`package.json` version bump + `CHANGELOG.md` + `git push origin lab:release`) only when the owner explicitly says "release".
4. After each finished change: run the tests and the audit, commit on `lab` with specific `git add` paths, and ask me before pushing.
5. At the end, update the handoff note and this file so they match the real state, and report: what changed, exact test results, and what is still open.

Talk to me in short, plain language. Khmer is fine if I write in Khmer.
```

## If two sessions work at the same time
- Both use `lab`. The one who pushes second must `git pull --rebase` first only if the owner agrees; otherwise `git fetch origin lab && git merge --no-edit FETCH_HEAD`, then push. Never force-push.
- Split the work by file so you do not collide: for example one session on the docs and the charter, another on tests.
