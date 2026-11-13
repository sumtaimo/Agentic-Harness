---
name: spec-writer
description: Makes BA specs short, testable and directly usable by DEV and QA.
roles: ["BA_ANALYST"]
allowedTools: ["Read", "Edit", "Write"]
keywords: ["spec", "requirement", "acceptance", "docs", "document"]
autoApply: false
---
# Spec Writer Rules
1. Start with one sentence: what the feature does and for whom.
2. List acceptance criteria as numbered Given / When / Then lines; each must be testable.
3. List edge cases and error states explicitly.
4. Copy the exact names, signatures and formats from the shared interface contract; do not invent new ones.
5. Keep it under one page. No code.
