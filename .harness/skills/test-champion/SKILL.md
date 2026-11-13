---
name: test-champion
description: Makes QA write tests that prove behaviour (happy path, edge cases, errors) and can actually fail.
roles: ["QA_AUDITOR"]
allowedTools: ["Read", "Edit", "Write", "Bash(npm test:*)"]
keywords: ["test", "tests", "coverage", "regression", "bug"]
autoApply: false
---
# Test Champion Rules
1. For every behaviour in the acceptance criteria write at least: one happy-path test, one edge case (empty, zero, very long, unicode), one error case.
2. Test the public interface from the shared contract, not private details.
3. A test must be able to fail: assert exact values, never only "does not throw".
4. No real network, clock or random values: fix them or inject them.
5. Run `npm test` before finishing and report the real pass/fail numbers.
