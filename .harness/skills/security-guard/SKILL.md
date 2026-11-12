---
name: security-guard
description: Blocks common security mistakes (hard-coded secrets, injection, unsafe eval, path traversal) in generated code and tests.
roles: ["DEV_ENGINEER", "QA_AUDITOR"]
allowedTools: ["Read", "Edit", "Write"]
keywords: ["security", "auth", "login", "password", "token", "secret", "sql", "upload", "permission"]
autoApply: false
---
# Security Guard Rules
1. Never write passwords, API keys, tokens or private keys into any file. Read them from environment variables.
2. Validate and sanitise every external input (HTTP, CLI args, files, env). Reject what you do not expect.
3. Build SQL / shell / HTML with parameters or escaping, never by joining user text into strings.
4. Never use `eval`, `new Function` or `child_process` with user-controlled text.
5. Resolve file paths and refuse anything that leaves the intended folder (`..`, absolute paths).
6. If you find an existing security problem outside your files, mention it in your report; do not fix it.
