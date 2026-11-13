# Lessons the user taught

Rules here are injected into every harness worker prompt and should be read by any
editor AI before it starts work. Add with:  node .harness/memory.mjs remember "..."
Remove with:  node .harness/memory.mjs forget L3

- [L1] (2026-11-13) Work directly on the main branch (no session branches or PRs unless asked), but always ask before every git push; autonomous harness runs still land on the uat branch.
- [L2] (2026-11-13) Never start autonomous runs (npm run auto or /harness:auto) until the owner explicitly says start.
