# Changelog

One entry per released version (newest first). Each entry says what changed, who is affected, any change to
config, permissions or hooks, and what to do after updating. Update a project with:

```
npx github:sumtaimo/Agentic-Harness#release .
```

The installer keeps your `config.json`, charter, team, backlog and memory; it replaces the harness core and prints
the entries newer than the version you had.

## 1.0.42 — 2026-11-22

- **Bug hunt: no invented expectations.** The hunter must take "expected" from a source it can name (spec, test, docs,
  a caller) and may count odd inputs (NaN, null, reversed ranges) only when a real caller passes them or a source names
  them. Found by the Skill Foundry bug-hunter live runs: agents reported clamp(NaN) with an expected value they chose.
- The feature BA and hunt QA planner calls get the same `[SHELL]` line workers got in 1.0.39 (only their own commands).
- *Affects:* `hunt` findings (fewer false alarms). *Config:* none.

## 1.0.41 — 2026-11-22

- **Fix: a backlog item's goal never reached its workers** when the item had its own workers (feature steps, bug
  fixes, PO tasks). So feature workers did not see the feature, screen states or spec path, and bug-fix workers did not
  see the evidence or the Red-Green / Symptom-Root Cause-Blast Radius rules. The goal now reaches every worker as its
  `[OVERALL GOAL]` (found while preparing a skill test for Skill Foundry).
- **`feature.mjs prompt` / `hunt.mjs prompt` print the exact headless prompt** (roles, allowed paths, repo map,
  project files, skills) instead of a shorter one, so an editor agent sees the same as a headless run.
- The hunt's skill topic is now just "bug hunt" (was "bug hunt regression tests"), so a dedicated bug-hunter skill
  ranks first instead of test-champion, which matched "tests"/"regression" more often.
- *Affects:* every feature step, hunt fix and PO task (workers get more context). *Config:* none.

## 1.0.40 — 2026-11-21

- **`feature` and `hunt` without a command to remember:** `npm start` → `[2] New task` now offers `[4] feature` and
  `[5] hunt`, and VS Code has two buttons, *Harness: Big feature* and *Harness: Bug hunt* (Run Task menu). Nothing else
  changed in the menu: `[1]`–`[3]` work as before.
- *Affects:* the menu and `.vscode/tasks.json` (the installer merges the two new tasks into yours). *Config:* none.

## 1.0.39 — 2026-11-21

- **`feature` and `hunt` now use skills.** BA expanding a feature and QA hunting bugs get matching skills the same way
  workers do: by role and keywords (the job — "feature user workflow journey spec …" or "bug hunt regression tests" —
  plus your text), at most 2, a fitting skill that is not installed yet is fetched from Skill Foundry first (controller
  only; off with `"skillFetch": false`). They arrive by keyword, so they bring rules and never take a tool away. The
  editor path (`feature.mjs prompt`, `hunt.mjs prompt`) prints the same skills. Logged as `1_ROLE_SKILL_MATCH`.
- **Workers are told their exact shell commands** up front (`[SHELL]: you may run ONLY …`, from their role and skills;
  no cd, pipes, `node -e` or temp scripts). In a real trial workers spent turns on commands their role denies.
