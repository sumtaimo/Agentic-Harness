---
description: Teach the harness (and every AI in this project) a rule or preference
argument-hint: <the rule, e.g. "Always explain changes in simple English">
---
Save this as a rule for every AI working in this project: $ARGUMENTS

If it is empty, ask me what rule to save. Otherwise rewrite it as one clear sentence (a rule, not a story), run `node .harness/memory.mjs remember "<rule>"`, and reply in one line: "I'll remember: <rule>". Never store passwords, keys or private personal data.
