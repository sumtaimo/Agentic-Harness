#!/usr/bin/env node
/**
 * examples/make-demo.mjs — create a small DEMO PROJECT with the agentic harness already set up, so you can try it.
 *
 *   node examples/make-demo.mjs [folder]           default folder: ./demo-project
 *   node examples/make-demo.mjs [folder] --force   delete and recreate an existing demo folder (only if it is a demo)
 *
 * What you get: a tiny text-utilities project (own git repo, one commit), the harness installed, the charter
 * objectives filled in (so autonomous mode may plan), and ONE READY task ("Add a slugify helper") so that
 * /harness:auto has something to do. Open the folder in Claude Code, trust it, restart the session, and follow
 * the README inside it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const force = args.includes('--force');
const target = path.resolve(args.find((a) => !a.startsWith('--')) || 'demo-project');
const MARK = '.harness-demo'; // marks a folder as a demo made by this script (so --force never deletes anything else)

if (path.resolve(target) === SRC || SRC.startsWith(`${target}${path.sep}`)) { console.error('Refusing: the demo folder must be somewhere else than this template.'); process.exit(1); }
if (fs.existsSync(target) && fs.readdirSync(target).length) {
  if (!force) { console.error(`${target} already exists and is not empty. Use --force to recreate it (only works on a folder made by this script).`); process.exit(1); }
  if (!fs.existsSync(path.join(target, MARK))) { console.error(`${target} was not made by this script, so --force will not delete it.`); process.exit(1); }
  fs.rmSync(target, { recursive: true, force: true });
}
fs.mkdirSync(target, { recursive: true });

const run = (cmd, a, opts = {}) => { const r = spawnSync(cmd, a, { cwd: target, encoding: 'utf8', ...opts }); if (r.status !== 0) { console.error(`${cmd} ${a.join(' ')} failed:\n${r.stderr || r.stdout}`); process.exit(1); } return r.stdout; };

// 1. install the harness (agents, commands, rules, team, hook)
run(process.execPath, [path.join(SRC, 'install.mjs'), target]);

// 2. the project itself: tiny, honest, with a real test command
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'demo-text-utils', version: '0.0.0', private: true, description: 'Demo project for the agentic harness', scripts: { test: 'node --test' } }, null, 2) + '\n');
fs.writeFileSync(path.join(target, MARK), 'This folder was created by examples/make-demo.mjs. Safe to delete.\n');
fs.mkdirSync(path.join(target, 'src'), { recursive: true });
fs.writeFileSync(path.join(target, 'src', '.gitkeep'), '');
fs.writeFileSync(path.join(target, 'README.md'), `# Demo: text utilities (with the agentic harness)

A tiny project to try the agentic harness. There is no code yet: the agents will build it.

## Try it (10 minutes)

1. Open **this folder** in Claude Code. Accept the **trust dialog**, then **restart the session** (so it loads the named agents \`lead-ba\`, \`lead-dev\`, \`lead-qa\`).
2. Check the setup: type \`/harness:doctor\`.
3. See the team: type \`/harness:team\`.
4. Run the waiting task by itself (autonomous mode is ON): type \`/harness:auto\`.
   It takes the READY task "Add a slugify helper", the three named agents work in front of you, and you get a report.
5. Run your own goal: type for example
   \`/harness:run Add a word counter: wordCount(text) returns the number of words, 0 for an empty string, TypeError if text is not a string\`
6. Read the report. Nothing is committed for you. Look at what changed with \`git status\` and \`git diff\`, commit if you like.

## Running it from a terminal instead (headless)

The controller only uses an AI tool you allowed once on this machine: run \`node .harness/engines.mjs\` first.
Big runs (team or parallel mode) ask before they start.

## What to look for
- The agent names (\`lead-ba\`, \`lead-dev\`, \`lead-qa\`) working at the same time.
- The report: which agent did what, and **PASSED** only if the real check (\`npm test\`) passed.
- Try to break it: ask for something outside the team's scope (for example "change the charter") and watch it refuse.

## Undo and reset
- Undo a run: tell the assistant "roll back the last run" (it runs \`node .harness/visible.mjs rollback <run>\`).
- Start over with a fresh demo: \`node <path to the template>/examples/make-demo.mjs ${path.basename(target)} --force\`.

More: \`.harness/charter.md\` (what it may do on its own), \`.harness/team.json\` (who is on the team), and the template's \`docs/WORKFLOW.md\`.
`);

// 3. charter: real objectives (so autonomous mode may plan new tasks too)
const charterPath = path.join(target, '.harness', 'charter.md');
const charter = fs.readFileSync(charterPath, 'utf8').replace(/\(describe your product goals here[^)]*\)/,
  'Build a tiny text-utilities library (slugify, word count, title case): one small module per function in src/, a short specification for each in docs/, and tests for each in tests/. Every function validates its input, is small and readable, and is covered by tests.');
fs.writeFileSync(charterPath, charter);

// 4. one READY task, with a real check (files exist AND the tests really ran and passed)
const check = `node -e "const f=require('fs');for(const p of ['docs/slugify.md','src/slugify.js','tests/slugify.test.js'])if(!f.existsSync(p)){console.error('missing '+p);process.exit(1)}" && node --test`;
fs.writeFileSync(path.join(target, '.harness', 'backlog.json'), JSON.stringify({ version: '2.0.0', project: 'demo-text-utils', maxAutoTasksPerRun: 3, tasks: [{
  id: 'DEMO-001', title: 'Add a slugify helper', priority: 1, status: 'READY', source: 'demo',
  goal: 'Add a slugify helper: a short spec (docs/slugify.md), the function (src/slugify.js) and its tests (tests/slugify.test.js).',
  interfaceContract: 'src/slugify.js is CommonJS and exports exactly { slugify }. slugify(text) lowercases the text, trims it, replaces every run of characters that are not letters or digits with a single "-", removes a leading or trailing "-", and returns the result. It throws a TypeError if text is not a string.',
  acceptanceCriteria: ['slugify("  Hello, World!  ") === "hello-world"', 'slugify("A  --  B") === "a-b"', 'slugify("") === ""', 'slugify(42) throws a TypeError', 'docs/slugify.md documents the rules and four examples', 'tests/slugify.test.js covers every criterion and passes'],
  verifyCmd: check
}] }, null, 2) + '\n');

// 5. its own git repo with one commit (the harness needs git to undo and to review)
run('git', ['init', '-q', '-b', 'main']);
run('git', ['add', '-A']);
run('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@localhost', 'commit', '-q', '-m', 'Demo project with the agentic harness installed']);

console.log(`\nDemo project created: ${target}\n`);
const doc = spawnSync(process.execPath, ['.harness/doctor.mjs'], { cwd: target, encoding: 'utf8' });
console.log((doc.stdout || '').split('\n').filter((l) => /^  [!✖ℹ]|Failures:/.test(l)).join('\n'));
console.log(`
To try it:
  1. Open the folder in Claude Code:   ${target}
  2. Accept the trust dialog, then restart the session.
  3. Type  /harness:auto     (runs the waiting task "Add a slugify helper" with the named agents)
     or     /harness:run <a goal in plain words>
  Full steps: ${path.join(target, 'README.md')}`);
