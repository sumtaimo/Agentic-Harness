#!/usr/bin/env node
// A fake AI engine for tests. Reads the prompt from stdin and follows simple commands
// found in it, so harness logic can be tested without calling a real (paid) AI.
//   WRITE <file> <text>        always write the file
//   FIX <file> <text>          write the file only if the prompt contains a previous verifier error
//   FAIL                       exit 1
//   SLEEP <ms>                 wait (to prove workers run in parallel)
//   SAY <text> / DENY <file>   (stream mode) an assistant message / a permission denial
// With argument FMT=stream it prints Claude-style stream-json events instead of one JSON result.
// It also saves the full prompt it received to .mock-prompts/<worker-id>.txt
import fs from 'node:fs';
import path from 'node:path';
// Run from a harness worktree? Log at the real project root so tests can find the files.
const wtMarker = `${path.sep}.harness${path.sep}worktrees${path.sep}`;
const projectRoot = process.cwd().includes(wtMarker) ? process.cwd().split(wtMarker)[0] : process.cwd();
const MP = path.join(projectRoot, '.mock-prompts');

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const id = process.env.HARNESS_WORKER_ID || 'unknown';
fs.mkdirSync(MP, { recursive: true });
fs.writeFileSync(path.join(MP, `${id}.txt`), prompt);

fs.writeFileSync(path.join(MP, `${id}.args.json`), JSON.stringify(process.argv.slice(2)));
fs.appendFileSync(path.join(MP, 'timeline.txt'), `${Date.now()} start ${id}\n`);

// Cost the mock reports: planners (orchestrator / lead / PO / planner) read PLANCOST=0.04 anywhere in their prompt;
// a worker reads MOCKCOST=0.04 only from ITS OWN task instructions (so it cannot leak into the planners' prompts).
const mockCost = Number((prompt.match(/PLANCOST=([\d.]+)/) || [])[1] || 0);
const workerCost = Number(((prompt.split('[TASK INSTRUCTIONS]:')[1] || '').match(/MOCKCOST=([\d.]+)/) || [])[1] || 0);

// ORCHESTRATOR mode (hierarchy level 1): echo back "ORCH_JSON {...}" from the goal (one line).
if (prompt.startsWith('[HARNESS ORCHESTRATOR]')) {
  fs.appendFileSync(path.join(MP, 'orch-calls.txt'), `${process.argv.slice(2).join(' ')}\n`);
  const plan = (prompt.match(/ORCH_JSON (\{.*\})/) || [])[1] || 'not json';
  console.log(JSON.stringify({ type: 'result', is_error: false, result: plan, total_cost_usd: mockCost }));
  process.exit(0);
}

// LEAD mode (hierarchy level 2): echo back "LEAD_JSON {...}" found in ITS OWN assignment (not the overall goal).
if (prompt.startsWith('[HARNESS LEAD ')) {
  fs.appendFileSync(path.join(MP, 'lead-calls.txt'), `${id} ${process.argv.slice(2).join(' ')}\n`);
  const own = prompt.split('[YOUR ASSIGNED FILES]')[0].split(/\[ASSIGNMENT from [^\]]*\]:/)[1] || '';
  const plan = (own.match(/LEAD_JSON (\{.*\})/) || [])[1] || 'not json';
  console.log(JSON.stringify({ type: 'result', is_error: false, result: plan, total_cost_usd: mockCost }));
  process.exit(0);
}

// PO_ARCHITECT mode: echo back the task list embedded in charter.md as "PO_JSON {...}" (one line).
if (prompt.startsWith('[HARNESS PO_ARCHITECT]')) {
  fs.appendFileSync(path.join(MP, 'po-calls.txt'), `${process.argv.slice(2).join(' ')}\n`);
  fs.writeFileSync(path.join(MP, 'po.txt'), prompt);
  const plan = (prompt.match(/PO_JSON (\{.*\})/) || [])[1] || 'not json';
  console.log(JSON.stringify({ type: 'result', is_error: false, result: plan, total_cost_usd: mockCost }));
  process.exit(0);
}

// Planner mode: echo back the plan embedded in the goal as "PLAN_JSON {...}" (one line).
if (prompt.startsWith('[HARNESS PLANNER]')) {
  fs.appendFileSync(path.join(MP, 'planner-calls.txt'), `${process.argv.slice(2).join(' ')}\n`);
  fs.writeFileSync(path.join(MP, 'planner.txt'), prompt);
  const plan = (prompt.match(/PLAN_JSON (\{.*\})/) || [])[1] || 'not json';
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Here is the plan:\n```json\n' + plan + '\n```', total_cost_usd: mockCost }));
  process.exit(0);
}

const task = prompt.split('[TASK INSTRUCTIONS]:')[1] || '';
const hasError = prompt.includes('[PREVIOUS VERIFIER ERROR TO FIX]');
const stream = process.argv.includes('FMT=stream'); // like claude --output-format stream-json
const emit = (o) => stream && console.log(JSON.stringify(o));
emit({ type: 'system', subtype: 'init', model: 'mock-model' });
const denials = [];
for (const line of task.split('\n')) {
  const [cmd, file, ...rest] = line.trim().split(' ');
  if (cmd === 'FAIL') { console.error('mock agent asked to fail'); process.exit(1); }
  if (cmd === 'SLEEP') await new Promise((r) => setTimeout(r, Number(file)));
  if (cmd === 'SAY') emit({ type: 'assistant', message: { content: [{ type: 'text', text: [file, ...rest].join(' ') }] } });
  if (cmd === 'DENY') denials.push({ tool_name: 'Write', tool_input: { file_path: path.resolve(file) } });
  if (cmd === 'WRITE' || (cmd === 'FIX' && hasError)) {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.resolve(file) } }] } });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rest.join(' '));
  }
}
fs.appendFileSync(path.join(MP, 'timeline.txt'), `${Date.now()} end ${id}\n`);
const result = { type: 'result', is_error: false, result: `mock ${id} done`, duration_ms: 42, permission_denials: denials, total_cost_usd: workerCost };
console.log(JSON.stringify(result));
