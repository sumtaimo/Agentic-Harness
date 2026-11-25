# Lessons the user taught

Rules here are read by every AI (editor chats, terminal CLIs, cloud sessions) and
injected into every harness worker prompt.
Add permanent rule (git-tracked):         node .harness/memory.mjs remember "..."
Save local/technical lesson (git-ignored): node .harness/memory.mjs learn "..."
Remove rule:                               node .harness/memory.mjs forget L3
- [L1] (2026-11-20) Shared project skills install via Skill Foundry into .claude/skills/ for everyone; personal skills stay in the user's personal skills folder and are referenced via me.md (chat AI only, never harness workers).
- [L2] (2026-11-21) In the template repository, work directly on the lab branch (no session branches); push to lab, and to release only with the owner's yes, after npm test and npm run audit pass.
- [L3] (2026-11-25) Agentic-Harness owns only the controller, governance, and starter stubs—request deep skills (like design-system) from Skill-Foundry and coordinate any harness-facing contract or skill changes across both repos before shipping.
