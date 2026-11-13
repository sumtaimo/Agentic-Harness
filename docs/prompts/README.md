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

## More skills later

One line is enough:

```text
Use src/skills/skill-smith to create the skill <name>: <purpose>
```

## Honest notes

- These prompts have not been tested against a live run yet; the first run will show what to adjust.
- Pixel quality is not promised by the AI. The factory turns it into rules, machine checks and a reviewer checklist, and you approve the result.
- Khmer text written by the agents needs a native reader.