- **`doctor` says how to let workers open the app in a browser** when the project has UI files and the `playwright`
  MCP preset is off (it stays off by default — owner's decision; QA and UX keep no `node`).
- *Affects:* every `feature` / `hunt` run when a matching skill exists (today: `spec-writer` for BA, `test-champion`
  and `security-guard` for QA, by keyword). *Config:* none.

## 1.0.38 — 2026-11-21

- **New: `hunt` — bug hunt with evidence.** `npm run hunt -- "checkout" --files src/cart/` (or `/harness:hunt`):
  QA_AUDITOR, without Edit/Write (it may run the project's tests), looks for real bugs only — wrong results, crashes,
  data loss, security holes, broken states, missing validation or permissions; never style. Every finding carries
  file:line, evidence, repro, expected and actual: ✅ **confirmed** when a command really failed, 🟡 **suspect** when
  found by reading only. Findings without evidence, without a Red-Green fix plan (a QA test + a code fix, test files
  QA-only), duplicates and anything over the limit (10, `--max`, never above 20) are dropped and named in the report
  (`docs/bugs/H1.md`).
- **You keep the bugs to fix:** `hunt approve H1 --keep 1,3` (or `--all`). Each kept bug becomes one READY `bugfix` item,
  most severe first, fixed Red-Green by autopilot on `uat` (QA writes a test that fails because of the bug, DEV fixes
  the root cause, report Symptom / Root Cause / Blast Radius, no weakened tests). Keeping a 🟡 suspect is warned.
- A backlog item's `"bugfix": true` now reaches headless jobs too (it already reached editor briefs).
- **Fixed in a real trial run (Claude, demo project):**
  - **Autopilot planned unrelated work** while feature steps were READY but waiting for an earlier step (or were just
    held for your OK): the PO invented two new tasks. Now autopilot reports "waiting" and plans nothing; `visible.mjs
    brief --next` says "the backlog is NOT empty — do not propose" (`/harness:auto` follows it).
  - **Approved feature steps and bug fixes were held again** for "several workers at once". Approving them after
    seeing their workers is your OK for those runs; `approve` says so.
  - **The bug hunt ran on the smallest model.** It now runs on at least the medium tier.
- *Affects:* nobody until you use it. *Config:* none. Hunts are stored in `backlog.json` under `"hunts"`. New command
  `/harness:hunt` and script `npm run hunt`.

## 1.0.37 — 2026-11-21

- **One "Needs you" list.** `status` (and `status --json` as `needsYou`) lists everything that waits for you in one
  place, each with the one command that moves it on: feature drafts and 🟡 decisions, bug hunts to review, items held
  for your OK, BLOCKED items, failed jobs. The session start shows features and hunts waiting for you.
- **Whole-journey test in every feature.** BA's last step is a QA test that walks the user through every step end to
  end (🧭 in the spec). On approve it waits for every step you kept. Dropping it, or a feature without one, is named.
- *Affects:* `status` output gains a "Needs you" block. *Config:* none.

## 1.0.36 — 2026-11-21

- **New: `feature` — a big feature from a short goal.** `npm run feature -- "login"` (or `/harness:feature login` in
  Claude Code): BA_ANALYST, read-only, grows the goal into the whole user workflow (for "login": sign up, log in, wrong
  password, forgot password, staying logged in, reload, log out, permissions). Each step lists what the user does, screen
  states, validation, reload, permissions, acceptance criteria, size and which steps come first; guessed business rules
  are marked 🟡 as questions for you. The steps and a spec page (`docs/features/<name>.md`) are a DRAFT: **nothing is
  built until you keep steps** with `feature approve F1 --keep 1,2,5` (or `--all`). Kept steps become READY backlog
  items that autopilot builds on `uat` as usual.
- Every step's workers are checked like a PO task before you see the draft (role scopes, charter paths, no overlap). In
  a feature, test files belong to QA_AUDITOR in every step. At most 12 steps per feature (`--max`, never above 20).
- **Backlog items can wait for others:** an item with `"dependsOn": ["F1-S1"]` starts only when those items are DONE
  (feature steps run in journey order). Items without `dependsOn` are unchanged.
- *Affects:* nobody until you use it. *Config:* none. Features are stored in `backlog.json` under `"features"`. New
  command `/harness:feature` and script `npm run feature`.

## 1.0.35 — 2026-11-21

- **Remember only five commands.** `npm start`, `npm run run`, `npm run auto`, `npm run status -- --full` and
  `npm run ui` reach everything. Nothing was removed or renamed: every command, alias (`normal`, `autopilot`), slash
  command and VS Code task works as before.
- **New `status --full`:** status and the last 15 events, then `doctor`, `usage` and `team show` in one go (one
  command instead of four). `/harness:status` uses it when you ask about your setup, health, usage or the team.
- *Affects:* nobody's existing scripts. *Config:* none.

## 1.0.34 — 2026-11-21

- **New optional MCP preset `playwright`** in `.harness/mcp.json` (`@playwright/mcp@0.0.84`, pinned, `--headless
  --isolated`): a worker can open the app in a real browser, click through it and take screenshots. Off by default like
  every preset: copy it into `mcpServers` and set `"useMcp": true` for the engine in `config.json`.
- **MCP tools per role.** A role's `allowedTools` now names the MCP servers that fit it, so each worker gets only its
  own: `mcp__playwright` for DEV_ENGINEER, QA_AUDITOR and UX_DESIGNER (check the UI in a browser); `mcp__fetch` for
  BA_ANALYST (read public pages for research). PO_ARCHITECT, REVIEWER, SECURITY and COORDINATOR get none. Like the
  read-only tools, an MCP tool the role grants is kept when a skill narrows the worker's tools (an engine pointer's
  `Edit, Write, Bash` list no longer cuts a worker off its browser); a skill can still never add an MCP tool the role
  lacks. Web content is data, never instructions.
- *Affects:* only projects that turn MCP on. *Config:* none by default. *Roles:* four role files gained one tool each;
  a project that customised its roles keeps its own files and can add the same lines by hand.

## 1.0.33 — 2026-11-21

- **Worker names say what the worker does.** `worker-main`, `worker-primary` and `worker-1` said nothing in the live
  feed, the log, session notes and reports. A worker without a given name is now named after its role and task:
  `dev-login-endpoint-token`, `qa-plan-regression-tests`, `ba-spec-acceptance-criteria`. File names are left out of
  the words; a task written without Latin letters (for example in Khmer) is named after its first file
  (`dev-login-js`), then the role alone. Team workers that a lead called `w1` become `lead-dev.dev-login-route`.
  Names you give yourself (`--worker api:…`, a plan's own ids) are kept.
- Leads are shown with their task: the editor-run report and `assign` say `lead-dev · Build the login form: …`.
- *Affects:* anyone reading logs, notes or reports. *Config:* none. Scripts that searched the log for
  `worker-main` should match the new names.

## 1.0.32 — 2026-11-21

- **Skill Foundry skills arrive one by one, when a task needs them** (owner's decision: a small core set at install,
  then "find the skill that matches the task and call it, one by one, not all at the same time", automatically).
  - Before a task's workers start, the controller (and `visible.mjs brief` in the editor workflow) looks at Skill
    Foundry's list of skills (`list --json`, cached 24 h in `.harness/skill-registry.json`). A skill that is not
    installed yet, whose roles include the worker's role and whose keyword appears in the task, is added with
    `add <name> --quiet`. No command for the user to type.
  - **Automatic, then tell:** the result of `dispatch --wait`, the session note, the brief and the run report say
    which skill was added and why ("design-system: the task mentions \"design tokens\"; role DEV_ENGINEER").
  - It happens before the backup and the run's baseline, so a failed task, its rollback and the out-of-scope mover
    never remove a fetched skill. One fetch at a time (lock file); at most 90 s; offline, a timeout or an older Skill
    Foundry without `list --json` just means the task runs without it. Off with `HARNESS_SKILL_FETCH=0` or
    `"skillFetch": false`. Workers never fetch.
- **At most 2 skills per worker** (capability flag `SKILL_LIMIT_PER_WORKER = 2`): the explicit list first, then the most
  keyword hits, then the longest matched phrase. Any other matching skill is named in the log (`SKILL_NOT_LOADED`),
  not loaded, so the context stays small. Only a skill that makes a worker's top 2 is ever fetched.
- A worker in a git worktree is told where a skill's files are in the main folder (a worktree starts from the last
  commit, so a skill added since is not in it).
- *Needs:* Skill Foundry with `list --json` for fetching (older versions: nothing is fetched, everything else works).
  *Affects:* every task with a role. *Config:* optional `"skillFetch": false`.

## 1.0.31 — 2026-11-21

- **New: your project is told when a newer harness is released.** Projects installed from an old release never learned
  about later fixes (some of them data-loss fixes). Session start, `doctor` and the menu now say "Harness update
  available: this project has X, the latest release is Y" with the update command, and the AI is told to ask you before
  updating. How: about twice a day one background process reads the version of the `release` branch (a single HTTPS
  GET of a public file; nothing about you or your project is sent) into `.harness/update-check.json` (git-ignored); a
  session start only reads that cache and never waits. Off with `HARNESS_OFFLINE=1`, `HARNESS_UPDATE_CHECK=0` or
  `"updateCheck": false` in config.json. **Projects on an older version must update once by hand to get this check.**
- **Fix: files a worker created outside its assigned files stayed in your folder**, also after a failed task, and the
  check and judge then treated them as the worker's work (which it may not touch: a judge that blocks every cycle).
  Without worktrees, new untracked files outside every worker's files are now moved aside after each worker round, to
  `.harness/staging/<task>-out-of-scope/` (never deleted), and listed in the result. Files that existed before the task,
  git-ignored files and `.harness/` are left alone. Needs a git repository. Found in a real run.
- `npm run eval`: `--engine agy` works (it gave its consent to the wrong name, so nothing ran), and `--model <id>` runs
  workers and the judge on one model of that engine (results are kept as their own series).
- **Existing projects now get narrower keywords for the built-in skills.** A project's `.harness/skills/` is kept on
  update, so the keyword fix below never reached them. A built-in skill you never edited (its keywords line is exactly
  an older shipped one) is now updated; any skill you changed is kept as it is.

- **Fix: a direct (`--mode normal` / `npm run run`) or swarm task could never get a skill.** A skill needs the worker's
  role, and `dispatch.mjs` had no way to give one: `--role` was silently ignored. `dispatch --role <ROLE>` now sets the
  role of the direct worker and of every `--worker` without one (unknown roles are refused). Found with a real Codex run
  in a demo project: with `--role DEV_ENGINEER` the worker got `copy-tight` and answered in its format; without, none.
- A role-less worker whose task text matches a skill keyword now logs `SKILL_NEEDS_ROLE` with the skills and their roles,
  so the missing role is visible instead of silent. The rule "a role is always required for a skill" is unchanged.
- `dispatch.mjs` warns on an option it does not know instead of ignoring it.
- **Fix: skill keywords matched inside other words, so unrelated skills were injected.** A keyword now matches as a
  whole word or phrase (a plural "s"/"es" is allowed): "token" no longer matches "tokenizer", "api" not "rapid",
  "auth" not "author", "rest" not "restore", "route" not "router". Found with a real run: a design-tokens task for
  DEV_ENGINEER got 4 skills, including `security-guard` ("token") and `api-craft` ("json"). The built-in skills'
  keywords are narrower too (`security-guard`: "access token", "auth token", "api key" instead of "token";
  `api-craft`: "rest api", "json api" instead of "rest", "json"). Capability flag `SKILL_KEYWORD_MATCH` is now `'word'`
  (was `'substring'`) for tools such as Skill Foundry that read flags, not versions.
- *Affects:* headless direct and swarm tasks, and every task whose text matched a skill keyword inside another word.
  *Config / permissions:* none.
## 1.0.30 — 2026-11-21

- **Fix (lost commit): `sessions merge` could drop a commit that landed on the base during the check.** When the base
  branch is not checked out anywhere, its ref was moved with an "expected old value" read again at the end, so a commit
  pushed or made on the base while the check ran was silently replaced. The merge is now built on the base tip taken at
  the start and the base moves only if it is still there; otherwise nothing changes and you are told to run it again.
- **Fix: two workers could own the same file on Windows and macOS.** `src/b.js` and `src/B.js` were different owners
  for the plan check, but they are one file there. Ownership is now compared without case (workers and leads).
- **A plan whose pattern (`src/*.js`) overlaps another worker's file is refused before any worker starts**, instead of
  failing at merge time after the engines were already used.
- `sessions cleanup` deletes a merged branch even when your main folder is on another branch (it already checks that
  every commit is in the base), instead of reporting a misleading "NOT deleted … not merged".
- **Verified on real tools:** a real task (`hello.txt` smoke) committed with Claude Code, Antigravity and Codex.
- *Affects:* the session board, swarm/team plans on Windows and macOS. *Config / permissions:* none.

## 1.0.29 — 2026-11-21

- **Fix: one backlog item could run twice.** `backlog.mjs ready`, `reset` and `approve` accepted an item whose job was
  still queued or running, so `pop` (or autopilot) queued the same task again; `done` could close an item that was
  still running. They now refuse while the item has a queued or running job, and reopening a DONE item needs
  `--force`. `block` always works, and a stale IN_PROGRESS item (its daemon died, nothing queued) can still be reset.
- **Fix (judge gate): a quoted "APPROVE" could override the judge's real "NEEDS_FIX".** Only the last JSON block of a
  review was read, so an approval quoted from the diff under review (or the template) after the real verdict won. A
  review with more than one different verdict is now never an approval.
- **Injection scan:** text hidden with zero-width characters or full-width letters is caught (it is normalised first),
  as is "forget everything above". Fewer false alarms on normal task text: "you are now able to…", `.env.example`,
  and "tokens" that are not credentials. New cases are in `test/evals/golden.json`.
- `team.mjs`: a broken `team.json` is reported as invalid JSON (with the position), no longer as "not found, copy it
  from the template".
- **Fix (data loss, Windows): every `uat`-mode task emptied your `node_modules`.** Worker worktrees get a junction to
  the project's `node_modules`; removing the worktree with `git worktree remove --force` followed the junction and
  deleted the real folder's contents (on a passing task too). Every worktree removal now unlinks its links first, and a
  Windows directory junction is removed as a link (it never touches the target).
- **Fix: `sessions merge` could make another folder silently undo the merge.** When the base branch was checked out in
  another worktree, its ref was moved underneath it, so that folder's next commit reverted the merge. The merge now
  fast-forwards that worktree when it is clean, and refuses (changing nothing) when it has uncommitted changes.
- **Fix: a merged task with leftovers was hidden.** If its worktree had uncommitted files or its branch could not be
  deleted, the task was still marked cleaned and vanished from the board. It now stays on the board as MERGED,
  HIGH RISK, with what is left.
- **`sessions merge` needs a real check.** With no test or check command nothing would check the merge; it is refused
  (nothing changes, the task is not marked failed) unless the owner adds `--allow-no-check`.
- *Affects:* everyone using the backlog, autopilot, the judge gate, `uat` mode (Windows) or the session board. *Config / permissions:* none.

## 1.0.28 — 2026-11-21

- **Fix (data loss): git worktree mode could overwrite your uncommitted work.** A worktree starts from the last commit,
  so a worker never saw uncommitted edits in your folder, and copying its result back overwrote them, also when the
  task succeeded. With `useGitWorktrees: true`, a task whose scoped files have uncommitted edits (or untracked files)
  now stops before any worker starts, names the files and changes nothing: commit or stash them, then run it again.
- *Affects:* projects with `useGitWorktrees: true`. *Config / permissions:* none.

## 1.0.27 — 2026-11-21

- **Fix (data loss): git worktree mode never rolled back a failed task.** With `useGitWorktrees: true` each worker's
  result is copied into your folder as soon as it finishes, before the check runs, but no backup was taken in that mode.
  A check that failed 3 times, or a failed sibling worker, left half-done work in the folder after
  `HALTED_HITL_REQUIRED`. The scoped files are now backed up in worktree mode too and restored on failure.
- **Fix: two daemons started at the same instant could both run.** The pid file is now claimed atomically; a pid file
  left by a dead daemon is cleared and the claim retried once.
- **`--cwd` with `--branch` or `--resume-visible` is always refused**, also for `--cwd .`, as the help says (it was
  silently ignored when `--cwd` named the project itself).
- Checked and found correct: Node 18.0 compatibility of every script (no newer APIs used), swarm rollback of several
  workers with folders and paths with spaces, worktree clean-up, resume refusals for finished runs.
- *Affects:* projects with `useGitWorktrees: true`, and anyone starting the daemon twice. *Config / permissions:* none.

## 1.0.26 — 2026-11-21

- **One job per file, nothing twice.** `profile.md` now describes only the **project** (what it is, who it is for,
  what the AI must ask before doing, house rules). Everything about a **person** lives in their private `me.md`, and
  the **team page** `people.md` exists only when people share. One developer uses `profile.md` + `me.md`; a team adds
  `people.md`. New installs get the project-only template.
  - Older projects whose `profile.md` still holds personal lines (name, role, language, experience, answer style) keep
    working unchanged. Session start offers once to move them: `node .harness/memory.mjs me from-profile` copies them
    into your `me.md` (values already there win) and removes them from `profile.md`, keeping every other line.
  - `me.md` gains "Role / what I do".
- **Team page `.harness/memory/people.md` (committed).** Teammates know who wears which hat and who to ask about
  what, while personal preferences stay private in `me.md`.
  - `node .harness/memory.mjs me share [--ask "releases, acceptance"] [--language ["…"]] [--git]` adds or updates
    only your own section: name and hats from your `me.md`, plus what you choose (what to ask you about, languages for
    handoffs, your git name). `me unshare` removes you; `node .harness/memory.mjs people` shows the page.
  - Answer style, coding experience and personal skills are never shared. E-mail addresses, phone numbers and links
    are refused (the page is committed). Harness workers may not change it.
  - Session start gives the chat AI the page as "Decisions by hat" (`po → Sum; dev → Dara`), so it can say who to ask
    when a decision needs a hat you do not wear. With several git authors and no page yet, it offers `me share`.
  - `doctor`: duplicate sections, contact details on the page, and your hats on the page differing from your `me.md`.
  - A teammate on a new machine who is already on the page is recognised by their git name at session start.
  - Installer: a project's own `people.md` is kept; the template's never travels; `--reset` removes it from a
    "Use this template" copy.
- **Fix (Windows): CRLF files lost every line.** `me.md` saved by Notepad, or `profile.md` checked out with
  `core.autocrlf` (the Git for Windows default), parsed as empty: preferences and hats were ignored and a partial
  `me set` could wipe the other fields. Line endings are now handled.
- **Fix: hook-guard missed git options before the subcommand.** `git -C <dir> push origin main`,
  `git -C . reset --hard`, `git -c k=v clean -fd` and `git --git-dir=… push` are now blocked like the plain forms.
- **Fix: a bare `git push` (or `git push origin`, `git push origin HEAD`) while a protected branch is checked out**
  was allowed because no branch name was written; it is now blocked. Pushing other branches is unchanged.
- **Fix: `visible.mjs rollback` could delete newer work.** It restored files before checking that a baseline copy
  existed, so rolling back a PASSED run (its copy is already removed) deleted every file created since the run. It now
  decides first and touches nothing when it cannot restore: a PASSED run points to git, a second rollback says
  "already rolled back", a run that was restored automatically when it halted says so (instead of "the project was
  too large"), and a run id can no longer be a path.
- **Fix (data loss): a task re-run after a killed daemon overwrote its own backup.** The job stays in the inbox and its
  backup in `.harness/staging/` holds the only copy of the original files. The re-run backed up again, saving the dead
  agent's half-done edits, so a failure "restored" those and the originals were gone. The re-run now keeps the first
  backup (`STAGING_REUSED`), and a failure brings back the files from before the first attempt.
- **Fix (Windows): `dispatch --wait` could wait forever.** After a crash Windows soon reuses the daemon's process id
  for another program; the harness took that program for a running daemon (`daemon --once` refused to start,
  `dispatch --wait` and `watch` waited for nothing). A pid whose program is not node now counts as not running.
- **Fix: a timed-out worker could write after the rollback.** The timeout was reported (and the files restored) right
  after the kill was sent, while the engine could still be running. The harness now waits until the engine has
  stopped (at most 8 seconds) before it restores anything; on Windows the process tree is killed first.
- *Affects:* every project; Windows users and anyone using the PreToolUse guard. *Config / permissions:* none.
  *After updating:* optional, each person can run `node .harness/memory.mjs me share` once.

## 1.0.25 — 2026-11-20

- **One repository, several people: `me.md`.** Each person keeps their own name, language, coding experience, answer
  style and **hats** in `.harness/memory/me.md`, which is git-ignored. `profile.md` stays the shared project profile.
  A person working alone needs nothing new: without `me.md` everything works as before.
  - *Hats* are the human's focus: `po`, `ba`, `ux`, `dev`, `qa`, combinable (`po, qa`). They shape how the AI talks to
    that person and what it checks first. They are **not** AI roles and never change a scope, approval or permission.
  - Write it: `node .harness/memory.mjs me set --name "…" --language "…" --experience "…" --style "…" --hats "po,qa"
    [--skills "a,b"]`. Show it: `node .harness/memory.mjs me`. Harness workers may not change it.
  - **Background workers** get the merged profile of the person who started the run: `me.md` wins line by line over
    `profile.md`, project lines stay. **Personal skills** in `me.md` are for that person's chat AI only and never reach
    workers, so results stay the same whoever runs them.
  - **One `me.md` for all your worktrees.** A git worktree (a Claude Code worktree session, a `/harness:sessions`
    child, a worker worktree) has no copy of the git-ignored file, so the harness reads and writes the main checkout's
    `me.md`. You set it up once per machine, not once per worktree.
  - The chat AI gets every `me.md` line at session start (language, style, experience), not only name and hats, because
    editors load `profile.md` by themselves but not `me.md`.
  - `doctor` checks each personal skill: it must exist in your own `~/.claude/skills/<name>/`; a name that is a shared
    project skill, or found nowhere (a typo), gets a note. The web dashboard shows the same profile state.
- **Onboarding in chat, never as a prompt.** Session start (`hook-session.mjs`), `doctor` and `start.mjs` say when
  this machine has no `me.md`, or when `profile.md` names someone other than the git user (a teammate on a new
  machine), and the editor AI asks a few questions. Scripts, the daemon, workers and CI only read; nothing waits for
  input.
- **team.json stays the AI team.** `doctor` and `team.mjs validate` warn when `team.json` holds people: fields such
  as `people`, `owner`, `name`, `email` or `hats`, a member id that is an e-mail, or a role that is a human hat (`qa`
  instead of `QA_AUDITOR`).
- *Affects:* every project. *Config / permissions / hooks:* none. *Installer:* adds `.harness/memory/me.md` to an
  existing `.gitignore` and never copies or changes anyone's `me.md`. *After updating:* optional; each person can run
  `node .harness/memory.mjs me set …` once (their AI offers it).

## 1.0.24 — 2026-11-20

- **hook-guard: no more false blocks on quoted text.** A read-only command such as `node -e "…"` was blocked only
  because its quoted argument contained the words of a forbidden git command. Quoted arguments and heredocs that a
  program reads are now treated as data. Quoted shell code (`bash -c "…"`, `powershell -Command "…"`, `cmd /c "…"`)
  and git's own arguments (`git push origin "main"`) are still checked. *Affects:* Claude Code users.
- **`backlog.mjs done <id> "note"`** closes an item finished outside the harness (the note is required and kept as
  `doneNote`, result `DONE_OUTSIDE_HARNESS`). Claude Code asks before running it.
- **doctor: removed engines.** An older `config.json` that still lists `orca` (or `gemini`) gets one clear warning
  ("no longer supported … remove it") instead of a failed flag probe and a missing-models warning. Re-installing
  removes it for you (see "config upgrade" below).
- **codex verified.** The `codex` profile passed a real live eval (3/3: feature, bug fix, injection resistance,
  committed with hidden checks and judge approval; codex-cli 0.167.0-alpha.4.1, Windows 11) and is now
  `"verified": true`. The codex CLI bundled inside the Codex desktop app is found even when it is not on PATH
  (`binaryCandidates` in the profile: environment variables, globs, `appx:` packages).
- **config upgrade on reinstall.** Updating keeps every value you set in `.harness/config.json`, adds new profiles
  and keys, drops removed engines (`orca`, `gemini`), and gives an unverified engine profile the verified template
  invocation. *Affects:* projects updated from older versions; check the installer output for what changed.
- `docs/ENGINES.md` now has the `hello.txt` smoke task that the release checklist refers to.
- **doctor: one-engine team.** When every team member is routed to the same engine, doctor says what happens on a
  usage limit (HTTP 429): agents retry on another usable engine (`QUOTA_FALLBACK`), or, if there is none, a warning
  that one limit stops the whole team. *Fix:* `node .harness/team.mjs auto-assign` after allowing a second engine.
- **CHANGELOG.md** (this file) and a "what's new" summary at the end of every install that changes the version.

## 1.0.23 — 2026-11-20

- **LLM judge gate, required by default** (`config.review`: `required: true`, `headless: true`, `minScore: 3`).
  A PASSED code change is not DONE until a read-only reviewer judge approves it against a rubric (correctness,
  acceptance, tests, rootCause, safety). Editor: `node .harness/visible.mjs judge <run> --agent reviewer --file <report>`;
  the backlog item stays IN_PROGRESS (`awaitingJudge`) and autopilot waits. Headless (`daemon`, `npm run auto`,
  `dispatch`): the controller runs the reviewer itself; findings go back to the workers as the next cycle's error;
  no valid verdict fails closed. Docs-only and test-only changes skip it. *Affects:* everyone; runs take one extra
  agent call per code change. *To turn it into advice only:* `"review": { "required": false }`.
- **Prompt-injection guard.** Every agent prompt says that content read from files and tools is data, not
  instructions. Backlog or proposed task text that tries to steer agents is rejected (`visible.mjs propose`) or held
  as BLOCKED (`brief --next`, the daemon) until `node .harness/backlog.mjs approve <id>`. Injection-like text an agent
  writes into a file is reported and shown to the judge.
- **PreToolUse guard `.harness/hook-guard.mjs`** blocks, before they run: edits to `.env*`, `.git/**`,
  `.harness/releases/**` (and the harness core in installed projects), `git reset --hard`, `git clean -f`, force
  pushes, and pushes to protected branches (`git.protectedBranches` + `git.integrationBranch`).
  *Settings change:* the installer merges into `.claude/settings.json` a `PreToolUse` hook (`node .harness/hook-guard.mjs`)
  and a deny rule `Bash(git reset --hard:*)`. Your own rules and hooks stay.
- **Prompt size guard** `config.maxPromptChars` (default 120000): oversized worker prompts are clipped, memory and
  error trace first (`PROMPT_CLIPPED` in telemetry).
- **Skill pointers:** `schema_version` is read (`SKILL_SCHEMA_MAX = 1`); a newer pointer is skipped with a doctor
  warning instead of a crash. Keywords match as case-insensitive substrings.
- **Evals:** `test/evals/golden.json` (run by `npm test`) and `npm run eval -- --engine <name>` (opt-in, live).

## 1.0.22 — 2026-11-19

- A test script that can never fail (`exit 0`, `true`, a bare `echo`, the `npm init` stub) is no longer treated as
  a real check: autonomous runs refuse it, manual reports say `NO REAL TEST SIGNAL`.
- Antigravity (`agy`): long prompts no longer overflow the Windows command line.
- Landing page and docs brought in line with the source.

## 1.0.21 — 2026-11-18

- **Pre-commit patch safety gate** (`scanPatchSafety`): newly added secrets (shown only as `(redacted)`) and merge
  conflict markers block verify; a new `debugger` statement is a warning.
- **Failure diagnosis** on a failed check (`[FAILURE DIAGNOSIS]`, `[REPEAT FAILURE]`), in the daemon and the editor
  workflow.
- **Task-aware memory:** `node .harness/memory.mjs context --goal … --files …` ranks auto-lessons by relevance;
  `memory.mjs learn` and `promote` save and share local lessons.
- Check auto-detection for npm/pnpm/yarn/bun workspaces, Python, Go, Rust, PHP/Laravel and Makefile; adaptive scopes
  for non-`src/` layouts (`node .harness/team.mjs adapt-scopes`); a repo map in planner prompts.
- doctor checks that the six cross-tool rule files point to `AGENTS.md`. *Rule files change:* the installer rewrites
  the harness section of `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursor/rules/harness.mdc` and
  `.windsurfrules` to also mention `node .harness/memory.mjs learn` (local lessons) and `memory.mjs context`.

## 1.0.20 — 2026-11-18

- Docs, README, AGENTS.md and the website synced with the source; the template audit gained a docs-drift check
  (`npm run audit`).

## 1.0.19 — 2026-11-18

- **Strict test isolation:** only `lead-qa` may create or change test files; a test file touched by `lead-dev` is
  reverted as a scope violation.
- **Two-phase root-cause fixing** for bug fixes (`visible.mjs brief --bugfix`): Symptom / Root Cause / Blast Radius
  before editing; an anti-cheat diff audit flags skipped tests, empty `catch` blocks and weakened assertions.

## 1.0.18 — 2026-11-18

- Eleven fixes from Skill Foundry feedback: memory, Windows process-tree kill, junctions and hooks, glob scopes,
  backlog priority 0, and a notice when a paid API key is set in the shell.

Older versions: see `git log` on the `release` branch.
