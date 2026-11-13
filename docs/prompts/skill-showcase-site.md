You are the ORCHESTRATOR of the agentic harness in this project (read AGENTS.md first, then .harness/memory/profile.md and lessons.md). Run this as ONE harness task with the exact /harness:run workflow: brief → assign → start lead-ba, lead-dev and lead-qa in ONE message → verify → report. Never edit .harness/ or .claude/ yourself, never commit or push.

# BEFORE YOU START
Prompt 1 (the skill factory) has passed: src/factory/ (registry.json, pack.mjs, zip.mjs, visual.mjs, lint-skills.mjs) and src/skills/ exist. Reuse them; do not duplicate them.

# GOAL: the public SHOWCASE SITE
A static website where people see every ready skill as a preview, try it with one line, and download it. Quiet, premium, document-like: a page you read, not an app. Generated from the factory's data, so a new skill appears by rebuilding, never by hand-editing HTML.

`node src/site/build.mjs [--out <dir>]` (default out: `dist/site`) writes plain HTML, CSS and a small JS file. ZERO dependencies, no framework, no bundler.

# PAGES
1. `index.html`, the Collection:
   - one opening line, for example "Skills that make AI agents deliver exact work", then 2 short paragraphs;
   - a grid of skill cards (only registry status `ready`): inline cover.svg, title, tagline, tags, version, "Download .zip", "Copy install command";
   - section "How a skill is made" (the factory layers in 5 short numbered steps);
   - section "Install a skill" (3 steps);
   - section "Limits" (honest: what skills do not guarantee).
2. `skills/<name>/index.html`, one per ready skill:
   - large cover, title, tagline;
   - "Try it": the preview.json prompt with a copy button;
   - "What the agent does": the numbered steps from SKILL.md's Procedure section;
   - "Rules and checks": total rules, how many are machine-checked, how many are checklist items;
   - files in the package;
   - Download: zip, size, SHA-256;
   - Install steps;
   - Changelog;
   - if `preview/example.html` exists, show it in `<iframe sandbox="allow-scripts">` (never allow-same-origin).
3. `downloads/`: copied from pack.mjs output: each `<name>-<version>.zip`, `all-skills.zip`, `checksums.json`.

# DESIGN RULES (exact)
- Light theme by default; dark theme via a toggle (remembered in localStorage, wrapped in try/catch) and `prefers-color-scheme`.
- Colour tokens only (no raw colours outside the token blocks):
  - light: bg #f9f9f8, surface #ffffff, surface2 #f2f2f0, line #e8e8e5, lineStrong #d4d4d0, fg #1d1d1b, muted #6f6f6b, faint #9c9c97, ok #2f7a4b, warn #8f6200;
  - dark: bg #141413, surface #1b1b1a, surface2 #222220, line #2c2c2a, lineStrong #3a3a37, fg #ecebe7, muted #a3a29d, faint #75746f, ok #6cc28f, warn #e0b45c.
- Fonts: Inter (text), Newsreader italic (a few accent words only), JetBrains Mono (code), loaded from Google Fonts with system fallbacks.
- Layout:
  - one reading column ≤ 600px;
  - on skill pages, a left contents rail where a marker glides to the current section and the line fills with scroll, with exactly one marker for the current section;
  - numbered section headings "01 / 05";
  - cards with 16px radius and hairline borders;
  - phone 390px with a 16px gutter and no horizontal scroll.
- Copy: one idea per sentence, plain words, nothing the site cannot keep true (no download counts, no "N tests passing").
- Languages: English (default) and Khmer, with exactly the same keys in both; the switch is remembered. Mark Khmer text as needing native review in docs.
- Motion: subtle, and fully off under prefers-reduced-motion.
- Accessibility: one h1 per page, `lang` set, alt or aria-label on every cover, visible focus, buttons are buttons.

# FILES AND OWNERS (each file has exactly one owner; stay in scope)
lead-ba (docs/**):
- docs/site/SPEC.md: pages, content model (which file feeds which field), the EN and KH copy as source text.
- docs/site/REVIEW.md: the pixel review checklist for the site (layout, type, colour, rail, cards, downloads, phone, dark, Khmer, reduced motion).
- docs/site/DEPLOY.md: how to publish on GitHub Pages: the full workflow YAML for the human to save as `.github/workflows/deploy-site.yml` (build with `node src/site/build.mjs --out dist/site`, upload, deploy), the one-time setting (Settings → Pages → Source: GitHub Actions), and the `.gitignore` line `dist/`.

lead-dev (src/**), plain Node ESM, ZERO dependencies:
- src/site/build.mjs: CLI entry; `--check` builds into a temp folder and runs every check below, exit 0 only if all pass.
- src/site/lib/content.mjs: `export function loadSkills(root)` → `[{ name, version, status, title, tagline, prompt, outputs, tags, coverSvg, procedure: string[], rules: { total, machine, checklist }, changelog: string, files: string[], example: boolean }]`, ready skills only, sorted by name.
- src/site/lib/svg.mjs: `export function sanitizeSvg(text)` → string, or throws when it finds script, foreignObject, on* attributes or external href.
- src/site/lib/i18n.mjs: `export const DICTS = { en: {...}, kh: {...} }` with identical keys.
- src/site/lib/render.mjs: pure functions returning HTML strings (layout, index, skill page, card, rail).
- src/site/assets/site.css (tokens + layout) and src/site/assets/site.js (theme, language, copy buttons, rail; no external scripts).
- `export async function buildSite({ root, out })` → `{ pages: string[], skills: number, downloads: string[] }` in build.mjs; it calls pack.mjs for the zips.

lead-qa (tests/**):
- tests/site-build.test.mjs: build into a temp dir; every ready skill has a page; drafts have none; every download on a page exists and its SHA-256 equals checksums.json; the same input gives the same HTML.
- tests/site-links.test.mjs: every internal link and asset resolves; no external `<script src>`; no raw colour outside the token blocks in site.css.
- tests/site-i18n.test.mjs: EN and KH have identical keys; no empty strings.
- tests/site-safety.test.mjs: sanitizeSvg rejects script, foreignObject, on* attributes and external href; iframes use `sandbox="allow-scripts"` without allow-same-origin.
- tests/site-visual.test.mjs: with src/factory/visual.mjs, index and one skill page at 1440 and 390, light and dark: no console errors, no horizontal scroll; skips cleanly without Playwright.

# CHECK (the controller runs it; only its exit code counts)
`node --test tests/ && node src/factory/lint-skills.mjs && node src/site/build.mjs --check`

# RULES
- Zero dependencies; ask me before adding any package.
- Every generated source file starts with a JSDoc block containing `@governed-by PO_ARCHITECT`.
- Do not invent facts.
- Report back in plain words: what each named agent did, the controller's verdict (PASSED only if it said so), and what I must do by hand (deploy workflow, .gitignore line).
