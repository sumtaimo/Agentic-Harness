#!/usr/bin/env node
/**
 * .harness/hunt.mjs — bug hunt: QA_AUDITOR looks for real bugs (read-only; it may run the project's tests), you keep
 * the ones to fix (one stop), then autopilot fixes each one Red-Green on the 'uat' branch.
 *
 *   node .harness/hunt.mjs                               hunt the whole project now (needs an allowed AI tool)
 *   node .harness/hunt.mjs "checkout" [--files src/cart/] [--max 10]   hunt one area (cheaper, better results)
 *   node .harness/hunt.mjs new "checkout" [--files …] [--no-run]
 *   node .harness/hunt.mjs run H1 [--from findings.json]  (re)run; --from = JSON written by your editor's QA agent
 *   node .harness/hunt.mjs prompt H1                     print the hunter prompt (for an editor agent)
 *   node .harness/hunt.mjs show H1                       the findings with their evidence
 *   node .harness/hunt.mjs approve H1 --keep 1,3         keep those bugs (or --keep 1-3, or --all) → READY bug-fix items
 *   node .harness/hunt.mjs cancel H1                     drop a hunt that is not approved yet
 *   node .harness/hunt.mjs status                        every hunt and how far its fixes got
 *   npm run hunt -- "checkout"                           same as the second line
 *
 * Every finding needs evidence (file:line, what was run or read, expected vs actual): ✅ confirmed = a command really
 * failed, 🟡 suspect = found by reading only. Findings without evidence or without a Red-Green fix plan are dropped and
 * named. At most 10 per hunt by default (--max, never more than 20). Nothing is fixed before you approve.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, HARNESS_DIR, ensureDirs, helpIfAsked } from './lib/common.mjs';
helpIfAsked(import.meta.url);
import { readBacklog, writeBacklog, loadRoles } from './lib/governance.mjs';
import { plannerSkills } from './lib/feature.mjs';
import { createHunt, findHunt, approveHunt, huntProgress, huntPrompt, renderHuntDoc, readHunts, HUNT_MAX_FINDINGS } from './lib/hunt.mjs';

ensureDirs();
const argv = process.argv.slice(2);
const READ_ONLY = ['status', 'show', 'prompt', 'list'];
const known = ['new', 'run', 'prompt', 'show', 'approve', 'cancel', 'status', 'list'];
let cmd = argv[0] || 'new';
let rest = argv.slice(1);
if (!known.includes(cmd)) { cmd = 'new'; rest = argv; } // `hunt "checkout"` / `hunt --files src/` = new + run
if (process.env.HARNESS_WORKER === '1' && !READ_ONLY.includes(cmd)) { console.error('Harness workers may only read hunts (status / show / prompt).'); process.exit(2); }

const flag = (name) => rest.includes(name);
const val = (name) => { const i = rest.indexOf(name); return i > -1 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : undefined; };
const positional = () => { const out = []; for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) { if (['--max', '--keep', '--from', '--files'].includes(rest[i])) i++; continue; } out.push(rest[i]); } return out; };
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const need = () => { const id = positional()[0]; if (!id) die(`Usage: node .harness/hunt.mjs ${cmd} H1`); const h = findHunt(id); if (!h) die(`No hunt ${id}. See: node .harness/hunt.mjs status`); return h; };

function run(h, from) {
  const args = [path.join(HARNESS_DIR, 'daemon.mjs'), '--hunt-run', h.id];
  if (from) args.push('--from', path.resolve(from));
  return spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
}

switch (cmd) {
  case 'new': {
    const files = (val('--files') || '').split(',').map((f) => f.trim()).filter(Boolean);
    let h; try { h = createHunt(positional().join(' '), { files, max: val('--max') ?? HUNT_MAX_FINDINGS }); } catch (e) { die(e.message); }
    console.log(`${h.id} created: hunting "${h.scope}"${h.files.length ? ` in ${h.files.join(', ')}` : ''} (≤ ${h.maxFindings} findings). Report will be ${h.doc}.`);
    if (flag('--no-run')) { console.log(`Run it later: node .harness/hunt.mjs run ${h.id}   (editor: node .harness/hunt.mjs prompt ${h.id})`); break; }
    process.exit(run(h));
  }
  case 'run': { const h = need(); process.exit(run(h, val('--from'))); }
  case 'prompt': {
    const h = need();
    const ps = plannerSkills('QA_AUDITOR', h.scope, { id: `${h.id.toLowerCase()}-planner` });
    if (ps.skills.length) console.error(`Skills for QA: ${ps.skills.map((x) => x.name).join(', ')}${ps.fetched.length ? ` (added from Skill Foundry: ${ps.fetched.join(', ')})` : ''}`);
    console.log(huntPrompt(h, loadRoles().QA_AUDITOR, { skills: ps.block }));
    console.log(`\n[EDITOR NOTE] Give this to a QA agent that may read files and run the project's tests but writes nothing. Save its JSON reply to a file, then: node .harness/hunt.mjs run ${h.id} --from <file>`);
    break;
  }
  case 'show': {
    const h = need();
    if (h.status === 'DRAFTING') { console.log(`${h.id} "${h.scope}" has not finished.${h.lastError ? `\nLast error: ${h.lastError}` : ''}`); break; }
    console.log(renderHuntDoc(h));
    if (h.status === 'DRAFT') console.log(`Keep the bugs to fix: node .harness/hunt.mjs approve ${h.id} --keep 1,2   (or --all)`);
    break;
  }
  case 'approve': {
    const h = need();
    const spec = flag('--all') ? 'all' : val('--keep');
    if (!spec) die(`Say which bugs to fix: node .harness/hunt.mjs approve ${h.id} --keep 1,3   (or --keep 1-3, or --all)`);
    let r; try { r = approveHunt(h.id, spec); } catch (e) { die(e.message); }
    console.log(`${r.hunt.id} APPROVED: ${r.added.length} bug fix(es) are READY in the backlog (${r.added.map((t) => t.id).join(', ')}), most severe first.`);
    for (const w of r.warnings) console.log(`! ${w}`);
    console.log('Fix them: npm run auto  (autopilot, on the uat branch)  ·  in Claude Code: /harness:auto  ·  progress: node .harness/hunt.mjs status');
    break;
  }
  case 'cancel': {
    const h = need();
    if (h.status === 'APPROVED') die(`${h.id} is approved: its fixes are backlog items now. Block them instead: node .harness/backlog.mjs block <id> "reason"`);
    const b = readBacklog();
    b.hunts = readHunts(b).map((x) => (x.id === h.id ? { ...x, status: 'CANCELLED', cancelledAt: new Date().toISOString() } : x));
    writeBacklog(b);
    console.log(`${h.id} cancelled (kept in the list; nothing was fixed).`);
    break;
  }
  default: {
    const rows = huntProgress();
    if (!rows.length) { console.log('No bug hunts yet. Start one: node .harness/hunt.mjs "checkout" --files src/cart/'); break; }
    for (const p of rows) {
      const tail = p.status === 'APPROVED' || p.status === 'DONE'
        ? `${p.done}/${p.kept} fixed${p.running ? `, ${p.running} running` : ''}${p.ready ? `, ${p.ready} waiting` : ''}${p.blocked ? `, ${p.blocked} BLOCKED (needs you)` : ''}`
        : p.status === 'DRAFT' ? `${p.findings} finding(s), ${p.confirmed} confirmed → approve ${p.id} --keep …` : p.lastError ? `last error: ${p.lastError.slice(0, 120)}` : '';
      console.log(`${p.id.padEnd(4)} ${p.status.padEnd(9)} ${p.scope.slice(0, 50).padEnd(50)} ${tail}`);
    }
  }
}
