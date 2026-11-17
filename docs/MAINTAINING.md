# Maintaining the Agentic Harness

Khmer version: [`MAINTAINING.km.md`](MAINTAINING.km.md).

## Lab, template, projects

| | What it is | Who changes it |
|---|---|---|
| **Lab**: branch `lab` of this repository | where the harness is built and tried for real, every day | the owner (and an AI with them) |
| **Template**: branch `release` of this repository | the tested version: what `npx github:sumtaimo/Agentic-Harness#release` installs and what the landing page shows | nobody directly: the lab is copied into it after it passed, with the owner's yes |
| **Projects** | any repository that installed the harness (yours or other people's) | their own settings only; the harness core is read-only there |

So a change in the lab never reaches users by itself: it reaches them when the owner releases it.

There are two jobs, and they never mix:

| | **Using** the harness | **Maintaining** the harness |
|---|---|---|
| Where | any project it is installed in (it has `.harness/MANIFEST.json`) | this template repository (it has `install.mjs` and this file) |
| Who | you, your team, and the AI agents working on the project | the template owner (and an AI working with them here) |
| May change | the project's own settings: `config.json`, `charter.md`, `team.json`, `roles/`, `skills/`, `backlog.json`, `memory/` | everything, through the checklist below |
| Must not change | the harness core: `.harness/*.mjs`, `.harness/lib/**`, `.harness/MANIFEST.json` | the owner's rules (below) |

## How the core is protected in a project

- The installer writes `.harness/MANIFEST.json`: a fingerprint of every core file and the template version.
- `node .harness/doctor.mjs` compares them and warns when a core file was edited, deleted or added.
- Claude Code gets deny rules in the project's `.claude/settings.json`, so its agents cannot edit the core.
- The session hook and `AGENTS.md` tell every AI: use the harness, do not patch it; report the gap instead.
- Autonomous agents could never write to `.harness/**` anyway (`forbiddenPaths` in `charter.md`).

The template repository has none of these blocks, so it can be maintained.

## Reporting a gap (from a project)

Found a bug or a missing feature in the harness while using it? Do not fix it inside the project: the fix would be lost
on the next update and other projects would never get it. Instead, open an issue on the template
(<https://github.com/sumtaimo/Agentic-Harness/issues>) with:

1. what you ran, what you expected, what happened;
2. the output of `node .harness/doctor.mjs`;
3. the template version (`"version"` in `.harness/MANIFEST.json`);
4. for a failed task, the trace in `.harness/failed/*.trace.txt` (remove anything private first).

When the fix is released (branch `release`), update the project: `npx github:sumtaimo/Agentic-Harness#release .`. Your config, charter, team,
backlog and memory are kept; the core and its fingerprints are replaced.

## Release checklist (maintainers)

Run these in the template repository, in order. Nothing goes to `lab` until all pass **and the owner says yes**.

1. `npm test`: the free test suite (fake engines only; it hides the real AI CLIs on your machine).
2. `npm run audit -- --site`: installs into an empty project as a new user would and checks every command, the docs'
   references, the owner's rules and the website build. Free; it never calls an AI tool.
3. A real run, only when an engine's command line or models changed, and only with the owner's OK (it spends quota):
   one tiny task in a scratch project (`npm run demo`, then the `hello.txt` task in `docs/ENGINES.md`).
4. Bump `"version"` in `package.json` when the core changed (every install records it).
5. Commit on `lab`, then ask the owner before pushing. A normal push only. Pushed from a session worktree? Also update
   the main folder (`git pull --ff-only` there): new sessions start from it. The session hook warns when it is behind.
6. **Release**: when the lab version has been used for real and the owner says "release", copy it to the template:
   `git push origin lab:release` (a normal push; never force). Users installing from `#release` and the landing page
   (deployed from `release`) get it from then on. Nothing reaches users before this step.

## The owner's rules

- Ask before every push, before changing `.harness/config.json` or `.harness/charter.md`, before installing global
  software or adding dependencies, and before anything that spends money or AI quota.
- Never force-push or rewrite the history of `lab` or `release` without an explicit yes for that exact action.
- Never start autonomous runs (`npm run auto`, `/harness:auto`) unless told to.
- No model names in commits, code comments or docs: they live only in `.harness/config.json`
  (`npm run audit` checks it, using the names in the config).
- Zero dependencies: Node standard library only.
- No personal account, quota or login details in the repository or in commit messages.
- An engine is `"verified": true` only after a real successful run, and its note says how.

## Common maintenance jobs

- **A model was renamed or a new one shipped.** Run `agy models` or `codex debug models`; update
  `profiles.<engine>.models` and any `quotaFallback.*.models` in `config.json`; `doctor` must then list no unknown
  IDs. Claude Code uses aliases, so it needs no change.
- **A CLI changed its flags.** Run `<tool> --help` (for Codex: `codex exec --help`); update `args` in the profile; the
  flag probe and `doctor` confirm it; then do the real run in step 3.
- **Adding or removing an engine.** Profile in `config.json`, `ROUTABLE_ENGINES` (and `REMOVED_ENGINES` when
  removing) in `.harness/lib/common.mjs`, the routing rules in `.harness/lib/governance.mjs` and their copy in
  `website/src/lib/routing.ts`, the tests, `docs/ENGINES.md` and the README engine table.
- **Changing team scopes or roles.** `node .harness/team.mjs validate`, then `node .harness/team.mjs sync-agents` so
  the Claude Code agents match. A file-type scope (like `src/**/*.test.*`) owns its files even inside another lead's
  folder scope (like `src/**`), so every file still has exactly one owner.
