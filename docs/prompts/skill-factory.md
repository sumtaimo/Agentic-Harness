You are the ORCHESTRATOR of the agentic harness in this project (read AGENTS.md first, then .harness/memory/profile.md and lessons.md). Run this as ONE harness task with the exact /harness:run workflow: brief → assign → start lead-ba, lead-dev and lead-qa in ONE message → verify → report. Never edit .harness/ or .claude/ yourself, never commit or push.

# GOAL: a SKILL FACTORY (and a reusable template)
This project is a factory that produces AI skills: SKILL.md packages that guide other agents to do one kind of work excellently. Every skill it makes must be high quality, helpful and reusable by other people, so every skill is also PACKAGED: a preview cover, a one-line try-it prompt, and a deterministic .zip anyone can download and drop into their own project. A separate task (prompt 2) builds the public showcase site from what this task produces.

This first task builds the FACTORY ITSELF, not any particular skill. After it passes, each new skill is one more harness task that follows the factory's standard, starts from its template, and must pass its checks.

The quality bar for every skill: "no pixel wrong, no step vague". An AI cannot promise that by itself, so the factory turns taste into RULES, rules into CHECKS a machine runs, and whatever a machine cannot check into a CHECKLIST a reviewer ticks. A rule that exists only as prose is a defect.

# WHAT THE FACTORY CONTAINS (layers)
1. Standard: what every skill must have and how it is judged.
2. Template: a copy-ready skill skeleton that already meets the standard.
3. Skill linter: a machine check that a skill folder meets the standard.
4. Eval runner: golden prompts per skill with expected, checkable properties.
5. Visual kit: shared helpers for skills whose output is a page or figure (screenshot matrix, overflow and console checks).
6. Packaging: a preview cover and metadata per skill, a zero-dependency deterministic .zip writer, SHA-256 checksums.
7. Meta-skill `skill-smith`: the procedure an agent follows to create a NEW skill with this factory.
8. Registry and installer: one list of skills; a script the HUMAN runs to copy a skill into .claude/skills/.

