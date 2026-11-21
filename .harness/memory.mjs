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
 *   node .harness/memory.mjs me share [--ask "…"] [--language ["…"]] [--git]   put your name + hats (and what you choose) on the team page (people.md, committed)
 *   node .harness/memory.mjs me unshare           remove yourself from the team page
 *   node .harness/memory.mjs me from-profile      move personal lines (name, language, style…) from the shared profile.md into your me.md
 *   node .harness/memory.mjs people               show the team page: who wears which hat, who to ask about what
 *
 * Nothing here trains or changes an AI model. Memory works by being re-read:
 * the harness injects it into every worker prompt, and editor, terminal CLI, and cloud AIs read it via AGENTS.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DIRS, FILES, HATS, ensureDirs, loadConfig, remember, forget, promoteLesson, listLessons, memoryContext, helpIfAsked, readMe, writeMe, parseHats, meFile, readPeople, sharePerson, unsharePerson, meFromProfile } from './lib/common.mjs';
helpIfAsked(import.meta.url);

ensureDirs();
const [cmd, ...rest] = process.argv.slice(2);
if (process.env.HARNESS_WORKER === '1' && (['remember', 'add', 'teach', 'learn', 'remember-auto', 'promote', 'forget', 'forget-auto'].includes(cmd) || (cmd === 'me' && ['set', 'share', 'unshare', 'from-profile'].includes(rest[0])))) {
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
      console.log(`Saved ${path.relative(process.cwd(), meFile())} (git-ignored, yours only).${me.hats.length ? ` Hats: ${me.hats.join(', ')}.` : ''}`);
      break;
    }
    if (rest[0] === 'share') {
      // node .harness/memory.mjs me share [--ask "releases, acceptance"] [--language ["Khmer, English"]] [--git]
      // Adds/updates YOUR section of the committed team page from me.md (name, hats) + what you choose here.
      const opt = {};
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === '--git') { opt.git = true; continue; }
        if (rest[i] === '--language') { const v = rest[i + 1]; if (v === undefined || v.startsWith('--')) opt.language = true; else { opt.language = v; i++; } continue; }
        if (rest[i] === '--ask' && rest[i + 1] !== undefined) { opt.ask = rest[++i]; continue; }
        console.error(`Unknown or empty option: ${rest[i]}. Options: --ask "…" --language ["…"] --git`); process.exit(1);
      }
      try {
        const e = sharePerson(opt);
        console.log(`Shared on the team page ${path.relative(process.cwd(), FILES.people)} (committed, everyone sees it): ${e.name}${e.hats.length ? ` · hats ${e.hats.join(', ')}` : ''}${e.ask ? ` · ask about ${e.ask}` : ''}${e.language ? ` · ${e.language}` : ''}${e.git ? ` · git "${e.git}"` : ''}.`);
        console.log('Your answer style, coding experience and personal skills stay private in me.md. Commit people.md to share it.');
      } catch (err) { console.error(err.message); process.exit(1); }
      break;
    }
    if (rest[0] === 'from-profile') {
      // node .harness/memory.mjs me from-profile   move YOUR personal lines out of the shared profile.md into me.md
      const moved = meFromProfile();
      console.log(moved.length ? `Moved ${moved.join(', ')} from ${path.relative(process.cwd(), FILES.profile)} into ${path.relative(process.cwd(), meFile())} (yours, git-ignored). profile.md now describes only the project; commit it.` : 'profile.md has no personal lines: nothing to move.');
      break;
    }
    if (rest[0] === 'unshare') {
      const name = readMe().fields.find((f) => f.key === 'name')?.value;
      if (!name) { console.error('No name in your me.md, so nothing to remove.'); process.exit(1); }
      console.log(unsharePerson(name) ? `Removed ${name} from ${path.relative(process.cwd(), FILES.people)}. Commit it to update the team.` : `${name} is not on the team page.`);
      break;
    }
    const me = readMe();
    if (!me.exists) { console.log(`No ${path.relative(process.cwd(), meFile())} on this machine yet. Create it: node .harness/memory.mjs me set --name "…" --language "…" --hats "dev"`); break; }
    me.fields.forEach((f) => console.log(`- ${f.label}: ${f.value}`));
    if (me.skills.length) console.log('(Personal skills are for your chat AI only; harness workers never get them.)');
    break;
  }
  case 'people': case 'team': {
    // node .harness/memory.mjs people   show the shared team page (people.md)
    const people = readPeople();
    if (!people.length) { console.log('Nobody is on the team page yet. Add yourself: node .harness/memory.mjs me share --ask "…" --language --git'); break; }
    for (const p of people) console.log(`${p.name}${p.hats.length ? `  [${p.hats.join(', ')}]` : ''}${p.ask ? `  ask about: ${p.ask}` : ''}${p.language ? `  · ${p.language}` : ''}${p.git ? `  · git "${p.git}"` : ''}`);
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
