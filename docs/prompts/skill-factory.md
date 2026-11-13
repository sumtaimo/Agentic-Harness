You are the ORCHESTRATOR of the agentic harness in this project (read AGENTS.md first, then .harness/memory/profile.md and lessons.md). Run this as ONE harness task with the exact /harness:run workflow: brief → assign → start lead-ba, lead-dev and lead-qa in ONE message → verify → report. Never edit .harness/ or .claude/ yourself, never commit or push.

# GOAL: a SKILL FACTORY
This project is a factory that produces AI skills (SKILL.md packages that guide other agents). This first task builds the FACTORY ITSELF, not any particular skill. After it passes, every new skill is one more harness task that follows the factory's standard, starts from its template, and must pass its checks.

The quality bar for every skill the factory makes: "no pixel wrong, no step vague". An AI cannot promise that by itself, so the factory turns taste into RULES, rules into CHECKS a machine runs, and whatever a machine cannot check into a CHECKLIST a reviewer ticks. A rule that exists only as prose is a defect.

# WHAT THE FACTORY CONTAINS (layers)
1. Standard — what every skill must have and how it is judged.
2. Template — a copy-ready skill skeleton that already meets the standard.
3. Skill linter — a machine check that a skill folder meets the standard.
4. Eval runner — golden prompts per skill with expected, checkable properties.
5. Visual kit — shared helpers for skills whose output is a page or figure (screenshot matrix, overflow and console checks).
6. Meta-skill `skill-smith` — the procedure an agent follows to create a NEW skill with this factory.
7. Registry and installer — one list of skills; a script the HUMAN runs to copy a skill into .claude/skills/.

# FILES AND OWNERS (each file has exactly one owner; stay in scope)
lead-ba (docs/**):
- docs/factory/STANDARD.md — the skill standard: required files; SKILL.md frontmatter (`name`, `description`, `version`); how to write a `description` that triggers correctly (when to use / when not to); procedure style (numbered, imperative, one action per step); rules written as MUST / NEVER, each with an id like `R-<skill>-<n>`; every rule mapped to a check id or a checklist item; size limits (SKILL.md ≤ 150 lines, details in references/); versioning and CHANGELOG.
- docs/factory/REVIEW.md — the reviewer's checklist for ANY skill (clarity, triggers, coverage, examples, evals, visual items for UI skills).
- docs/factory/ROADMAP.md — 8 candidate skills for this factory with a one-line purpose each (for example: figure-craft for explanatory isometric figures and pages, spec-writer for acceptance criteria, ui-polish for a final pixel pass, copy-tight for short plain copy). Facts only, no invented claims about other products.

lead-dev (src/**), plain Node ESM, ZERO dependencies:
- src/skills/_template/ — SKILL.md (frontmatter + sections: When to use, Procedure, Rules, Checks, Review, Output), references/README.md, examples/README.md, evals/cases.json (`[{ "id", "prompt", "expect": [ { "type": "contains" | "notContains" | "maxLines" | "fileExists", "value" } ] }]`), RULES.json (`[{ "id", "text", "check"?: string, "checklist"?: string }]`), CHANGELOG.md.
- src/skills/skill-smith/ — the meta-skill built from the template: its procedure is interview the goal → write the intent → list rules → map each rule to a check or checklist item → write examples and evals → run the linter and evals → review with docs/factory/REVIEW.md → report. It must pass its own linter.
- src/factory/lint-skills.mjs — `node src/factory/lint-skills.mjs [skill]` checks every folder in src/skills/ (except _template, unless named): required files exist; frontmatter has name, description, version; name matches the folder; SKILL.md ≤ 150 lines; every RULES.json entry has `check` or `checklist`; every `check` id is referenced by a test file in tests/; relative links in markdown resolve. Exit 0 only if all pass; print one line per problem with file:line.
- src/factory/evals.mjs — `export function runEvals(skillDir, produce)` where `produce(prompt)` returns `{ text, files }`; scores each case's `expect` list; returns `{ passed, failed, results }`. Deterministic, no network.
- src/factory/visual.mjs — `export async function checkPage(fileOrUrl, { widths:[1440, 390], themes:['light','dark'], reducedMotion:true })` → `{ ok, problems: [{ width, theme, kind, detail }] }` with kinds `console-error`, `horizontal-scroll`, `text-outside-svg`; if `playwright` cannot be loaded, return `{ ok: null, skipped: 'playwright not installed' }` (never fake a pass).
- src/factory/registry.json — `[{ "name", "version", "purpose", "status": "draft" | "ready" }]` (skill-smith as ready, _template excluded).
- src/factory/install.mjs — `node src/factory/install.mjs <skill-name>` copies src/skills/<name> into .claude/skills/<name> (refuses names not in the registry, refuses to overwrite without `--force`, prints what it copied). Agents never run it; the human does.

lead-qa (tests/**):
- tests/factory-lint.test.mjs — the linter passes on _template and skill-smith; for each lint rule, a seeded broken skill in a temp folder fails with the expected message.
- tests/factory-evals.test.mjs — runEvals scores passing and failing cases correctly for every expect type.
- tests/factory-visual.test.mjs — checkPage on a tiny temp page: no problems; on a page with forced horizontal overflow: reports `horizontal-scroll`; skips cleanly without Playwright.
- tests/factory-install.test.mjs — install into a temp project copies files, refuses unknown names, refuses overwrite without --force.

# CHECK (the controller runs it; only its exit code counts)
`node --test tests/ && node src/factory/lint-skills.mjs`

# RULES
- Zero dependencies, Node standard library only; ask me before adding any package.
- Every generated source file starts with a JSDoc block containing `@governed-by PO_ARCHITECT`.
- Skills are plain Markdown + JSON so any engine (Claude Code, Gemini, Antigravity, Codex) can read them.
- Do not invent facts.
- Report back in plain words: what each named agent did, the controller's verdict (PASSED only if it said so), and anything needing my decision.

# NEXT (not part of this task)
Each new skill = one harness task: "Use src/skills/skill-smith to create the skill <name>: <purpose>". The first one is figure-craft.
