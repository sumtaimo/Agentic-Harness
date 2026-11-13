You are the ORCHESTRATOR of the agentic harness in this project (read AGENTS.md first, then .harness/memory/profile.md and lessons.md). Run this as ONE harness task with the exact /harness:run workflow: brief → assign → start lead-ba, lead-dev and lead-qa in ONE message → verify → report. Never edit .harness/ or .claude/ yourself, never commit or push.

# BEFORE YOU START
The skill factory foundation (docs/factory/STANDARD.md, src/factory/, src/skills/_template/, src/skills/skill-smith/) already exists. Follow STANDARD.md and start from src/skills/_template/. The factory check `node src/factory/lint-skills.mjs` must also pass for this skill.

# GOAL
Build a reusable AI skill called `figure-craft`. Given ONE line ("explain how an LRU cache evicts entries"), an agent that follows this skill produces an explanatory page or figure that looks hand-made and premium: quiet paper palette, a real isometric OBJECT whose parts behave like the idea (not boxes and arrows), short copy, gentle motion that tells one story, light theme by default, dark theme too. It must be general (any idea, any product), not a copy of one site.

"No pixel wrong" is the bar. An AI cannot promise that by itself, so the skill must turn taste into RULES and RULES into CHECKS that a machine runs. Every rule below must end up either in a deterministic check (tests/) or in the written review checklist (docs/), never only in prose.

# THE SKILL IS BUILT IN LAYERS (each layer = one reference file + checks)
1. Intent: one line in → what the reader must understand; pick a size: Figure (one object), Hero (object + 3 short paragraphs), Page (contents rail + numbered sections).
2. Tokens: one source of truth for colours (light + dark), type scale, spacing grid (4px), radius, stroke widths, motion durations. No raw values anywhere else.
3. Layout: page skeleton (contents rail, numbered sections "01 / 09", one reading column, margin notes that fall below the text on phones, cards with label/value rows), max widths, 16px phone gutter, no horizontal scroll.
4. Figure: isometric engine rules (projection, painter order, rounded solids, shading, details lying flat on faces, labels in clean side columns).
5. Motion: one story per figure, on a loop, moving only along true iso axes, synced timings, everything still under prefers-reduced-motion.
6. Copy: one idea per sentence, plain words, no claim the page cannot keep true (no "N tests passing" badges), same keys in every language.
7. Verification: build, lint, geometry checks, screenshots (light, dark, 390px phone, second language), console errors, reduced motion.
8. Review: a written checklist a human or reviewer agent ticks against the screenshots before calling it done.

# LESSONS ALREADY LEARNED (each MUST become a lint rule or checklist item)
- A beam resting on posts looked misaligned because the posts were drawn after it → painter order: supports first, what rests on them last.
- Status lights looked stuck on → a detail on a face must lie in that face's plane (projected ellipse) and sit inside the face, centred, away from rounded corners.
- A label's leader line crossed another object → labels go in left/right columns, pushed apart (min gap 13 units), leader lines must not cross solids.
- Blocks "lifting" off their lanes looked wrong → motion only along an iso axis of the surface the object stands on.
- Grey anchor dots on objects confused readers → no decorative dots on solids unless they mean something.
- The contents rail showed two dots for the current section → one marker per state.
- Long copy and an unmaintained "tests passing" badge → short copy, only facts the page keeps true.

