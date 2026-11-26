#!/usr/bin/env node
/**
 * .harness/backlog.mjs — the backlog, imports with release snapshots, and the release archive.
 *
 *   node .harness/backlog.mjs list                       show the backlog by status (default)
 *   node .harness/backlog.mjs add "Title" [--goal "…"] [--ready] [--priority 1]
 *        [--files "src/a.js,docs/"] [--role DEV_ENGINEER] [--skills code-craft] [--check "npm test"] [--auto-plan]
 *   node .harness/backlog.mjs ready <id>                 BACKLOG/BLOCKED → READY
 *   node .harness/backlog.mjs approve <id>               OK an item autopilot held ("needs your OK": big run or possible prompt injection) → READY
 *   node .harness/backlog.mjs block <id> "reason"        → BLOCKED
 *   node .harness/backlog.mjs done <id> "how it was finished"   → DONE (work finished outside the harness; the note is kept)
 *   node .harness/backlog.mjs pop                        move the next READY item into the inbox now
 *   node .harness/backlog.mjs import <file|folder> [--reset-memory]
 *        backlog .json  → replaces backlog.json
 *        charter .md    → replaces charter.md
 *        skills folder  → replaces .harness/skills/ (each sub-folder has a SKILL.md)
 *      Before replacing, the current charter + backlog (+ skills) and a summary of finished work are
 *      saved to .harness/releases/release-<time>/, and unstarted inbox jobs are moved there too.
 *      lessons.md / auto-lessons.md are kept unless --reset-memory (then they are saved + reset).
 *   node .harness/backlog.mjs releases                   list release snapshots
 *   node .harness/backlog.mjs overview                   backlog + releases
 *
 * Aliases from the v2 spec: --pop, --import <file>.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DIRS, FILES, ensureDirs, readJsonSafe, helpIfAsked, harnessPidAlive } from './lib/common.mjs';
helpIfAsked(import.meta.url);
import {
  GOV, STATUSES, readBacklog, writeBacklog, updateBacklogItem, validateBacklog, nextReady, backlogCounts,
  itemToJob, snapshotRelease, resetMemory, listReleases, loadSkills, waitingReady
} from './lib/governance.mjs';
import { checkHumanApprovalOrigin } from './lib/guard.mjs';

ensureDirs();
let argv = process.argv.slice(2);
if (process.env.HARNESS_WORKER === '1' && !['list', 'overview', 'releases'].includes(argv[0] || 'list')) {
  console.error('Harness workers may only read the backlog (list / overview / releases).');
  process.exit(2);
}
if (argv[0] === '--pop') argv[0] = 'pop';
if (argv[0] === '--import') argv[0] = 'import';
const [cmd = 'list', ...rest] = argv;
const flag = (name) => { const i = rest.indexOf(name); return i > -1 ? rest[i + 1] : undefined; };
const has = (name) => rest.includes(name);
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && !['--ready', '--auto-plan', '--reset-memory', '--force'].includes(rest[i - 1])));

function daemonBusy() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(FILES.pid, 'utf8')); if (!harnessPidAlive(pid)) return null; } catch { return null; }
  const s = readJsonSafe(FILES.state, {});
  return s.currentTaskFile ? { pid, file: s.currentTaskFile, title: s.taskTitle } : null;
}

/**
 * The job of this backlog item that is still queued (inbox) or running (live daemon), or null. Job ids start with the
 * item id ("X1-run…"). A stale IN_PROGRESS item (its daemon died, nothing queued) has none, so it can still be reset.
 */
function liveJob(id) {
  const mine = (f) => path.basename(String(f || '')).startsWith(`${id}-`);
  try { const q = fs.readdirSync(DIRS.inbox).find((f) => f.endsWith('.json') && mine(f)); if (q) return `queued in .harness/inbox/${q}`; } catch { /* no inbox */ }
  const busy = daemonBusy();
  return busy && mine(busy.file) ? `running in the daemon (PID ${busy.pid})` : null;
}

/** Refuse a status change that would run an item twice, or reopen finished work by accident (--force overrides). */
function guardChange(id, cmd) {
  if (has('--force') || cmd === 'block') return; // blocking can never run anything twice
  const item = readBacklog().tasks.find((t) => t.id === id);
  if (!item) return; // "No backlog item" is reported by the caller
  const job = liveJob(id);
  if (job) { console.error(`${id} has a job ${job}. ${cmd === 'done' ? 'Closing' : 'Queuing'} it now would ${cmd === 'done' ? 'hide work that is still running' : 'run the same task twice'}. Wait for it to finish (or stop it), or add --force.`); process.exit(1); }
  if (item.status === 'DONE' && cmd !== 'done') { console.error(`${id} is already DONE. To run it again on purpose: node .harness/backlog.mjs ${cmd} ${id} --force`); process.exit(1); }
}

