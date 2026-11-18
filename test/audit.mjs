#!/usr/bin/env node
/**
 * test/audit.mjs — the maintainer's release check for the TEMPLATE (npm run audit). Free: it never calls an AI tool.
 * It does, as a new user would: install into an empty project, run every command, and checks the template's own rules.
 *
 *   npm run audit            all checks; exit 1 if any FAIL
 *   npm run audit -- --site  also build the website (needs: cd website && npm ci)
 *   npm run audit -- --foundry <path/to/Skill-Foundry/src/factory/foundry.mjs>
 *                            also the live dual-order check against a real Skill Foundry checkout (no network)
 *
 * Checks: fresh install works and records the core fingerprints; personal files never travel (approvals.json);
 * the core is read-only for Claude Code in a project; every command answers --help; doctor on a fresh project has
 * 0 failures; every command, npm script and link the docs mention exists; no model names in docs, site or code
 * comments (they belong in .harness/config.json only); no personal account details; "verified" engines say how.
 * See docs/MAINTAINING.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDoc } from './lib/docs-drift.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`  ${ok ? '✔' : '✖'} ${name}${ok || !detail ? '' : `\n      ${String(detail).split('\n').join('\n      ')}`}`); };
const run = (args, cwd, extra = {}) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, HARNESS_SILENT: '1', HARNESS_OFFLINE: '1', ...extra } });
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (['node_modules', '.git', 'dist', 'worktrees', 'demo-project'].includes(e.name)) continue; const p = path.join(dir, e.name); e.isDirectory() ? walk(p, out) : out.push(p); } return out; };

console.log('Agentic Harness — template audit\n');

// 1. A new user's install
console.log('Fresh install into an empty project');
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-audit-'));
spawnSync('git', ['init', '-q'], { cwd: proj }); spawnSync('git', ['-c', 'user.name=audit', '-c', 'user.email=audit@local', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: proj });
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'audit-project', private: true, scripts: { test: 'node --test' } }));
const inst = run([path.join(REPO, 'install.mjs'), proj], REPO, { HARNESS_ENGINES: '' });
check('install.mjs exits 0', inst.status === 0, inst.stderr || inst.stdout.slice(-400));
const manifest = (() => { try { return JSON.parse(fs.readFileSync(path.join(proj, '.harness', 'MANIFEST.json'), 'utf8')); } catch { return null; } })();
check('MANIFEST.json records the core fingerprints', !!manifest && Object.keys(manifest.files || {}).length > 5, 'missing or empty');
check('personal approvals.json is never copied into a project', !fs.existsSync(path.join(proj, '.harness', 'approvals.json')));
const deny = (() => { try { return JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.json'), 'utf8')).permissions.deny || []; } catch { return []; } })();
check('the core is read-only for Claude Code in a project (valid Edit(...) rules only)', ['Edit(.harness/*.mjs)', 'Edit(.harness/lib/**)'].every((r) => deny.includes(r)) && !deny.some((r) => r.startsWith("Write(")), deny.join(', '));
const tplDeny = JSON.parse(read('.claude/settings.json')).permissions.deny || [];
check('the template itself stays editable for maintainers', !tplDeny.includes('Edit(.harness/*.mjs)'));

// 2. Every command a user can run
console.log('\nEvery command answers --help (and never starts work)');
const cmds = fs.readdirSync(path.join(proj, '.harness')).filter((f) => f.endsWith('.mjs') && f !== 'sdk.mjs');
const badHelp = cmds.filter((c) => { const r = run([path.join('.harness', c), '--help'], proj); return r.status !== 0 || !r.stdout.includes(c); });
check(`${cmds.length} commands answer --help with exit 0`, !badHelp.length, `failing: ${badHelp.join(', ')}`);
const doc = run(['.harness/doctor.mjs'], proj, { HARNESS_ENGINES: '' });
const fails = (doc.stdout.match(/Failures: (\d+)/) || [])[1];
check('doctor on a fresh project: 0 failures', fails === '0' || /No AI tool is allowed yet|No AI engine/.test(doc.stdout) && !/✖(?!.*AI engine)/.test(doc.stdout.replace(/✖.*(no AI engine|No AI engine).*/g, '')), doc.stdout.split('\n').filter((l) => /✖|Failures/.test(l)).join('\n'));
check('doctor sees an unchanged core', /unchanged since install/.test(doc.stdout), doc.stdout.split('\n').filter((l) => /core/i.test(l)).join('\n'));
const hook = run(['.harness/hook-session.mjs'], proj);
check('session hook tells AIs to use, not edit, the harness', /never edit \.harness\/\*\.mjs/.test(hook.stdout), hook.stdout.slice(0, 300));

