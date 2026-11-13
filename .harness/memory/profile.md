# User profile

This file tells every AI (the editor chat AND the harness workers) who you are and how you
like to work. Replace each "(fill me)". You can also just tell your editor AI:
"Read AGENTS.md and fill in my profile" — it will ask you a few questions and write this file.

- Name: TaiMo
- Role / what I do: Design Systems Engineer and Frontend Architect.
- Coding experience: Professional frontend engineer. Do not over-explain basics; be direct and technical. Explain harness internals only when I ask.
- Language I want answers in: English for conversation, code, tokens, architecture and system terms. English + Khmer only when I explicitly ask for a deep technical explanation (never mix all three languages in one sentence). Korean only for greetings, confirmations and UI feedback labels.
- What this project is: Modern Agentic Harness — universal zero-dependency framework for AI coding agents with multi-mode execution (Normal, Parallel, Team, Autopilot) and automated verification. I follow the Lightweight Native Harness philosophy going forward: Node.js standard library only, CLI/stdio-based, model-independent, no heavy agent frameworks.
- AI tools I use: Gemini and Antigravity are my main engines. Claude Code is used for some sessions. Keep every interface model-independent so any engine can be plugged in.
- How I like answers: Short and direct. Show the result first, then the details.
- Things the AI must always ask me before doing: deleting or overwriting files, pushing to GitHub or merging into main, installing global software, changing `.harness/config.json` or `.harness/charter.md`, adding dependencies, and anything that costs money (for example raising `--max-cost`).
