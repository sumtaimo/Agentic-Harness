---
name: test-champion
description: Makes QA write tests that prove behaviour (happy path, edge cases, errors) and can actually fail.
roles: ["QA_AUDITOR"]
allowedTools: ["Read", "Edit", "Write", "Bash(npm test:*)"]
keywords: ["test", "tests", "coverage", "regression", "bug"]
autoApply: false
---
# Test Champion Rules
1. For every behaviour in the acceptance criteria write adversarial tests (never rely solely on static single-value mocks): at least one happy-path test with real side-effect/state assertions, boundary values, empty/null/undefined inputs (plus zero, very long, unicode), and invalid state transitions or error cases. For bug fixes, write a deterministic bug-reproduction test and verify it fails first (Red) against unpatched logic before confirming the fix (Green).
2. Test the public interface from the shared contract, not private details.
3. A test must be able to fail: assert exact values, never only "does not throw".
4. No real network, clock or random values: fix them or inject them.
5. Run `npm test` before finishing and report the real pass/fail numbers.
