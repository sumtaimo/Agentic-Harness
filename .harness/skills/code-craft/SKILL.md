---
name: code-craft
description: Enforces clean code design, strict parameter validation, and governance headers in generated source and test files.
roles: ["DEV_ENGINEER", "QA_AUDITOR"]
allowedTools: ["Read", "Edit", "Write"]
keywords: []
autoApply: false
---
# Code Craft Skill Rules
1. Every generated source file MUST begin with a JSDoc block containing: `@governed-by PO_ARCHITECT`.
2. Functions must include explicit TypeScript or runtime parameter validations.
3. Keep code modular and do not modify files outside your declared target scope.