function show() {
  const b = readBacklog();
  const c = backlogCounts(b);
  console.log(`Backlog${b.project ? ` — ${b.project}` : ''}  (.harness/backlog.json)`);
  console.log(STATUSES.map((s) => `${s} ${c[s]}`).join(' | '));
  for (const s of ['IN_PROGRESS', 'READY', 'BACKLOG', 'BLOCKED', 'DONE']) {
    const items = b.tasks.filter((t) => (t.status || 'BACKLOG') === s).sort((a, z) => (a.priority ?? 99) - (z.priority ?? 99));
    if (!items.length) continue;
    console.log(`\n${s}`);
    for (const t of items) {
      const workers = Array.isArray(t.subtasks) ? t.subtasks.map((w) => w.role || 'worker').join('+') : (t.autoPlan ? 'AI-planned' : t.role || 'worker');
      console.log(`  ${String(t.id).padEnd(26)} p${t.priority ?? '-'}  ${t.title || t.goal}  [${workers}]${t.source ? ` (by ${t.source})` : ''}`);
      if (s === 'BLOCKED' && t.blockedReason) console.log(`  ${''.padEnd(26)}     ↳ ${t.blockedReason.slice(0, 160)}`);
    }
  }
  const next = nextReady(b);
  const wait = waitingReady(b);
  console.log(`\nNext to run: ${next ? `${next.id} — ${next.title}` : wait.length ? `(nothing can start: ${wait.length} READY item(s) wait for ${[...new Set(wait.flatMap((w) => w.after))].slice(0, 4).join(', ')})` : '(nothing READY)'}`);
}

function showReleases() {
  const rel = listReleases();
  console.log(`Release snapshots (${rel.length}) in .harness/releases/`);
  for (const r of rel) {
    const sum = path.join(GOV.releases, r, 'completed-summary.md');
    const reason = fs.existsSync(sum) ? (fs.readFileSync(sum, 'utf8').match(/^Reason: (.*)$/m) || [])[1] : '';
    console.log(`  ${r}  ${reason || ''}`);
  }
}