// 3. Docs point only at things that exist
console.log('\nDocs only mention commands, scripts and files that exist');
const pkg = JSON.parse(read('package.json'));
const slashNames = fs.readdirSync(path.join(REPO, '.claude', 'commands', 'harness')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
const roleNames = fs.readdirSync(path.join(REPO, '.harness', 'roles')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(read(`.harness/roles/${f}`)).name);
const team = JSON.parse(read('.harness/team.json'));
const leadIds = team.members.filter((m) => m.level === 'lead').map((m) => m.id);
const skillNames = fs.existsSync(path.join(REPO, '.harness', 'skills'))
  ? fs.readdirSync(path.join(REPO, '.harness', 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(REPO, '.harness', 'skills', e.name, 'SKILL.md'))).map((e) => e.name)
  : [];
const charterAllowed = ((read('.harness/charter.md').match(/^\s*-\s*allowedPaths:\s*(.+)$/mi) || [])[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
const listTs = (d) => fs.existsSync(path.join(REPO, d)) ? fs.readdirSync(path.join(REPO, d)).filter((f) => /\.tsx?$/.test(f)).map((f) => `${d}/${f}`) : [];
const siteFiles = ['website/src/data/i18n.ts', 'website/src/site.ts', ...listTs('website/src/components'), ...listTs('website/src/lib')].filter((f) => fs.existsSync(path.join(REPO, f)));
const docFiles = ['README.md', 'AGENTS.md', ...fs.readdirSync(path.join(REPO, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`), ...slashNames.map((n) => `.claude/commands/harness/${n}.md`)];
const broken = [];
for (const f of docFiles) {
  const t = read(f);
  for (const m of t.matchAll(/node (\.harness\/[\w/.-]+\.mjs|install\.mjs|examples\/[\w.-]+\.mjs|test\/[\w.-]+\.mjs)/g)) if (!fs.existsSync(path.join(REPO, m[1]))) broken.push(`${f}: ${m[1]}`);
  for (const m of t.matchAll(/npm run ([\w:-]+)/g)) if (!pkg.scripts[m[1]] && !f.startsWith('docs/MAINTAINING')) broken.push(`${f}: npm run ${m[1]}`);
  for (const m of t.matchAll(/\]\(((?!https?:|mailto:)[^)#\s]+)(#[^)]*)?\)/g)) if (!fs.existsSync(path.join(path.dirname(path.join(REPO, f)), m[1]))) broken.push(`${f}: link ${m[1]}`);
}
for (const wf of ['website/src/components/CommandReference.tsx', 'website/src/components/UseCasePlaybooks.tsx']) {
  const wt = read(wf);
  for (const m of wt.matchAll(/node (\.harness\/[\w/.-]+\.mjs)/g)) if (!fs.existsSync(path.join(REPO, m[1]))) broken.push(`${wf}: ${m[1]}`);
}
check('no broken command, script or link in the docs or website', !broken.length, broken.join('\n'));
{
  const cmdRef = read('website/src/components/CommandReference.tsx');
  const i18nSrc = read('website/src/data/i18n.ts');
  const i18nErrs = [];
  const cmdKeys = [...cmdRef.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);
  const seenCmdKeys = new Set();
  for (const k of cmdKeys) {
    if (seenCmdKeys.has(k)) i18nErrs.push(`CommandReference.tsx: duplicate key "${k}"`);
    seenCmdKeys.add(k);
  }
  let dicts = null;
  try {
    const enMatch = i18nSrc.match(/\nconst en = (\{[\s\S]*?\n\});\s*\nexport type Dict/);
    const khMatch = i18nSrc.match(/\nconst kh: Dict = (\{[\s\S]*?\n\});\s*\nexport const DICTS/);
    if (!enMatch || !khMatch) throw new Error('could not locate en/kh dictionary blocks');
    dicts = new Function(`const en = ${enMatch[1]}; const kh = ${khMatch[1]}; return { en, kh };`)();
  } catch (e) {
    i18nErrs.push(`failed to parse i18n.ts dictionaries: ${e.message}`);
  }
  if (dicts) {
    const cmpShape = (a, b, p) => {
      if (typeof a !== typeof b) { i18nErrs.push(`${p}: type ${typeof a} vs ${typeof b}`); return; }
      if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) { i18nErrs.push(`${p}: array vs non-array`); return; }
        if (a.length !== b.length) i18nErrs.push(`${p}: length ${a.length} vs ${b.length}`);
        for (let i = 0; i < Math.min(a.length, b.length); i++) cmpShape(a[i], b[i], `${p}[${i}]`);
        return;
      }
      if (a && typeof a === 'object') {
        const ka = Object.keys(a), kb = new Set(Object.keys(b));
        for (const k of ka) if (!kb.has(k)) i18nErrs.push(`kh.${p ? p + '.' : ''}${k} missing`);
        for (const k of kb) if (!(k in a)) i18nErrs.push(`en.${p ? p + '.' : ''}${k} missing`);
        for (const k of ka) if (k in b) cmpShape(a[k], b[k], p ? `${p}.${k}` : k);
      }
    };
    cmpShape(dicts.en, dicts.kh, '');
    const enCmdKeys = new Set(Object.keys(dicts.en.cmd?.items || {}));
    const khCmdKeys = new Set(Object.keys(dicts.kh.cmd?.items || {}));
    for (const k of seenCmdKeys) {
      if (!enCmdKeys.has(k)) i18nErrs.push(`en.cmd.items missing CommandReference key "${k}"`);
      if (!khCmdKeys.has(k)) i18nErrs.push(`kh.cmd.items missing CommandReference key "${k}"`);
    }
    const enRows = (dicts.en.task?.rows || []).map((r) => r.cmd);
    const khRows = (dicts.kh.task?.rows || []).map((r) => r.cmd);
    if (enRows.join('|') !== khRows.join('|')) i18nErrs.push(`task.rows mismatch: en=[${enRows.join(',')}] vs kh=[${khRows.join(',')}]`);

    // UI component counts & source-of-truth parity (catches adding/removing rows in only one file)
    const sectionsSrc = read('website/src/components/Sections.tsx');
    const dutyMatch = sectionsSrc.match(/const DUTY_TAGS\s*=\s*(\[[^\]]+\])/);
    if (!dutyMatch) i18nErrs.push('Sections.tsx: DUTY_TAGS missing');
    else {
      const tags = new Function(`return ${dutyMatch[1]}`)();
      if (tags.length !== dicts.en.controller.rows.length) i18nErrs.push(`Sections DUTY_TAGS (${tags.length}) != en.controller.rows (${dicts.en.controller.rows.length})`);
    }
    const rtSimSrc = read('website/src/components/RoutingSimulator.tsx');
    const rtMatch = rtSimSrc.match(/const ROWS[^=]*=\s*(\[[\s\S]*?\n\]);/);
    if (!rtMatch) i18nErrs.push('RoutingSimulator.tsx: ROWS missing');
    else {
      const rowCount = (rtMatch[1].match(/\{\s*who:\s*'/g) || []).length;
      if (rowCount !== dicts.en.models.rows.length) i18nErrs.push(`RoutingSimulator ROWS (${rowCount}) != en.models.rows (${dicts.en.models.rows.length})`);
      for (const l of leadIds) if (!new RegExp(`who:\\s*'${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(rtMatch[1])) i18nErrs.push(`RoutingSimulator ROWS missing lead ${l}`);
    }
    const ucSrc = read('website/src/components/UseCasePlaybooks.tsx');
    const ucMatch = ucSrc.match(/const COMMANDS[^=]*=\s*(\{[\s\S]*?\n\});/);
    if (!ucMatch) i18nErrs.push('UseCasePlaybooks.tsx: COMMANDS missing');
    else {
      const cmdsObj = new Function(`const REPO_URL = '', INSTALL_CMD = ''; return ${ucMatch[1]}`)();
      for (const tab of Object.keys(dicts.en.setup.tabs)) {
        if (!Array.isArray(cmdsObj[tab])) i18nErrs.push(`UseCasePlaybooks COMMANDS missing tab "${tab}"`);
        else if (cmdsObj[tab].length !== dicts.en.setup[tab].length) i18nErrs.push(`UseCasePlaybooks COMMANDS.${tab} (${cmdsObj[tab].length}) != en.setup.${tab} (${dicts.en.setup[tab].length})`);
      }
    }
    const figSrc = read('website/src/components/Figures.tsx');
    const figMatch = figSrc.match(/export const FIGURES\s*=\s*\[([^\]]+)\]/);
    const figLen = figMatch ? figMatch[1].split(',').map((s) => s.trim()).filter(Boolean).length : 0;
    if (figLen !== dicts.en.hero.figures.length || figLen !== dicts.en.flow.steps.length) {
      i18nErrs.push(`Figures.tsx FIGURES (${figLen}) must match hero.figures (${dicts.en.hero.figures.length}) and flow.steps (${dicts.en.flow.steps.length})`);
    }
    const routingSrc = read('website/src/lib/routing.ts');
    const roleTypeMatch = routingSrc.match(/export type Role\s*=\s*([^;]+);/);
    const roleJobMatch = routingSrc.match(/export const ROLE_JOB[^=]*=\s*\{([^}]+)\}/);
    const uiRoles = new Set([...(roleTypeMatch?.[1] || '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
    const jobRoles = new Set([...(roleJobMatch?.[1] || '').matchAll(/\b([A-Z_]+)\s*:/g)].map((m) => m[1]));
    for (const r of roleNames) {
      if (!uiRoles.has(r)) i18nErrs.push(`website/src/lib/routing.ts Role union missing ${r}`);
      if (!jobRoles.has(r)) i18nErrs.push(`website/src/lib/routing.ts ROLE_JOB missing ${r}`);
    }
    const missingSlash = [];
    const cmdRefSlash = new Set([...cmdRef.matchAll(/cmd:\s*'(\/harness:[a-z-]+)/g)].map((m) => m[1]));
    const enTaskSlash = new Set(enRows);
    const khTaskSlash = new Set(khRows);
    for (const s of slashNames) {
      const cmd = `/harness:${s}`;
      for (const f of ['README.md', 'AGENTS.md', 'docs/WORKFLOW.md', 'docs/WORKFLOW.km.md']) if (!read(f).includes(cmd)) missingSlash.push(`${f} missing ${cmd}`);
      if (!cmdRefSlash.has(cmd)) missingSlash.push(`CommandReference.tsx missing ${cmd}`);
      if (!enTaskSlash.has(cmd)) missingSlash.push(`i18n.ts en.task.rows missing ${cmd}`);
      if (!khTaskSlash.has(cmd)) missingSlash.push(`i18n.ts kh.task.rows missing ${cmd}`);
    }
    if (missingSlash.length) i18nErrs.push(...missingSlash);
  }
  check('website i18n (en/kh), UI component counts, roles, and /harness:* slash command docs are in parity', !i18nErrs.length, i18nErrs.join('; '));
}

// 4. Owner rules for the repository
console.log('\nRepository rules');
const cfg = JSON.parse(read('.harness/config.json'));
const names = new Set();
for (const p of Object.values(cfg.profiles)) for (const m of Object.values(p.models || {})) if (m) names.add(String(m).split('@')[0]);
for (const f of Object.values(cfg.quotaFallback || {})) for (const m of Object.values(f.models || {})) if (m) names.add(String(m).split('@')[0]);
const scan = walk(REPO).map((f) => path.relative(REPO, f).split(path.sep).join('/'))
  .filter((f) => /\.(md|mjs|ts|tsx|json)$/.test(f) && !/^(\.harness\/config\.json|test\/|\.claude\/agents\/|website\/package|package-lock|\.harness\/(backlog|engine-probe|MANIFEST|state|approvals)\.json|\.harness\/(memory|releases|inbox|completed|failed|visible)\/)/.test(f));
const hits = [];
for (const f of scan) { const t = fs.readFileSync(path.join(REPO, f), 'utf8'); for (const n of names) if (new RegExp(`(^|[^\\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(t)) hits.push(`${f}: ${n}`); }
check('model names appear only in .harness/config.json (and generated agent files)', !hits.length, hits.slice(0, 15).join('\n'));
const foundryLeaks = [...docFiles, ...siteFiles].filter((f) => /Skill[\s.-]?Foundry/i.test(read(f)));
check('user docs and website do not advertise Skill Foundry yet', !foundryLeaks.length, foundryLeaks.join(', '));
const personal = scan.filter((f) => /[\w.+-]+@(gmail|yahoo|outlook|hotmail)\.com|try again at \w+ \d|test account hit/i.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
check('no personal account details (emails, quota dates)', !personal.length, personal.join('\n'));
const unproven = Object.entries(cfg.profiles).filter(([, p]) => p.verified === true && !/verif|tested|passed/i.test(String(p.note || ''))).map(([k]) => k);
check('every "verified": true engine says how it was verified', !unproven.length, `no evidence in the note: ${unproven.join(', ')}`);
check('package.json has a version (recorded in each install)', /^\d+\.\d+\.\d+/.test(pkg.version || ''), pkg.version);
check('zero dependencies (Node standard library only)', !pkg.dependencies && !pkg.devDependencies);
const giCopy = (read('install.mjs').match(/^const GITIGNORE_BLOCK = (".*");$/m) || [])[1];
const toMain = [...docFiles, 'website/src/site.ts', 'website/src/components/UseCasePlaybooks.tsx', 'website/src/components/CommandReference.tsx', '.harness/doctor.mjs']
  .filter((f) => /github:sumtaimo\/Agentic-Harness(?!#release)/.test(read(f)));
check('every install command points at the tested template (#release), not the lab', !toMain.length, toMain.join(', '));
const staleMain = [...docFiles, 'website/src/data/i18n.ts']
  .filter((f) => /main is the lab|from main\b|ពី main\b/.test(read(f)));
check('no stale "main is the lab" or "from main" instructions in docs or website copy', !staleMain.length, staleMain.join(', '));
check('the landing page deploys from the release branch', /branches: \[release\]/.test(read('.github/workflows/deploy-website.yml')));
check('installer copy of .gitignore matches .gitignore', !!giCopy && JSON.parse(giCopy) === read('.gitignore'));
{
  const tasksCfg = (() => { try { return JSON.parse(read('.vscode/tasks.json')); } catch { return null; } })();
  const inputIds = new Set((tasksCfg?.inputs || []).map((i) => i.id));
  const seenLabels = new Set();
  const badTasks = !tasksCfg || !Array.isArray(tasksCfg.tasks) ? ['invalid JSON'] : tasksCfg.tasks.flatMap((t) => {
    const errs = [];
    if (!t.label) errs.push('task missing label');
    else if (seenLabels.has(t.label)) errs.push(`duplicate label "${t.label}"`);
    else seenLabels.add(t.label);
    const cmdStr = `${t.command || ''} ${(t.args || []).join(' ')}`;
    for (const m of cmdStr.matchAll(/(\.harness\/[a-z-]+\.mjs)/g)) if (!fs.existsSync(path.join(REPO, m[1]))) errs.push(`${t.label}: missing ${m[1]}`);
    for (const m of cmdStr.matchAll(/\$\{input:([\w-]+)\}/g)) if (!inputIds.has(m[1])) errs.push(`${t.label}: missing input "${m[1]}"`);
    return errs;
  });
  check('VS Code tasks (.vscode/tasks.json) are valid JSON with unique labels, real scripts, and inputs', !badTasks.length, badTasks.join('; '));
}

// 4b. Docs state the truth: facts in the docs and website copy are compared with the source of truth
console.log('\nDocs match the source of truth');
{
  const facts = {
    leads: leadIds,
    roles: roleNames,
    skills: skillNames,
    allowedPaths: charterAllowed,
    version: pkg.version,
    agentCount: fs.readdirSync(path.join(REPO, '.claude', 'agents')).filter((f) => f.endsWith('.md')).length,
  };
  const driftFiles = [...docFiles, ...siteFiles];
  const drift = [];
  for (const f of driftFiles) {
    const testCounts = f === 'README.md' || f.startsWith('website/');
    for (const d of checkDoc(read(f), facts, { testCounts })) drift.push(`${f}:${d.line}: [${d.rule}] ${d.msg}`);
  }
  check(`docs, README and website copy agree with team.json (${facts.leads.length} leads), roles (${facts.roles.length}), skills (${facts.skills.length}), charter, and package.json ${facts.version}`, !drift.length, drift.join('\n'));
}
// 5. Website (optional)
if (process.argv.includes('--site')) {
  console.log('\nWebsite');
  const site = path.join(REPO, 'website');
  if (!fs.existsSync(path.join(site, 'node_modules'))) check('website build', false, 'run: cd website && npm ci');
  else { const b = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: site, encoding: 'utf8', shell: process.platform === 'win32' }); check('website builds (typecheck + bundle)', b.status === 0, (b.stdout + b.stderr).slice(-600)); }
}

// 6. Skill Foundry dual-order integration (optional, a real local checkout of github:sumtaimo/Skill-Foundry)
{
  const i = process.argv.indexOf('--foundry');
  if (i > -1) {
    const cli = path.resolve(String(process.argv[i + 1] || ''));
    console.log('\nSkill Foundry dual-order integration');
    if (!fs.existsSync(cli)) check('Skill Foundry CLI found', false, cli);
    else {
      const verify = (p, label) => {
        const doc = run(['.harness/doctor.mjs'], p, { HARNESS_ROOT: p, HARNESS_ENGINES: '' });
        check(`${label}: doctor has no Skill Foundry wiring problem`, !/has no pointer|not the foundry pointer|pointer is for|not valid JSON/.test(doc.stdout), doc.stdout.split('\n').filter((l) => /Skill Foundry/.test(l)).join('\n'));
        check(`${label}: team.mjs validate`, run(['.harness/team.mjs', 'validate'], p, { HARNESS_ROOT: p }).status === 0);
        const fd = run([cli, 'doctor', '--json'], p);
        let rep = null; try { rep = JSON.parse(fd.stdout); } catch { /* reported below */ }
        check(`${label}: Skill Foundry doctor reports 0 problems`, rep && rep.counts.problem === 0, fd.stdout.slice(-600));
        const deny = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8')).permissions.deny || [];
        check(`${label}: no invalid Write(...) rules`, !deny.some((r) => r.startsWith('Write(')), deny.filter((r) => r.startsWith('Write(')).join(', '));
        check(`${label}: AGENTS.md has the harness section once`, (fs.readFileSync(path.join(p, 'AGENTS.md'), 'utf8').match(/This project contains an \*\*Agentic Harness\*\*/g) || []).length === 1);
        const stamps = fs.readdirSync(path.join(p, '.claude', 'skills')).filter((n) => fs.existsSync(path.join(p, '.claude', 'skills', n, '.foundry.json')));
        check(`${label}: every Skill Foundry skill has its harness pointer`, stamps.length > 0 && stamps.every((n) => /installed-by: skill-foundry/.test((() => { try { return fs.readFileSync(path.join(p, '.harness', 'skills', n, 'SKILL.md'), 'utf8'); } catch { return ''; } })())), stamps.join(', '));
      };
      const one = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sf1-'));
      spawnSync('git', ['init', '-q'], { cwd: one });
      run([path.join(REPO, 'install.mjs'), one, '--no-auto-assign', '--with-skills'], REPO, { HARNESS_FOUNDRY_CMD: cli, HARNESS_ENGINES: '' });
      verify(one, 'order 1 (harness, then --with-skills)');
      const two = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sf2-'));
      spawnSync('git', ['init', '-q'], { cwd: two });
      run([cli, 'add', '--all', '--quiet'], two);
      run([path.join(REPO, 'install.mjs'), two, '--no-auto-assign'], REPO, { HARNESS_ENGINES: '' });
      run([cli, 'update', '--quiet'], two);
      run([path.join(REPO, 'install.mjs'), two, '--no-auto-assign'], REPO, { HARNESS_ENGINES: '' });
      verify(two, 'order 2 (Skill Foundry, then harness, then update)');
      for (const d of [one, two]) fs.rmSync(d, { recursive: true, force: true });
    }
  }
}

fs.rmSync(proj, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed${failed.length ? ' — fix these before releasing (docs/MAINTAINING.md)' : ''}`);
process.exit(failed.length ? 1 : 0);
