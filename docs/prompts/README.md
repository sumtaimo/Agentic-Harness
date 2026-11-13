# Prompts for building a skill factory

Two ready-to-paste prompts for Claude Code in a project that has the harness installed
(`npx --yes github:sumtaimo/Agentic-Harness#main .`, trust the folder, restart the session).
Each one is a single harness task: brief → assign → `lead-ba` + `lead-dev` + `lead-qa` in parallel → verify → report.

| Order | File | What it builds |
|---|---|---|
| 1 | [`skill-factory.md`](skill-factory.md) | The factory itself: standard, template, skill linter, eval runner, visual kit, the `skill-smith` meta-skill, registry and installer. No particular skill yet. |
| 2 | [`figure-craft-skill.md`](figure-craft-skill.md) | The first skill made with the factory: `figure-craft`, explanatory isometric figures and pages. Run it only after prompt 1 passes. |

More skills later need no long prompt, one line is enough:

```text
Use src/skills/skill-smith to create the skill <name>: <purpose>
```

Notes
- The agents build skills in `src/skills/`. They may not edit `.claude/`, so **you** install a finished skill:
  `node src/factory/install.mjs <skill-name>`, then restart the session.
- The prompts are untested against a live run; the first run will show what needs adjusting.
- Pixel quality is not promised by the AI. The factory turns it into rules, machine checks and a reviewer checklist.
