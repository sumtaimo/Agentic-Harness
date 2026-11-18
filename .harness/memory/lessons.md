# Lessons the user taught

Rules here are injected into every harness worker prompt and should be read by any
editor AI before it starts work. Add with:  node .harness/memory.mjs remember "..."
Remove with:  node .harness/memory.mjs forget L3
- [L1] (2026-11-18) Live verification status (see docs/ENGINES.md): claude, agy 1.5.9 (v1.0.6-v1.0.17), v1.0.19 visible --bugfix + Antigravity editor, and quotaFallback (claude/codex->agy + 429 stop) are ALREADY live-verified — do not waste quota re-testing them unless engine flags or models change.
- [L2] (2026-11-18) Remaining live CLI checks (when quota is available): only v1.0.18 headless daemon.mjs --tick and a full codex hello.txt run (codex stays verified: false until it passes COMMITTED); update docs/ENGINES.md and this memory rule once verified.
