#!/usr/bin/env node
/**
 * .harness/backlog.mjs — the backlog, imports with release snapshots, and the release archive.
 *
 *   node .harness/backlog.mjs list                       show the backlog by status (default)
 *   node .harness/backlog.mjs add "Title" [--goal "…"] [--ready] [--priority 1]
 *        [--files "src/a.js,docs/"] [--role DEV_ENGINEER] [--skills code-craft] [--check "npm test"] [--auto-plan]
 *   node .harness/backlog.mjs ready <id>                 BACKLOG/BLOCKED → READY
 *   node .harness/backlog.mjs approve <id>               OK a big run that autopilot held ("needs your OK") → READY
 *   node .harness/backlog.mjs block <id> "reason"        → BLOCKED
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
import { DIRS, FILES, ensureDirs, readJsonSafe, helpIfAsked } from './lib/common.mjs';
helpIfAsked(import.meta.url);
import {
  GOV, STATUSES, readBacklog, writeBacklog, updateBacklogItem, validateBacklog, nextReady, backlogCounts,
  itemToJob, snapshotRelease, resetMemory, listReleases, loadSkills
} from './lib/governance.mjs';

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
  try { pid = Number(fs.readFileSync(FILES.pid, 'utf8')); process.kill(pid, 0); } catch { return null; }
  const s = readJsonSafe(FILES.state, {});
  return s.currentTaskFile ? { pid, file: s.currentTaskFile, title: s.taskTitle } : null;
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
  console.log(`\nNext to run: ${next ? `${next.id} — ${next.title}` : '(nothing READY)'}`);
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
    const item = {
      id: `B-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 5)}`,
      title, goal: flag('--goal') || title, priority: Number(flag('--priority')) || 5,
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

  case 'ready': case 'block': case 'reset': {
    const id = positional[0];
    const status = cmd === 'block' ? 'BLOCKED' : 'READY';
    const patch = { status, ...(cmd === 'block' ? { blockedReason: positional[1] || 'blocked by a human' } : { blockedReason: undefined }) };
    const item = updateBacklogItem(id, patch);
    if (!item) { console.error(`No backlog item "${id}".`); process.exit(1); }
    console.log(`${id} → ${status}`);
    break;
  }

  case 'approve': { // a big run that autopilot held: the person OKs it (also allows the high model for this item)
    const id = positional[0];
    const item = updateBacklogItem(id, { status: 'READY', costApproved: true, needsApproval: undefined, blockedReason: undefined });
    if (!item) { console.error(`No backlog item "${id}".`); process.exit(1); }
    console.log(`${id} → READY, big run approved (autopilot may use the team / parallel mode and the high model for it)`);
    break;
  }

  case 'pop': {
    const item = nextReady();
    if (!item) { console.log('Nothing READY in the backlog.'); break; }
    const job = itemToJob(item, { autonomous: false });
    const file = path.join(DIRS.inbox, `${job.id}.json`);
    updateBacklogItem(item.id, { status: 'IN_PROGRESS', startedAt: new Date().toISOString(), lastJobId: job.id });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(job, null, 2)); fs.renameSync(`${file}.tmp`, file);
    console.log(`[BACKLOG] Promoted ${item.id} to inbox as ${job.id}.`);
    break;
  }

  case 'import': {
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
