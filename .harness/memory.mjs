#!/usr/bin/env node
/**
 * .harness/memory.mjs — the harness "brain" (plain Markdown files in .harness/memory/).
 *
 *   node .harness/memory.mjs remember "..."      add a permanent shared rule (lessons.md, git-tracked)
 *   node .harness/memory.mjs learn "..."         save a local/technical lesson (auto-lessons.md, git-ignored)
 *   node .harness/memory.mjs promote L2          move auto-lesson L2 into shared lessons.md
 *   node .harness/memory.mjs list                show taught rules + auto lessons
 *   node .harness/memory.mjs forget L3           remove taught rule L3
 *   node .harness/memory.mjs forget-auto L2      remove auto lesson L2
 *   node .harness/memory.mjs context [--goal "..."] [--files "a,b"]  print what workers/AIs receive (task-ranked when filtered)
 *   node .harness/memory.mjs sessions [n]        list the last n task records (default 10)
 *   node .harness/memory.mjs me [set --name … --language … --experience … --style … --hats po,qa --skills a,b]
 *                                                 show / write YOUR personal profile (me.md, git-ignored; hats: po ba ux dev qa)
 *
 * Nothing here trains or changes an AI model. Memory works by being re-read:
 * the harness injects it into every worker prompt, and editor, terminal CLI, and cloud AIs read it via AGENTS.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DIRS, FILES, HATS, ensureDirs, loadConfig, remember, forget, promoteLesson, listLessons, memoryContext, helpIfAsked, readMe, writeMe, parseHats } from './lib/common.mjs';
helpIfAsked(import.meta.url);

ensureDirs();
const [cmd, ...rest] = process.argv.slice(2);
if (process.env.HARNESS_WORKER === '1' && (['remember', 'add', 'teach', 'learn', 'remember-auto', 'promote', 'forget', 'forget-auto'].includes(cmd) || (cmd === 'me' && rest[0] === 'set'))) {
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
  case 'learn': case 'remember-auto': {
    const l = remember(text, FILES.autoLessons);
    console.log(l.updated ? `Updated auto-lesson ${l.id}: ${l.text}` : l.duplicate ? `Already learned as ${l.id}: ${l.text}` : `Learned auto-lesson ${l.id} (git-ignored): ${l.text}`);
    break;
  }
  case 'promote': {
    if (!text) { console.error('Give the auto-lesson id to promote, e.g. promote L2'); process.exit(1); }
    const p = promoteLesson(text);
    if (!p) { console.error(`No auto-lesson ${text} found.`); process.exit(1); }
    console.log(p.lesson.duplicate ? `Already in lessons.md as ${p.lesson.id} (removed auto-lesson ${p.fromId}): ${p.lesson.text}` : `Promoted auto-lesson ${p.fromId} → lessons.md ${p.lesson.id}: ${p.lesson.text}`);
    break;
  }
  case 'forget': case 'forget-auto': {
    const file = cmd === 'forget-auto' ? FILES.autoLessons : FILES.lessons;
    if (!text) { console.error('Give the id to forget, e.g. forget L3'); process.exit(1); }
    console.log(forget(text, file) ? `Forgot ${text}.` : `No entry ${text} found.`);
    break;
  }
  case 'me': {
    // node .harness/memory.mjs me                      show this person's me.md (git-ignored)
    // node .harness/memory.mjs me set --name "…" --language "…" --experience "…" --style "…" --hats "po,qa" --skills "a,b"
    if (rest[0] === 'set') {
      const opt = {};
      for (let i = 1; i < rest.length; i++) {
        const m = rest[i].match(/^--(name|language|experience|style|hats|skills)$/);
        if (!m || rest[i + 1] === undefined) { console.error(`Unknown or empty option: ${rest[i]}. Options: --name --language --experience --style --hats --skills`); process.exit(1); }
        opt[m[1]] = rest[++i];
      }
      if (opt.hats !== undefined && opt.hats.trim() && !parseHats(opt.hats).length) { console.error(`No known hat in "${opt.hats}". Hats: ${HATS.join(', ')} (combine them, e.g. "po,qa").`); process.exit(1); }
      const me = writeMe(opt);
      console.log(`Saved ${path.relative(process.cwd(), FILES.me)} (git-ignored, yours only).${me.hats.length ? ` Hats: ${me.hats.join(', ')}.` : ''}`);
      break;
    }
    const me = readMe();
    if (!me.exists) { console.log(`No ${path.relative(process.cwd(), FILES.me)} on this machine yet. Create it: node .harness/memory.mjs me set --name "…" --language "…" --hats "dev"`); break; }
    me.fields.forEach((f) => console.log(`- ${f.label}: ${f.value}`));
    if (me.skills.length) console.log('(Personal skills are for your chat AI only; harness workers never get them.)');
    break;
  }
  case 'list': case undefined: {
    const taught = listLessons(FILES.lessons); const auto = listLessons(FILES.autoLessons);
    console.log(`Taught rules (${taught.length}) — ${path.relative(process.cwd(), FILES.lessons)}`);
    taught.forEach((l) => console.log(`  ${l.id}  ${l.text}`));
    if (!taught.length) console.log('  (none yet — permanent rule: node .harness/memory.mjs remember "...")');
    console.log(`\nAuto lessons (${auto.length}, git-ignored) — ${path.relative(process.cwd(), FILES.autoLessons)}`);
    auto.slice(-10).forEach((l) => console.log(`  ${l.id}  ${l.text}`));
    if (!auto.length) console.log('  (none yet — controller records failures/recoveries here, or run: node .harness/memory.mjs learn "...")');
    console.log(`\nProfile: ${path.relative(process.cwd(), FILES.profile)}`);
    break;
  }
  case 'context': {
    let goalArg = '';
    let queryArg = '';
    const filesArg = [];
    const positionalArgs = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a.startsWith('--goal=')) goalArg = a.slice(7);
      else if (a === '--goal' && rest[i + 1] && !rest[i + 1].startsWith('--')) goalArg = rest[++i];
      else if (a.startsWith('--query=')) queryArg = a.slice(8);
      else if (a === '--query' && rest[i + 1] && !rest[i + 1].startsWith('--')) queryArg = rest[++i];
      else if (a.startsWith('--files=')) filesArg.push(...a.slice(8).split(',').map((s) => s.trim()).filter(Boolean));
      else if (a === '--files' && rest[i + 1] && !rest[i + 1].startsWith('--')) filesArg.push(...rest[++i].split(',').map((s) => s.trim()).filter(Boolean));
      else if (!a.startsWith('--')) positionalArgs.push(a);
    }
    const qParts = [goalArg, queryArg, ...positionalArgs].filter(Boolean).join(' ');
    const query = (qParts || filesArg.length) ? { goal: qParts, files: filesArg } : '';
    console.log(memoryContext(loadConfig(), { query }) || '(memory is empty or disabled)');
    break;
  }
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
    console.error(`Unknown command '${cmd}'. Use: remember | learn | promote | list | forget | forget-auto | context | sessions`);
    process.exit(1);
}
