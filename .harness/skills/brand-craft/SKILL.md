---
name: brand-craft
description: Keeps UI and UX work on-brand and un-generic. Reads docs/foundation/brand.md, avoids its anti-patterns, and warns against "Zombie UI" (default library look, filler copy, missing states).
roles: ["UX_DESIGNER"]
allowedTools: ["Read", "Edit", "Write", "Bash(git status)"]
keywords: ["brand", "wireframe", "anti-pattern", "visual identity", "tone of voice", "zombie ui"]
autoApply: false
---
# Brand Craft Rules
1. Read first, by reference: `docs/foundation/brand.md` (point of view, tone, visual direction, "Never do this (Anti-patterns)") and `docs/foundation/product.md` (who it is for and why). A line that still says `(fill me)` is unknown: never invent a brand or a user. Follow the project's existing tokens and say in your report which brand fields were blank.
2. Before you work, state in one line the brand point of view you follow and which anti-patterns apply to this task. After you finish, check your work against every anti-pattern and say so in your report.
3. No Zombie UI. Refuse these unless the brand says otherwise: a default component-library look with no choices made; filler copy ("Lorem ipsum", "Welcome to our platform", a bare "Submit", "Something went wrong"); the same centered hero or card grid for every screen; decoration that has no job.
4. Real copy: words that the target user would actually meet. Buttons say a verb and its object, errors say what happened and what to do next, empty states say what will live there and the first step.
5. Every screen has all its states designed, not only the happy path: loading, empty, error, long content, and what the user sees after a reload.
6. Design the whole flow, not a component: for a task with more than one screen, write the entry point, the steps, the exits and a state table in `docs/ux/<flow>.md` (one page, text or Mermaid wireframes), then style against it. Write only the `docs/ux/` files you were assigned.
7. Tokens before taste: a new look is a new design token, not a one-off value (see `ui-craft`), so a brand decision can change in one place. Creating or updating `design/` token files via a `design-system` engine script is handed to `DEV_ENGINEER` — `UX_DESIGNER` has no `node` access and consumes tokens in CSS and `docs/ux/` specs.
8. If the request itself matches an anti-pattern, do not comply silently: report the conflict for the owner to decide.
9. You still change only style files and `docs/ux/` Markdown. When the flow needs markup, logic or copy in code, write exactly what the developer must add, in your report.
