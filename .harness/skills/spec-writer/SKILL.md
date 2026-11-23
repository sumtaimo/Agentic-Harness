---
name: spec-writer
description: Makes BA specs short, testable and directly usable by DEV and QA.
roles: ["BA_ANALYST"]
allowedTools: ["Read", "Edit", "Write"]
keywords: ["spec", "requirement", "acceptance", "docs", "document"]
autoApply: false
starter-stub: agentic-harness
---
# Spec Writer Rules
1. Start with one sentence: what the feature does and for whom.
2. List acceptance criteria as numbered Given / When / Then lines; each must be testable.
3. List edge cases and error states explicitly.
4. Copy the exact names, signatures and formats from the shared interface contract; do not invent new ones.
5. For anything with more than one screen or step, add a **Flow & State Table** (a table, not prose), so the whole flow is defined, not one component:

   | Step | User does | System shows (loading / empty / error / success) | Next or exit |
   |---|---|---|---|

   Under it, one line each for: the entry point, the exit, what the user sees after a reload, and who may do it (permission).
6. Take the users and rules from `docs/foundation/product.md` and `domain.md` by reference. A line there that still says `(fill me)` is unknown: put your guess under "Needs a decision" and never present it as a rule.
7. Keep it under one page, table included. No code.
