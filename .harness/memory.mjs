#!/usr/bin/env node
/**
 * .harness/memory.mjs — the harness "brain" (plain Markdown files in .harness/memory/).
 *
 *   node .harness/memory.mjs remember "Always explain changes in simple English"
 *   node .harness/memory.mjs list                 show taught rules + auto lessons
 *   node .harness/memory.mjs forget L3            remove taught rule L3
 *   node .harness/memory.mjs forget-auto L2       remove auto lesson L2
 *   node .harness/memory.mjs context              print exactly what workers receive
 *   node .harness/memory.mjs sessions [n]         list the last n task records (default 10)
 *
 * Nothing here trains or changes an AI model. Memory works by being re-read:
 * the harness injects it into every worker prompt, and the editor AI reads it via AGENTS.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DIRS, FILES, ensureDirs, loadConfig, remember, forget, listLessons, memoryContext, helpIfAsked } from './lib/common.mjs';
helpIfAsked(import.meta.url);

ensureDirs();
const [cmd, ...rest] = process.argv.slice(2);
if (process.env.HARNESS_WORKER === '1' && ['remember', 'add', 'teach', 'forget', 'forget-auto'].includes(cmd)) {
  console.error('Harness workers must not change the user memory.');
  process.exit(2);
}
const text = rest.join(' ').trim();

switch (cmd) {
  case 'remember': case 'add': case 'teach': {
    const l = remember(text);
    console.log(l.duplicate ? `Already remembered as ${l.id}: ${l.text}` : `Remembered ${l.id}: ${l.text}`);
    break;
  }
  case 'forget': case 'forget-auto': {
    const file = cmd === 'forget-auto' ? FILES.autoLessons : FILES.lessons;
    if (!text) { console.error('Give the id to forget, e.g. forget L3'); process.exit(1); }
    console.log(forget(text, file) ? `Forgot ${text}.` : `No entry ${text} found.`);
    break;
  }
  case 'list': case undefined: {
    const taught = listLessons(FILES.lessons); const auto = listLessons(FILES.autoLessons);
    console.log(`Taught rules (${taught.length}) — ${path.relative(process.cwd(), FILES.lessons)}`);
    taught.forEach((l) => console.log(`  ${l.id}  ${l.text}`));
    if (!taught.length) console.log('  (none yet — teach one with: node .harness/memory.mjs remember "...")');
    console.log(`\nAuto lessons (${auto.length}) — ${path.relative(process.cwd(), FILES.autoLessons)}`);
    auto.slice(-10).forEach((l) => console.log(`  ${l.id}  ${l.text}`));
    console.log(`\nProfile: ${path.relative(process.cwd(), FILES.profile)}`);
    break;
  }
  case 'context':
    console.log(memoryContext(loadConfig()) || '(memory is empty or disabled)');
    break;
  case 'sessions': {
    const n = Number(text) || 10;
    const files = fs.readdirSync(DIRS.sessions).filter((f) => f.endsWith('.md')).sort().slice(-n);
    if (!files.length) console.log('No task records yet.');
    for (const f of files) {
      const body = fs.readFileSync(path.join(DIRS.sessions, f), 'utf8');
      const title = body.split('\n')[0].replace(/^# /, '');
      const result = (body.match(/Result: \*\*(\w+)\*\*/) || [])[1] || '?';
      console.log(`${result.padEnd(22)} ${title}   (.harness/memory/sessions/${f})`);
    }
    break;
  }
  default:
    console.error(`Unknown command '${cmd}'. Use: remember | list | forget | forget-auto | context | sessions`);
    process.exit(1);
}