# FILES AND OWNERS (each file has exactly one owner; stay in scope)
lead-ba (docs/**):
- docs/skills/figure-craft/SPEC.md — the 8 layers, inputs/outputs, acceptance criteria per layer.
- docs/skills/figure-craft/CHECKLIST.md — the pixel review checklist (numbered, yes/no items, grouped by layer, includes every lesson above).
- docs/skills/figure-craft/EXAMPLES.md — 6 example one-line prompts across different domains (software, physics, finance, biology, a device, a process) with what object each should become and why.

lead-dev (src/**), plain Node ESM, ZERO dependencies:
- src/skills/figure-craft/SKILL.md — frontmatter `name: figure-craft` and a `description` that says when to use it (any request for an explanatory diagram, technical illustration or interactive explainer). Body: the ordered procedure (size it → choose the object → name its parts → plan the one motion story → build with the engine → run lint and checks → review with CHECKLIST.md → report). Keep it under 150 lines; point to references for detail.
- src/skills/figure-craft/references/{tokens.md, layout.md, figures.md, motion.md, copy.md} — one file per layer, rules written as MUST/NEVER with a tiny example each.
- src/skills/figure-craft/engine/tokens.mjs, engine/iso.mjs, engine/lint.mjs — the contract below.
- src/skills/figure-craft/examples/demo.html — one self-contained page built with the engine (a labelled object + one motion story), light default, dark toggle, no external scripts.

lead-qa (tests/**):
- tests/figure-craft-engine.test.mjs — projection maths, painter order, face circles, label layout (no overlaps, inside the viewBox), determinism (same input → same SVG string).
- tests/figure-craft-lint.test.mjs — for EVERY lint rule, one clean model that passes and one seeded mistake that fails with that rule id (the lessons above are the seeded mistakes).
- tests/figure-craft-visual.test.mjs — if `require('playwright')` works: open examples/demo.html at 1440px and 390px, light and dark, and with reduced motion; assert no console errors, no horizontal scroll, every SVG text inside its viewBox. If Playwright is not installed, skip with a clear message (never fake a pass).

# INTERFACE CONTRACT (exact; dev implements it, qa tests it)
engine/tokens.mjs
- `export const TOKENS = { light: {...}, dark: {...} }` with keys: bg, surface, surface2, line, lineStrong, fg, muted, faint, ok, warn, danger, isoTop, isoA, isoB, isoInk, isoInkTop, isoInkA, isoInkB.
- `export function tokensCss()` → string with `:root{--bg:…}` and the dark set under `[data-theme="dark"]` and `@media (prefers-color-scheme: dark)`.
engine/iso.mjs
- `export const C = 0.866`; `export function project([x, y, z])` → `[(x - y) * C, (x + y) * 0.5 - z]`.
- Shapes are plain objects: `box({ at:[x,y,z], size:[w,d,h], tone?:'ink', r?:number, anim?:string, move?:[x,y,z], delay?:number, rests?:string, id?:string })`, `line(points, { bold? })`, `dot(at, { r?, tone?:'ok'|'ink', face?:'top'|'y'|'x', on?:string })`. `rests` = id of the shape it stands on; `on` = id of the box whose face the dot lies on.
- `export function renderSvg(shapes, { labels?: [{ at, text, side:'l'|'r' }], padding?: number })` → `{ svg: string, model }`. Pure and deterministic. Rounded vertical edges with smooth shading, rounded tops, soft ground shadow, colours only via `var(--…)` tokens.
- `export function layoutLabels(labels, bounds)` → `[{ text, side, x, y, tx, ty }]` (columns beside the drawing, min vertical gap 13).
engine/lint.mjs
- `export function lint(model)` → `{ errors: [{ rule, message }], warnings: [{ rule, message }] }`.
- Rule ids: `L1-painter-order` (a shape is drawn before the shape it `rests` on), `L2-face-detail` (a dot with `on` is outside that face or not in its plane), `L3-label-overlap`, `L4-leader-crosses-solid` (warning), `L5-outside-viewbox`, `L6-raw-colour` (any fill/stroke not `var(--…)`), `L7-motion-no-reduced` (an animation without a reduced-motion fallback), `L8-motion-off-axis` (a `move` not parallel to an iso axis of the surface it stands on).

# CHECK (the controller runs it; only its exit code counts)
`node --test tests/`

# RULES
- Zero dependencies, Node standard library only; ask me before adding any package.
- Every generated source file starts with a JSDoc block containing `@governed-by PO_ARCHITECT` (code-craft skill).
- Light theme is the default. Phone width 390px must work.
- Do not invent facts in copy or examples.
- Report back in plain words: what each named agent did, the controller's verdict (PASSED only if it said so), and anything needing my decision.

# AFTER IT PASSES (I do this myself, not the agents)
Run `node src/factory/install.mjs figure-craft`, restart the session, and try: `explain how a CDN edge cache serves a request, interactive`.
