#!/usr/bin/env node
// A fake AI engine for tests. Reads the prompt from stdin and follows simple commands
// found in it, so harness logic can be tested without calling a real (paid) AI.
//   WRITE <file> <text>        always write the file
//   FIX <file> <text>          write the file only if the prompt contains a previous verifier error
//   FAIL                       exit 1
// It also saves the full prompt it received to .mock-prompts/<worker-id>.txt
import fs from 'node:fs';
import path from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const id = process.env.HARNESS_WORKER_ID || 'unknown';
fs.mkdirSync('.mock-prompts', { recursive: true });
fs.writeFileSync(path.join('.mock-prompts', `${id}.txt`), prompt);

const task = prompt.split('[TASK INSTRUCTIONS]:')[1] || '';
const hasError = prompt.includes('[PREVIOUS VERIFIER ERROR TO FIX]');
for (const line of task.split('\n')) {
  const [cmd, file, ...rest] = line.trim().split(' ');
  if (cmd === 'FAIL') { console.error('mock agent asked to fail'); process.exit(1); }
  if (cmd === 'WRITE' || (cmd === 'FIX' && hasError)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rest.join(' '));
  }
}
console.log(JSON.stringify({ type: 'result', is_error: false, result: `mock ${id} done` }));