# FILES AND OWNERS (each file has exactly one owner; stay in scope)
lead-ba (docs/**):
- docs/factory/STANDARD.md: the skill standard. Required files; SKILL.md frontmatter (`name`, `description`, `version`); how to write a `description` that triggers correctly (when to use / when not to); procedure style (numbered, imperative, one action per step); rules written as MUST / NEVER, each with an id like `R-<skill>-<n>`; every rule mapped to a check id or a checklist item; size limits (SKILL.md ≤ 150 lines, details in references/); versioning and CHANGELOG; the PREVIEW requirement (preview/cover.svg and preview.json, below).
- docs/factory/REVIEW.md: the reviewer's checklist for ANY skill (clarity, triggers, coverage, examples, evals, preview quality, visual items for UI skills).
- docs/factory/PUBLISHING.md: how to publish a skill: bump version, update CHANGELOG, run the checks, pack, read the checksum, set status `ready`.
- docs/factory/ROADMAP.md: 8 candidate skills with a one-line purpose each (for example: figure-craft for explanatory isometric figures and pages, spec-writer for acceptance criteria, ui-polish for a final pixel pass, copy-tight for short plain copy). Facts only, no invented claims about other products.
- docs/factory/README.draft.md: the text for this project's root README as a reusable template: what it is, "use this template" and install steps, how to add a skill, how to pack and publish, license note. (The human moves it to README.md; agents cannot edit the root.)

lead-dev (src/**), plain Node ESM, ZERO dependencies:
- src/skills/_template/: SKILL.md (frontmatter + sections: When to use, Procedure, Rules, Checks, Review, Output), references/README.md, examples/README.md, evals/cases.json (`[{ "id", "prompt", "expect": [ { "type": "contains" | "notContains" | "maxLines" | "fileExists", "value" } ] }]`), RULES.json (`[{ "id", "text", "check"?: string, "checklist"?: string }]`), CHANGELOG.md, preview/cover.svg, preview.json.
- preview.json shape: `{ "title": string, "tagline": string (≤ 90 chars), "prompt": string (the one line a user types to try it), "outputs": string (one sentence: what you get), "tags": string[] (≤ 5) }`.
- preview/cover.svg: valid SVG with a viewBox, ≤ 40 KB, no script, no foreignObject, no external href, colours only via `var(--…)` or `currentColor`.
- src/skills/skill-smith/: the meta-skill built from the template. Its procedure: interview the goal → write the intent → list rules → map each rule to a check or checklist item → write examples and evals → draw the cover and write preview.json → run the linter and evals → review with docs/factory/REVIEW.md → pack → report. It must pass its own linter.
- src/factory/lint-skills.mjs: `node src/factory/lint-skills.mjs [skill]` checks every folder in src/skills/ (except _template, unless named): required files exist; frontmatter has name, description, version; name matches the folder; SKILL.md ≤ 150 lines; every RULES.json entry has `check` or `checklist`; every `check` id is referenced by a test file in tests/; relative links in markdown resolve; preview.json has all keys with the limits above; cover.svg meets its limits. Exit 0 only if all pass; print one line per problem with file:line.
- src/factory/evals.mjs: `export function runEvals(skillDir, produce)` where `produce(prompt)` returns `{ text, files }`; scores each case's `expect` list; returns `{ passed, failed, results }`. Deterministic, no network.
- src/factory/visual.mjs: `export async function checkPage(fileOrUrl, { widths:[1440, 390], themes:['light','dark'], reducedMotion:true })` → `{ ok, problems: [{ width, theme, kind, detail }] }` with kinds `console-error`, `horizontal-scroll`, `text-outside-svg`; if `playwright` cannot be loaded, return `{ ok: null, skipped: 'playwright not installed' }` (never fake a pass).
- src/factory/zip.mjs: `export function makeZip(entries)` where entries are `[{ path, data: Buffer }]` → Buffer. Zero dependencies: use `node:zlib` `deflateRawSync` and your own CRC-32. Deterministic: entries sorted by path, fixed 1980-01-01 timestamp, no extra fields. Also `export function readZip(buf)` → `[{ path, data }]` (verifies each CRC) for tests.
- src/factory/pack.mjs: `node src/factory/pack.mjs <skill> | --all [--out <dir>]` writes `<name>-<version>.zip` (the skill folder, excluding junk such as .DS_Store and node_modules, plus an INSTALL.txt that says: unzip into `.claude/skills/<name>/` of your project, restart Claude Code), `all-skills.zip`, and `checksums.json` (`{ "<file>": { "sha256", "bytes" } }`). Same input gives the same bytes.
- src/factory/registry.json: `[{ "name", "version", "purpose", "status": "draft" | "ready" }]` (skill-smith as ready; _template excluded).
- src/factory/install.mjs: `node src/factory/install.mjs <skill-name>` copies src/skills/<name> into .claude/skills/<name> (refuses names not in the registry, refuses to overwrite without `--force`, prints what it copied). Agents never run it; the human does.

lead-qa (tests/**):
- tests/factory-lint.test.mjs: the linter passes on _template and skill-smith; for each lint rule, a seeded broken skill in a temp folder fails with the expected message (including a bad preview.json and an unsafe cover.svg).
- tests/factory-evals.test.mjs: runEvals scores passing and failing cases correctly for every expect type.
- tests/factory-visual.test.mjs: checkPage on a tiny temp page: no problems; on a page with forced horizontal overflow: reports `horizontal-scroll`; skips cleanly without Playwright.
- tests/factory-pack.test.mjs: makeZip/readZip round trip (bytes and CRC equal), deterministic (same input → same bytes and same sha256), pack excludes junk and includes INSTALL.txt, checksums.json matches the files.
- tests/factory-install.test.mjs: install into a temp project copies files, refuses unknown names, refuses overwrite without --force.

# CHECK (the controller runs it; only its exit code counts)
`node --test tests/ && node src/factory/lint-skills.mjs`

# RULES
- Zero dependencies, Node standard library only; ask me before adding any package.
- Every generated source file starts with a JSDoc block containing `@governed-by PO_ARCHITECT`.
- Skills are plain Markdown + JSON (+ SVG) so any engine (Claude Code, Gemini, Antigravity, Codex) can read them.
- Do not invent facts (no download counts, no claims about other products).
- Report back in plain words: what each named agent did, the controller's verdict (PASSED only if it said so), and anything needing my decision.

# NEXT (not part of this task)
Prompt 2 builds the public showcase site from the registry. Then each new skill is one harness task: "Use src/skills/skill-smith to create the skill <name>: <purpose>". The first is figure-craft (prompt 3).
