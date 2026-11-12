---
name: api-craft
description: Consistent HTTP/JSON API design: validation, status codes, error shape.
roles: ["DEV_ENGINEER", "BA_ANALYST"]
allowedTools: ["Read", "Edit", "Write"]
keywords: ["api", "endpoint", "route", "rest", "http", "json"]
autoApply: false
---
# API Craft Rules
1. Validate the request body, query and params first; answer 400 with a clear message when invalid.
2. Use correct status codes: 200/201 success, 400 bad input, 401/403 auth, 404 missing, 409 conflict, 500 unexpected.
3. One error shape everywhere: `{ "error": { "code": "...", "message": "..." } }`.
4. Never leak stack traces or internal details in responses.
5. Write the exact request/response format into the shared interface contract (BA: in the spec document).
