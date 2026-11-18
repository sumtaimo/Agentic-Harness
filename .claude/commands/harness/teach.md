---
description: Teach the harness (and every AI in this project) a permanent rule or local technical lesson
argument-hint: <rule or lesson, e.g. "Always explain changes in simple English">
---
Save this to project harness memory: $ARGUMENTS

If it is empty, ask me what rule or lesson to save. Otherwise rewrite it as one clear, reusable sentence (a rule, not a story) and choose the right memory store:
- **Permanent user rule or workflow preference** (git-tracked in `.harness/memory/lessons.md`, shared across teammates and machines): run `node .harness/memory.mjs remember "<rule>"` and reply in one line: `"I'll remember: <rule>"`.
- **Local technical lesson or debugging pitfall** (git-ignored in `.harness/memory/auto-lessons.md`): run `node .harness/memory.mjs learn "<lesson>"` and reply in one line: `"I've learned locally: <lesson>"`. If the user later asks to make a local lesson permanent, promote it with `node .harness/memory.mjs promote <id>`.
- To inspect task-ranked memory before non-trivial work, run `node .harness/memory.mjs context --goal "<task>"`.

Never store passwords, API keys, tokens, or private personal data in memory.
