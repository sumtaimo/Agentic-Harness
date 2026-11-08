---
name: code-craft
description: Enforces clean code design, strict parameter validation, and governance headers in generated source and test files.
roles: ["DEV_ENGINEER", "QA_AUDITOR"]
allowedTools: ["Read", "Edit", "Write", "Bash(npm test:*)", "Bash(node:*)"]
keywords: []
autoApply: false
---
# Code Craft Skill Rules
1. Every generated source file MUST begin with a JSDoc block containing: `@governed-by PO_ARCHITECT`.
2. Functions must include explicit TypeScript or runtime parameter validations.
3. Keep code modular and do not modify files outside your declared target scope.
4. Before finishing, run the project's tests (`npm test`) or `node` on your own code and fix what fails. Only touch your declared files.
