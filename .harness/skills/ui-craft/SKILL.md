---
name: ui-craft
description: Makes UI changes consistent, accessible and token-based, so the product looks like one system.
roles: ["UX_DESIGNER"]
allowedTools: ["Read", "Edit", "Write", "Bash(git status)"]
keywords: ["ui", "ux", "style", "css", "design", "layout", "theme", "responsive", "accessibility"]
autoApply: false
---
# UI Craft Rules
1. Look first: read the existing styles and the closest similar component, and reuse their tokens and patterns.
2. No new hard-coded colors, spacing, radii or font sizes when a design token (CSS variable) exists; if one is missing, add a token instead of a one-off value.
3. Every interactive element has visible hover, focus (keyboard), active and disabled states; never remove the focus outline without a replacement.
4. Text contrast meets WCAG AA (4.5:1 for body text, 3:1 for large text and UI controls).
5. Cover the states the user will meet: loading, empty, error and long content (wrapping, overflow).
6. Layout works from a 360 px phone to a wide desktop without horizontal page scroll.
7. If the project has light and dark themes, check both.
8. Style only: when the change needs markup or logic, write exactly what the developer must add, in your report.