switch (cmd) {
  case 'list': show(); break;
  case 'overview': show(); console.log(''); showReleases(); break;
  case 'releases': showReleases(); break;

  case 'add': {
    const title = positional[0] || flag('--goal');
    if (!title) { console.error('Usage: backlog.mjs add "Title" [--goal "…"] [--ready] …'); process.exit(1); }
    const b = readBacklog();
    const pRaw = flag('--priority');
    const priority = pRaw !== undefined && pRaw !== '' && Number.isFinite(Number(pRaw)) ? Number(pRaw) : 5;
    const item = {
      id: `B-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 5)}`,
      title, goal: flag('--goal') || title, priority,
      status: has('--ready') || /^ready$/i.test(flag('--status') || '') ? 'READY' : 'BACKLOG', source: 'human', createdAt: new Date().toISOString()
    };
    const files = (flag('--files') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (files.length) item.targetFiles = files;
    if (flag('--role')) item.role = flag('--role').toUpperCase();
    if (flag('--skills')) item.skills = flag('--skills').split(',').map((s) => s.trim()).filter(Boolean);
    if (flag('--check')) item.verifyCmd = flag('--check'); // a human-written check = explicit task contract
    if (has('--auto-plan')) item.autoPlan = true;
    b.tasks.push(item); writeBacklog(b);
    console.log(`Added ${item.id} [${item.status}] ${item.title}`);
    break;
  }

  case 'done': { // work finished outside the harness (by hand, another tool): close the item with a note, never silently
    const id = positional[0];
    const note = positional.slice(1).join(' ').trim();
    guardChange(id, 'done');
    if (!note) { console.error(`Say how it was finished, e.g.: node .harness/backlog.mjs done ${id || '<id>'} "fixed by hand in commit abc123"`); process.exit(1); }
    const item = updateBacklogItem(id, { status: 'DONE', completedAt: new Date().toISOString(), result: 'DONE_OUTSIDE_HARNESS', doneNote: note.slice(0, 300), blockedReason: undefined, needsApproval: undefined, awaitingJudge: undefined });
    if (!item) { console.error(`No backlog item "${id}".`); process.exit(1); }
    console.log(`${id} → DONE (finished outside the harness: ${note.slice(0, 300)})`);
    break;
  }

  case 'ready': case 'block': case 'reset': {
    const id = positional[0];
    const status = cmd === 'block' ? 'BLOCKED' : 'READY';
    guardChange(id, cmd);
    const patch = { status, ...(cmd === 'block' ? { blockedReason: positional[1] || 'blocked by a human' } : { blockedReason: undefined }) };
    const item = updateBacklogItem(id, patch);
    if (!item) { console.error(`No backlog item "${id}".`); process.exit(1); }
    console.log(`${id} → ${status}`);
    break;
  }

  case 'approve': { // a big run that autopilot held: the person OKs it (also allows the high model for this item)
    const id = positional[0];
    const origin = checkHumanApprovalOrigin({ root: ROOT, actionRule: 'Bash(node .harness/backlog.mjs approve:*)', commandHint: `node .harness/backlog.mjs approve ${id || '<id>'}` });
    if (!origin.ok) { console.error(origin.reason); process.exit(1); }
    guardChange(id, 'approve');
    const item = updateBacklogItem(id, { status: 'READY', costApproved: true, injectionApproved: true, needsApproval: undefined, blockedReason: undefined });
    if (!item) { console.error(`No backlog item "${id}".`); process.exit(1); }
    console.log(`${id} → READY, big run approved (autopilot may use the team / parallel mode and the high model for it)`);
    break;
  }

  case 'pop': {
    const item = nextReady();
    if (!item) {
      const wait = waitingReady();
      console.log(wait.length ? `Nothing can start now: ${wait.length} READY item(s) wait for other items (${wait.slice(0, 3).map((w) => `${w.id} after ${w.after.join('+')}`).join(', ')}).` : 'Nothing READY in the backlog.');
      break;
    }
    const job = itemToJob(item, { autonomous: false });
    const file = path.join(DIRS.inbox, `${job.id}.json`);
    updateBacklogItem(item.id, { status: 'IN_PROGRESS', startedAt: new Date().toISOString(), lastJobId: job.id });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(job, null, 2)); fs.renameSync(`${file}.tmp`, file);
    console.log(`[BACKLOG] Promoted ${item.id} to inbox as ${job.id}.`);
    break;
  }

  case 'import': {
    const origin = checkHumanApprovalOrigin({ root: ROOT, actionRule: 'Bash(node .harness/backlog.mjs import:*)', commandHint: `node .harness/backlog.mjs import ${positional[0] || '<file>'}` });
    if (!origin.ok) { console.error(origin.reason); process.exit(1); }
    const src = positional[0] && path.resolve(process.cwd(), positional[0]);
    if (!src || !fs.existsSync(src)) { console.error(`File or folder not found: ${positional[0] || '(none given)'}`); process.exit(1); }
    const busy = daemonBusy();
    if (busy && !has('--force')) {
      console.error(`The harness is running a task right now ("${busy.title}"). Wait for it to finish (or stop the daemon), then import again.`);
      process.exit(2);
    }
    const isDir = fs.statSync(src).isDirectory();
    const kind = isDir ? 'skills' : src.endsWith('.md') ? 'charter' : 'backlog';

    // Validate BEFORE touching anything: a bad upload must not cost the current state.
    let newBacklog = null;
    if (kind === 'backlog') {
      try { newBacklog = validateBacklog(JSON.parse(fs.readFileSync(src, 'utf8'))); } catch (e) { console.error(`Not imported — invalid backlog: ${e.message}`); process.exit(1); }
    }
    if (kind === 'skills') {
      const packs = fs.readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(src, d.name, 'SKILL.md')));
      if (!packs.length) { console.error('Not imported — the folder has no <skill>/SKILL.md sub-folders.'); process.exit(1); }
      for (const p of packs) {
        if (!/^---\r?\n[\s\S]*?\bname\s*:/m.test(fs.readFileSync(path.join(src, p.name, 'SKILL.md'), 'utf8'))) { console.error(`Not imported — ${p.name}/SKILL.md has no frontmatter "name:".`); process.exit(1); }
      }
    }
    if (kind === 'charter' && !fs.readFileSync(src, 'utf8').trim()) { console.error('Not imported — the charter file is empty.'); process.exit(1); }

    const snap = snapshotRelease({ reason: `import ${kind} from ${path.basename(src)}`, includeSkills: kind === 'skills', includeMemory: has('--reset-memory'), busyFile: busy?.file });
    if (kind === 'backlog') writeBacklog({ version: '2.0.0', ...newBacklog, importedAt: new Date().toISOString(), importedFrom: path.basename(src) });
    if (kind === 'charter') fs.copyFileSync(src, GOV.charter);
    if (kind === 'skills') { fs.rmSync(GOV.skills, { recursive: true, force: true }); fs.cpSync(src, GOV.skills, { recursive: true }); }
    if (has('--reset-memory')) resetMemory();

    console.log(`Snapshot saved: ${path.relative(process.cwd(), snap.dir)}  (${snap.saved.join(', ')})`);
    if (snap.moved.length) console.log(`Moved ${snap.moved.length} unstarted inbox job(s) into the snapshot: ${snap.moved.join(', ')}`);
    console.log(`Imported new ${kind}: ${path.basename(src)}.`);
    console.log(has('--reset-memory') ? 'Memory lessons were saved in the snapshot and reset.' : 'Memory (lessons.md, auto-lessons.md) kept.');
    if (kind === 'backlog') { console.log(''); show(); }
    if (kind === 'skills') console.log(`Skills now: ${Object.keys(loadSkills()).join(', ')}`);
    break;
  }

  default:
    console.error(`Unknown command "${cmd}". Use: list | overview | add | ready | block | pop | import | releases  (see --help in the file header)`);
    process.exit(1);
}
