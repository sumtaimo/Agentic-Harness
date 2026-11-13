You are the ORCHESTRATOR of the agentic harness in this project (read AGENTS.md first, then .harness/memory/profile.md and lessons.md). Run this as ONE harness task with the exact /harness:run workflow: brief → assign → start lead-ba, lead-dev and lead-qa in ONE message → verify → report. Never edit .harness/ or .claude/ yourself, never commit or push.

# BEFORE YOU START
The showcase site (src/site/) builds and its checks pass, but it does not look right yet. This task fixes the LOOK and LAYOUT only. Do not change the content model, the downloads or the checksums.

# WHAT IS WRONG NOW (seen on the real page)
1. It opens in DARK mode. The rule is light by default for everyone; dark only after the visitor presses the toggle. Do not follow the system's dark setting on first visit.
2. The collection is ONE full-width card. It must read as a library: a grid of compact cards.
3. Each card is too tall and too empty: a huge cover box, then a title, a tagline, tags and buttons stacked loosely.
4. The cover drawing is vague (a rectangle over a table) and is placed inside a dark box with the skill name drawn again under it.
5. The Khmer heading uses a heavy font that does not match the rest of the page.
6. Leftovers: "Foundry" in the brand link is in the italic serif (only a few accent words may be), and the example iframe's title is not marked `lang="en"`.

# HOW IT MUST LOOK (exact)
Page
- Background `--bg` (#f9f9f8 light). One reading column ≤ 600px for text. The collection grid may widen to 960px.
- Top: brand name in Inter 500 (no italic, no logo icon), then the language switch and the theme toggle on the right.
- Opening line in Inter 500, 28px desktop / 24px phone, with at most two words in Newsreader italic.

Collection grid
- 3 columns ≥ 960px, 2 columns ≥ 640px, 1 column below. 16px gap.

Card
- White surface, 1px `--line` border, 16px radius, 16px padding, no heavy shadow (at most `0 1px 2px rgba(0,0,0,.04)`), the whole card is one link to the skill page.
- Cover area: 4:3, `--surface2` background, 12px radius, the drawing centred with 16px padding. Do not repeat the skill name inside the cover.
- Then the title (Inter 500, 15px), the tagline (13.5px, `--muted`, at most 2 lines), the tags (11px, ≤ 3 shown) and a footer row: `v1.0.0` in mono on the left, a small "Download" text link with an icon on the right.
- Hover: the border goes to `--lineStrong` and the cover drawing lifts 2px. Visible focus ring.

Khmer
- Khmer text uses "Noto Sans Khmer" 400/500 (never 700), line-height 1.8, no letter-spacing, and headings no larger than in English.

Covers (for now)
- Redraw the skill-smith cover so it clearly reads as "making a skill": an isometric anvil with a small document on it, in the site's iso palette (top light, two shaded sides, thin ink outline, slightly rounded corners). ≤ 40 KB, colours only via `var(--…)`. (Later covers come from the figure-craft skill.)

Skill page
- Same light default, same type. The contents rail shows exactly one marker for the current section, and the marker glides as you scroll (check it at ≥ 1200px width).

# FILES AND OWNERS
lead-ba (docs/**):
- docs/site/REVIEW.md: add every item above as a yes/no line, grouped by area.
- docs/site/SPEC.md: update the layout and the theme rule (light by default, dark only by the toggle).

lead-dev (src/**):
- src/site/assets/site.css, src/site/assets/site.js, src/site/lib/render.mjs: the changes above.
- src/skills/skill-smith/preview/cover.svg: the new cover (it must still pass `node src/factory/lint-skills.mjs`).

lead-qa (tests/**):
- tests/site-look.test.mjs:
  - the built `index.html` has no `prefers-color-scheme` rule that switches to dark on first visit, and the theme script defaults to light;
  - the card markup has exactly one link per card and no duplicate skill name inside the cover;
  - the CSS grid has 1, 2 and 3 column rules at the widths above;
  - Khmer uses no `font-weight: 700`;
  - the iframe title carries `lang="en"`.
- tests/site-visual.test.mjs (extend):
  - with Playwright, the collection at 1440px shows the cards side by side (at least two cards share a row when two exist), at 390px one column;
  - in light theme the computed body background is rgb(249, 249, 248);
  - no horizontal scroll.
  - Skip cleanly without Playwright; the controller report will show it as SKIPPED.

# CHECK (the controller runs it; only its exit code counts)
`node --test tests/ && node src/factory/lint-skills.mjs && node src/site/build.mjs --check`

# AFTER THE CONTROLLER SAYS PASSED
The report will say NEEDS A VISUAL REVIEW, because this task changes UI. That is expected. Build the site, open `dist/site/index.html` at desktop and phone width, light and dark, and tick docs/site/REVIEW.md. Tell me in plain words what still looks wrong. Stop any preview server you start.
