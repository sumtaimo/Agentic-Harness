---
description: Show the agent team (orchestrator → leads → workers) and check that its guardrails are valid
---
Run `node .harness/team.mjs show` and `node .harness/team.mjs validate`. Then explain in plain words, in at most 8 lines: who is on the team and what each level does (the orchestrator plans and delegates, each lead plans its own workers, the workers do the work), which files each lead's team may own, the money and time cap of each member, and whether the team is valid. If it is invalid, say exactly what to fix in `.harness/team.json`. Do not change any file unless I ask you to.
