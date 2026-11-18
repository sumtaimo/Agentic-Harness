# Copilot instructions

Before answering, read and follow `AGENTS.md` at the repository root. It explains the
`.harness/` agentic harness and requires you to read the user's memory first:
`.harness/memory/profile.md`, `.harness/memory/lessons.md`, and `.harness/memory/auto-lessons.md`
(or `node .harness/memory.mjs context --goal "..." --files "..."`). When the user corrects you or
states a preference, save it permanently with `node .harness/memory.mjs remember "<rule>"`; when
you uncover a local technical gotcha, record it with `node .harness/memory.mjs learn "<lesson>"`.
