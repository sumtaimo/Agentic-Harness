---
name: template-leak-check
description: Keeps an owner's personal settings out of new installs and out of tests when changing install.mjs, the test sandbox or any owner-specific file.
roles: ["DEV_ENGINEER", "QA_AUDITOR"]
allowedTools: ["Read", "Edit", "Write"]
keywords: ["install.mjs", "--reset", "sandbox", "new install", "leak check"]
autoApply: false
---
# Template leak check

Anything the owner chose for THIS repo must not travel to a new project or into the test sandbox.

Owner-specific data: `.harness/charter.md` (objectives and the autonomous on/off lock), `.harness/config.json` (for example per-project choices), `.harness/backlog.json`, run state under `.harness/visible/`, the per-person `.harness/approvals.json` (git-ignored), and the owner's notes in `CLAUDE.local.md` or `auto-lessons.md` (git-ignored). `profile.md` and `lessons.md` ship generic starter versions in the repo; personal rules go to `CLAUDE.local.md` or `node .harness/memory.mjs learn`, never into the committed `lessons.md`.

When you add or change an owner-specific setting:
1. Decide the default a new project gets and write it down.
2. Put that default in the shared clean-default code in `install.mjs` (the `*_TEMPLATE` strings and the `clean*` functions). A normal install and `--reset` must both use it. Never add a second copy of a rule.
3. Reset it in `sandbox()` in `test/run-tests.mjs`, so tests do not read the owner's copy.
4. Add or extend a test that checks all of: a fresh install gets the default, an existing project file is kept, `--reset` restores the default and touches nothing else, and the owner's own repo keeps its value.
5. If `.gitignore` changes, update `GITIGNORE_BLOCK` in `install.mjs` (a test fails when they differ).
6. Document the default in `README.md`, in the Quick Install section.

Never run `node install.mjs --reset` in the owner's own working copy: it would erase their settings. `--reset` writes no backup outside git.
