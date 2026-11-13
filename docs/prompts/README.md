# Prompts for building a skill factory

The goal of that project: make high-quality, reusable AI skills, show each one on a public page with a preview, and let anyone download it, the same way this harness is a reusable template.

Run these in a NEW project that has the harness installed, in this order. Wait for the controller to say PASSED before the next one.

| Order | File | What it builds |
|---|---|---|
| 1 | [`skill-factory.md`](skill-factory.md) | The factory: standard, template, skill linter, eval runner, visual kit, packaging (zip + SHA-256), the `skill-smith` meta-skill, registry and installer, and a README draft for the project as a template. |
| 2 | [`skill-showcase-site.md`](skill-showcase-site.md) | The public showcase site, generated from the registry: a collection page with a card per skill, one page per skill (preview, try-it prompt, steps, rules, download, install), downloads with checksums, EN and KH, light by default. |
| 3 | [`figure-craft-skill.md`](figure-craft-skill.md) | The first real skill: `figure-craft`, explanatory isometric figures and pages. Its cover is drawn with its own engine. |

## Before you start (one time)

```bash
mkdir skill-foundry && cd skill-foundry && git init && git commit --allow-empty -m "init"
```

```bash
npx --yes github:sumtaimo/Agentic-Harness#main .
```

```bash
node .harness/doctor.mjs
```

Open the folder in Claude Code, accept the trust dialog, restart the session, then paste prompt 1.

## After each step (you do these, the agents cannot)

- **Review and commit** the changes yourself (`git diff`), nothing is committed for you.
- **After prompt 1:** move `docs/factory/README.draft.md` to `README.md` and add a LICENSE.
- **After prompt 2:** add `dist/` to `.gitignore` and save the workflow from `docs/site/DEPLOY.md` as `.github/workflows/deploy-site.yml`. Then set Settings → Pages → Source: GitHub Actions.
- **To use a skill yourself:** run `node src/factory/install.mjs <skill-name>`, then restart the session.
- **After every new skill:** rebuild the site with `node src/site/build.mjs`; pushing to `main` publishes it.

## Skill ideas for the factory

`figure-craft` is only the first skill. The factory (with `skill-smith`) can make any kind:

| Group | Skill | What it does |
|---|---|---|
| UX | `ux-flow` | one line → a full user flow with every state (loading, empty, error, success) |
| | `ux-audit` | review a page against 10 heuristics, findings with priority |
| | `ux-copy` | short, clear, consistent UI text (buttons, errors, empty states) |
| UI | `ui-polish` | a final pixel pass: spacing, colour, radius, dark mode, phone |
| | `design-tokens` | colour, type and spacing tokens from a brand, light and dark |
| | `component-spec` | one component → variants, states, accessibility, props |
| | `figure-craft` | explanatory isometric figures (the first skill) |
| PO / BA | `spec-writer` | feature request → spec with acceptance criteria |
| | `story-split` | a large epic → small, buildable user stories |
| | `impact-check` | one change → what else it could break |
| QA | `test-cases` | spec → test cases (happy path, edge, negative) |
| | `bug-report` | a vague report → steps, expected, actual |
| | `a11y-check` | contrast, keyboard and ARIA review |
| Docs | `handoff-doc` | a design → a developer handoff document |
| | `release-notes` | git log → release notes for users |

### Suggested order

`spec-writer` → `test-cases` → `ux-flow` → `ui-polish` → `component-spec` → `ux-audit` → `bug-report` → `handoff-doc`.
Each one uses what the one before it produces, so together they form a PO → QA → UX → UI chain.

### For each new skill (repeat)

1. Pick ONE skill.
2. Type one line, with your own real rules in it:
   `Use src/skills/skill-smith to create the skill spec-writer: turn a feature request into a short spec with acceptance criteria (Given/When/Then), edge cases and open questions.`
3. Wait for PASSED, then review it yourself with `docs/factory/REVIEW.md`.
4. Install it and try it on real work: `node src/factory/install.mjs spec-writer`.
5. When it is good, set its status to `ready` in `src/factory/registry.json` and rebuild the site: `node src/site/build.mjs`.
6. Commit and push: the skill appears on the site, ready to download.

### Tips

- One skill, one job.
- Put your real rules in the one-line request; a skill is only as good as its rules.
- Try it on 1–2 real tasks before calling it ready, and teach the mistakes back into the skill.
- Three excellent skills beat ten average ones.

## More skills later

One line is enough:

```text
Use src/skills/skill-smith to create the skill <name>: <purpose>
```

## Honest notes

- These prompts have not been tested against a live run yet; the first run will show what to adjust.
- Pixel quality is not promised by the AI. The factory turns it into rules, machine checks and a reviewer checklist, and you approve the result.
- Khmer text written by the agents needs a native reader.
