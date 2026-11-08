#!/usr/bin/env node
/**
 * .harness/watch.mjs — follow the live feed of the harness (what each agent is doing, right now).
 *
 *   node .harness/watch.mjs --job <job-id>     stream until that job is archived, then print RESULT and exit
 *                                              (exit 0 = committed, 1 = failed/halted/rejected, 3 = gave up waiting)
 *   node .harness/watch.mjs                    stream until you stop it (Ctrl+C)
 *   node .harness/watch.mjs --from-start       also print what is already in the feed
 *   node .harness/watch.mjs --from <bytes>     start at a position (dispatch.mjs prints LIVE_FROM=<bytes>, so no early line is missed)
 *   node .harness/watch.mjs --max-wait 900     seconds to wait for --job (default 900)
 *
 * Meant for people (a terminal) and for the editor chat: Claude Code's Monitor tool turns every
 * line printed here into a live message, so you watch the agents work inside the chat.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DIRS, FILES, readJsonSafe } from './lib/common.mjs';

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : undefined; };
const job = val('--job');
const fromStart = args.includes('--from-start');
const maxWaitMs = (Number(val('--max-wait')) || 900) * 1000;

const find = (dir) => { try { return fs.readdirSync(dir).find((f) => f.startsWith(job) && f.endsWith('.json')); } catch { return undefined; } };
const size = () => { try { return fs.statSync(FILES.live).size; } catch { return 0; } };

const fromArg = val('--from');
let offset = fromArg !== undefined && /^\d+$/.test(fromArg) ? Math.min(Number(fromArg), size()) : fromStart ? 0 : size();
let carry = '';
const started = Date.now();
let idleNoticeAt = 0;

function drain() {
  const now = size();
  if (now < offset) offset = 0; // the daemon restarted and truncated the feed
  if (now === offset) return;
  const fd = fs.openSync(FILES.live, 'r');
  const buf = Buffer.alloc(now - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = now;
  const lines = (carry + buf.toString('utf8')).split('\n');
  carry = lines.pop();
  for (const l of lines) if (l.trim()) console.log(l);
}

function daemonRunning() {
  try { process.kill(Number(fs.readFileSync(FILES.pid, 'utf8')), 0); return true; } catch { return false; }
}

if (job) console.log(`[watch] following job ${job} (the controller must be running: node .harness/daemon.mjs)`);
for (;;) {
  drain();
  if (job) {
    const done = find(DIRS.completed); const failed = find(DIRS.failed);
    if (done || failed) {
      drain();
      if (done) { console.log(`[watch] RESULT: COMMITTED ✔  (${path.join('.harness', 'completed', done)})`); process.exit(0); }
      const body = readJsonSafe(path.join(DIRS.failed, failed));
      console.log(`[watch] RESULT: NOT DONE ✖  ${body.result || ''} ${String(body.haltReason || '').split('\n')[0].slice(0, 200)}`);
      process.exit(1);
    }
    if (!daemonRunning() && Date.now() - started > 5000 && Date.now() - idleNoticeAt > 30000) {
      idleNoticeAt = Date.now();
      console.log('[watch] ! no controller is running, so nothing will process this job. Start it: node .harness/daemon.mjs');
    }
    if (Date.now() - started > maxWaitMs) { console.log(`[watch] gave up after ${Math.round(maxWaitMs / 1000)}s; the job is still running or queued`); process.exit(3); }
  }
  await new Promise((r) => setTimeout(r, 500));
}
