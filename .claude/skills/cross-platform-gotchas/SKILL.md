---
name: cross-platform-gotchas
description: Use when a harness script, test or installer must work on Windows as well as Linux or macOS, or when a Windows user reports a failure the Linux suite does not show.
---
# Cross-platform gotchas for the harness (Node.js, zero dependencies)

Status key: VERIFIED = proven by a real run on that platform (see `docs/ENGINES.md` for the record); FIXED = code changed and unit tested; OPEN = a hypothesis that still needs a run on that platform.

| Gotcha | Rule | Status |
|---|---|---|
| `import()` of an absolute path | On Windows `C:\...` is read as a URL scheme (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). Use `import(pathToFileURL(file).href)`. | FIXED (tests use `pathToFileURL`) |
| Command-line quoting | With `shell: true`, `winQuote` (`.harness/lib/common.mjs`) must quote an empty argument as `""` and turn newlines into spaces, because `cmd.exe` truncates a command line at the first newline. | FIXED |
| Native `.exe` engines | A native `.exe` such as `agy` is spawned with `shell: false` on Windows, so multi-line prompts and `--model` survive. | VERIFIED live with `agy` |
| Command-line length | `CreateProcess` allows 32,767 characters (8,191 through `cmd.exe`). A prompt over `maxArgPromptChars` (24,000) is written to `.harness/staging/prompt-<worker>.md` and the engine gets a short instruction to read it. | VERIFIED live |
| `.gitignore` in npm packages | npm strips `.gitignore`, so `npx` installs need the embedded `GITIGNORE_BLOCK` in `install.mjs`; a test keeps it equal to `.gitignore`. | FIXED |
| Line endings | `.gitattributes` sets `* text=auto eol=lf` and `eol=crlf` for `.cmd`, `.bat`, `.ps1`. Parsers should still accept `\r?\n`. | FIXED |
| Fake CLIs in tests | Tests write a `fake-engine.cmd` on `win32` and a shell script elsewhere. A new fake must do the same. | FIXED |
| Pid file | The watch test skips the pid-file assertion on Windows (`process.platform !== 'win32'`). | KNOWN gap |
| Console encoding | Emoji in live output may not render in a Windows console. | OPEN |
| Installed CLI location | `agy.exe` may be in `%LOCALAPPDATA%\agy\bin` or `~/.gemini/bin`, not on PATH; doctor then reports it as not installed. | VERIFIED |

## How to work
- Never claim "works on Windows" from a Linux run. Say "unit tested on Linux" and ask the user to run `npm test` and paste the output.
- Use `path.join` and `pathToFileURL`; never build paths with `/` or `\` by hand. Test line-ending handling with a `\r\n` fixture.
- When a Windows run gives new evidence, update the status column here.
