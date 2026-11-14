#!/usr/bin/env node
/**
 * .harness/status.mjs — show what the harness is doing right now, in plain language.
 *   node .harness/status.mjs          one-shot summary
 *   node .harness/status.mjs --log 20 also print the last 20 telemetry events
 */

import fs from 'node:fs';
import { FILES, DIRS, readJsonSafe, helpIfAsked } from './lib/common.mjs';
helpIfAsked(import.meta.url);
import { readBacklog, backlogCounts } from './lib/governance.mjs';

const s = readJsonSafe(FILES.state, null);
if (!s) { console.log('The harness has not run yet in this folder. Start it with: node .harness/daemon.mjs'); process.exit(0); }

let alive = false;
try { process.kill(Number(fs.readFileSync(FILES.pid, 'utf8')), 0); alive = true; } catch { /* not running */ }
const count = (d) => fs.readdirSync(d).filter((f) => f.endsWith('.json')).length;

console.log(`Daemon:     ${alive ? `running (PID ${s.pid})` : 'NOT running'}`);
console.log(`Phase:      ${s.phase}   (cycle ${s.cycle || 0}/${s.maxCycles || 3})`);
console.log(`Engine:     ${s.engine || '-'}   Topology: ${s.mode || '-'}`);
console.log(`Task:       ${s.taskTitle || '-'}`);
console.log(`Workers:    ${s.workerSummary || '-'}`);
console.log(`Check:      ${s.lastGateStatus || '-'}`);
console.log(`Inbox: ${count(DIRS.inbox)} waiting | Completed: ${count(DIRS.completed)} | Failed/halted: ${count(DIRS.failed)}`);
const c = backlogCounts(readBacklog());
console.log(`Backlog:    READY ${c.READY} | IN_PROGRESS ${c.IN_PROGRESS} | DONE ${c.DONE} | BLOCKED ${c.BLOCKED} | BACKLOG ${c.BACKLOG}`);
console.log(`Autonomous: ${s.autoStatus || 'off'}`);
console.log(`Updated:    ${s.updatedAt}`);

const i = process.argv.indexOf('--log');
if (i > -1 && fs.existsSync(FILES.log)) {
  const n = Number(process.argv[i + 1]) || 20;
  console.log(`\nLast ${n} events (.harness/telemetry.log):`);
  for (const line of fs.readFileSync(FILES.log, 'utf8').trim().split('\n').slice(-n)) {
    try { const e = JSON.parse(line); console.log(`  ${e.ts.slice(11, 19)}  ${e.phase.padEnd(20)} ${String(e.message).replace(/\s+/g, ' ').slice(0, 110)}`); } catch { /* skip */ }
  }
}
