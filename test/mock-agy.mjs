#!/usr/bin/env node
// A fake "Antigravity-style" engine for tests: the prompt arrives as an ARGUMENT (agy -p <prompt>; here simply the last argument), there is no
// --allowedTools flag, and the answer is plain text on stdout (no stream-json). It runs the normal mock agent to get
// the answer. STRAY=1 makes it write a file although it was told to only read (an engine that cannot be restricted).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const prompt = process.argv[process.argv.length - 1] || ''; // the prompt is the last argument
const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-agent.mjs')], { input: prompt, encoding: 'utf8', env: process.env });
if (process.env.STRAY === '1') { fs.mkdirSync('src', { recursive: true }); fs.writeFileSync(path.join('src', 'stray.js'), '// written by an engine that was told to only read\n'); }
let text = r.stdout || '';
try { const j = JSON.parse(text.trim().split('\n').pop()); if (typeof j.result === 'string') text = j.result; } catch { /* already plain text */ }
process.stdout.write(`${text}\n`);
