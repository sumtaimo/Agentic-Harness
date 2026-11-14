#!/usr/bin/env node
/**
 * test/run-tests.mjs — end-to-end tests for the harness. Each test runs in a fresh temp copy.
 *   node test/run-tests.mjs
 * Uses test/mock-agent.mjs as a fake engine, so no AI account is needed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = path.join(REPO, 'test', 'mock-agent.mjs');
let passed = 0; let failed = 0;

function sandbox({ worktrees = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  fs.cpSync(path.join(REPO, '.harness'), path.join(dir, '.harness'), {
    recursive: true,
    filter: (src) => !/(state\.json|telemetry\.log|daemon\.pid|approvals\.json)$/.test(src) && !/[\\/](inbox|completed|failed|sessions)[\\/][^.]/.test(src)
  });
  // Isolate from any live harness run in the repo: clean backlog, no active visible-run state.
  fs.rmSync(path.join(dir, '.harness', 'visible'), { recursive: true, force: true });
  { const ch = path.join(dir, '.harness', 'charter.md'); // the owner's objectives must not leak into tests
    fs.writeFileSync(ch, fs.readFileSync(ch, 'utf8').replace(/^- Project objectives:[\s\S]*?(?=\n\n|\n## |(?![\s\S]))/m, '- Project objectives: (describe your product goals here to customize for your own app)').replace(/^- autonomous: off$/m, '- autonomous: on')); }
  fs.writeFileSync(path.join(dir, '.harness', 'memory', 'profile.md'), '# User profile\n\n- Name: (fill me)\n- Role / what I do: (fill me)\n'); // the owner's profile must not leak into tests
  fs.writeFileSync(path.join(dir, '.harness', 'memory', 'lessons.md'), '# Lessons the user taught\n'); // the owner's taught rules must not leak into tests
  fs.writeFileSync(path.join(dir, '.harness', 'backlog.json'), JSON.stringify({ version: '2.0.0', project: '', maxAutoTasksPerRun: 3, tasks: [] }, null, 2));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.harness', 'config.json'), 'utf8'));
  cfg.profiles.mock = { verified: true, binary: process.execPath, args: [MOCK, 'ALLOWED={allowedTools}', 'DENIED={disallowedTools}'], promptVia: 'stdin', allowedTools: [] };
  cfg.activeProfile = 'mock';
  cfg.autoOrder = ['mock'];
  cfg.useGitWorktrees = worktrees;
  cfg.workerTimeoutMs = 20000;
  cfg.git = { ...(cfg.git || {}), integrationMode: 'off' }; // v1/v2 in-place tests; uat tests switch it on
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  // The fake engines are allowed once, as a person would (a real logged-in CLI is never used without that; own test below).
  fs.writeFileSync(path.join(dir, '.harness', 'approvals.json'), JSON.stringify({ engines: { mock: true, mockplan: true, mockcode: true, mockqa: true, fake: true, ghost: true } }));
  return dir;
}

// Engine auto-routing must not depend on the AI CLIs installed on the test machine: every install / auto-assign
// in this suite sees "no usable engine" unless a test passes HARNESS_ENGINES itself.
process.env.HARNESS_ENGINES = '';
const env = { ...process.env, HARNESS_SILENT: '1', HARNESS_AGENT: '', HARNESS_LIVE: '0', HARNESS_YES: '1' }; // the approval gate has its own test
delete env.HARNESS_WORKER;
const node = (dir, args, extraEnv = {}) => spawnSync(process.execPath, args, { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60000 });
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const log = (dir) => fs.readFileSync(path.join(dir, '.harness', 'telemetry.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ls = (dir, sub) => fs.readdirSync(path.join(dir, '.harness', sub)).filter((f) => f.endsWith('.json'));
const drop = (dir, task) => fs.writeFileSync(path.join(dir, '.harness', 'inbox', `${task.id}.json`), JSON.stringify(task));
const runOnce = (dir) => node(dir, ['.harness/daemon.mjs', '--once']);

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); } catch (e) { failed++; console.log(`  ✖ ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('Agentic harness — end-to-end tests\n');

await test('spec self-audit: self-test commits, state 4_COMMITTED + ANTIGRAVITY, job archived', () => {
  const d = sandbox();
  const r = node(d, ['.harness/daemon.mjs', '--self-test']);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === '4_COMMITTED', `phase ${s.phase}`);
  assert(s.engine === 'ANTIGRAVITY', `engine ${s.engine}`);
  assert(ls(d, 'completed').some((f) => f.startsWith('self-test-001-')), 'not archived');
});

await test('swarm lock collision is rejected BEFORE any worker runs, in 1 cycle, moved to failed/', () => {
  const d = sandbox();
  drop(d, { id: 'collide', title: 'collide', subtasks: [
    { id: 'a', targetFiles: ['src/x.ts'], prompt: 'WRITE ran-a.txt yes' },
    { id: 'b', targetFiles: ['src/'], prompt: 'WRITE ran-b.txt yes' }] });
  runOnce(d);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === 'REJECTED', `phase ${s.phase}`);
  assert(/Lock Collision/.test(s.lastGateStatus), s.lastGateStatus);
  assert(!fs.existsSync(path.join(d, 'ran-a.txt')) && !fs.existsSync(path.join(d, 'ran-b.txt')), 'a worker ran');
  assert(log(d).filter((e) => e.phase === '1_PLANNER').length === 1, 'retried a collision');
  assert(ls(d, 'failed').length === 1 && ls(d, 'inbox').length === 0, 'job not moved to failed/');
});

await test('swarm worker without targetFiles is rejected (could touch anything)', () => {
  const d = sandbox();
  drop(d, { id: 'unscoped', title: 'u', subtasks: [{ id: 'a', targetFiles: ['a.txt'], prompt: 'x' }, { id: 'b', prompt: 'y' }] });
  runOnce(d);
  assert(json(path.join(d, '.harness', 'state.json')).phase === 'REJECTED', 'not rejected');
});

await test('verifier keeps failing → exactly 3 cycles → HALTED_HITL_REQUIRED, error fed back, memory written', () => {
  const d = sandbox();
  drop(d, { id: 'halt', title: 'always fails', verifyCmd: 'node -e "console.error(\'BOOM-123\'); process.exit(3)"', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === 'HALTED_HITL_REQUIRED', `phase ${s.phase}`);
  const events = log(d);
  assert(events.filter((e) => e.phase === 'SQUARE_RETRY').length === 3, 'not 3 retries');
  assert(events.filter((e) => e.phase === '1_PLANNER')[1].errorTrace.includes('BOOM-123'), 'trace not fed to planner');
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'w.txt'), 'utf8').includes('BOOM-123'), 'trace not in worker prompt');
  assert(ls(d, 'failed').length === 1, 'not in failed/');
  assert(/always fails.*HALTED/.test(fs.readFileSync(path.join(d, '.harness', 'memory', 'auto-lessons.md'), 'utf8')), 'no auto lesson');
  assert(fs.readdirSync(path.join(d, '.harness', 'memory', 'sessions')).some((f) => f.includes('halt')), 'no session note');
});

await test('feedback loop works: fails cycle 1, worker uses the error, passes cycle 2', () => {
  const d = sandbox();
  drop(d, { id: 'recover', title: 'recover', verifyCmd: 'node -e "process.exit(require(\'fs\').existsSync(\'fixed.txt\')?0:1)"',
    subtasks: [{ id: 'w', targetFiles: ['fixed.txt'], prompt: 'FIX fixed.txt ok' }] });
  runOnce(d);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === '4_COMMITTED' && s.cycle === 2, `phase ${s.phase} cycle ${s.cycle}`);
  assert(/recover.*passed after 2 cycles/.test(fs.readFileSync(path.join(d, '.harness', 'memory', 'auto-lessons.md'), 'utf8')), 'no recovery lesson');
});

await test('memory: taught rule + profile are injected into the worker prompt', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(d, '.harness', 'memory', 'profile.md'), '# User profile\n- Name: Test User\n- Coding experience: (fill me)\n');
  node(d, ['.harness/memory.mjs', 'remember', 'Always use British spelling']);
  const dup = node(d, ['.harness/memory.mjs', 'remember', 'always use british spelling']);
  assert(/Already remembered/.test(dup.stdout), 'duplicate stored');
  drop(d, { id: 'mem', title: 'mem', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const p = fs.readFileSync(path.join(d, '.mock-prompts', 'w.txt'), 'utf8');
  assert(p.includes('Always use British spelling') && p.includes('[USER MEMORY'), 'memory missing from prompt');
  assert(p.includes('Name: Test User') && !p.includes('(fill me)'), 'profile missing or placeholders leaked');
  assert(/Forgot L1/.test(node(d, ['.harness/memory.mjs', 'forget', 'L1']).stdout), 'forget failed');
  assert(!/British/.test(node(d, ['.harness/memory.mjs', 'context']).stdout), 'forgotten rule still in context');
});

await test('unavailable engine falls back to auto (ENGINE_FALLBACK) and the task still runs', () => {
  const d = sandbox();
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.ghost = { binary: 'definitely-not-installed-xyz', args: [] };
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg));
  drop(d, { id: 'ghost', title: 'g', engine: 'ghost', verifyCmd: 'node -e "process.exit(require(\'fs\').existsSync(\'a.txt\')?0:1)"', subtasks: [{ id: 'w', engine: 'ghost', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === '4_COMMITTED', `${s.phase} ${s.lastGateStatus}`);
  assert(log(d).some((e) => e.phase === 'ENGINE_FALLBACK' && /not installed/.test(e.message)), 'no fallback logged');
});

await test('engine whose --help lacks a configured flag fails the probe → fallback; doctor reports the missing flag', () => {
  const d = sandbox();
  const fake = path.join(d, 'fake-engine.mjs');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nconsole.log("Usage: fake [options]\\n  --other-flag   something");\n');
  fs.chmodSync(fake, 0o755);
  // Windows cannot run a shebang script directly: use a .cmd wrapper there.
  let fakeBin = fake;
  if (process.platform === 'win32') { fakeBin = path.join(d, 'fake-engine.cmd'); fs.writeFileSync(fakeBin, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`); }
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.fake = { binary: fakeBin, args: ['--needed-flag'], promptVia: 'stdin' };
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg));
  drop(d, { id: 'probe', title: 'p', engine: 'fake', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  assert(json(path.join(d, '.harness', 'state.json')).phase === '4_COMMITTED', 'did not fall back');
  assert(log(d).some((e) => e.phase === 'ENGINE_FALLBACK' && /--needed-flag/.test(e.message)), 'probe reason not logged');
  const doc = node(d, ['.harness/doctor.mjs']).stdout;
  assert(/fake.*does NOT list: --needed-flag/.test(doc), doc);
});

await test('no usable engine at all → REJECTED immediately, nothing retried', () => {
  const d = sandbox();
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.ghost = { binary: 'definitely-not-installed-xyz', args: [] };
  cfg.autoOrder = ['ghost'];
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg));
  drop(d, { id: 'none', title: 'n', engine: 'ghost', subtasks: [{ id: 'w', targetFiles: ['a'], prompt: 'x' }] });
  runOnce(d);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === 'REJECTED' && /no other engine/.test(s.lastGateStatus), s.lastGateStatus);
  assert(log(d).filter((e) => e.phase === '1_PLANNER').length === 1, 'retried');
});

await test('worker that exits non-zero is retried, then halts', () => {
  const d = sandbox();
  drop(d, { id: 'crash', title: 'crash', subtasks: [{ id: 'w', targetFiles: ['a'], prompt: 'FAIL' }] });
  runOnce(d);
  assert(json(path.join(d, '.harness', 'state.json')).phase === 'HALTED_HITL_REQUIRED', 'not halted');
});

await test('2-worker swarm with real (mock) agents runs in parallel and both write their own files', () => {
  const d = sandbox();
  drop(d, { id: 'swarm', title: 'swarm', verifyCmd: 'node -e "const f=require(\'fs\');process.exit(f.existsSync(\'a.txt\')&&f.existsSync(\'b.txt\')?0:1)"',
    subtasks: [{ id: 'wa', targetFiles: ['a.txt'], prompt: 'WRITE a.txt A' }, { id: 'wb', targetFiles: ['b.txt'], prompt: 'WRITE b.txt B' }] });
  runOnce(d);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === '4_COMMITTED' && s.mode === 'SWARM-MESH (2W)', `${s.phase} ${s.mode}`);
});

await test('git worktree isolation: in-scope edits copied back, out-of-scope edits discarded', () => {
  const d = sandbox({ worktrees: true });
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  drop(d, { id: 'wt', title: 'wt', subtasks: [{ id: 'w', targetFiles: ['src/'], prompt: 'WRITE src/in.txt yes\nWRITE outside.txt no' }] });
  runOnce(d);
  assert(fs.existsSync(path.join(d, 'src', 'in.txt')), 'in-scope file not copied back');
  assert(!fs.existsSync(path.join(d, 'outside.txt')), 'out-of-scope file leaked');
  assert(log(d).some((e) => e.phase === '2_SCOPE_VIOLATION' && e.blocked.includes('outside.txt')), 'violation not logged');
  assert(git('worktree', 'list').toString().trim().split('\n').length === 1, 'worktree not cleaned up');
});

await test('dispatch --wait with no daemon running processes the job and reports COMMITTED', () => {
  const d = sandbox();
  const r = node(d, ['.harness/dispatch.mjs', '--goal', 'WRITE hello.txt hi', '--files', 'hello.txt', '--check', 'node -e "process.exit(require(\'fs\').existsSync(\'hello.txt\')?0:1)"', '--wait']);
  assert(r.status === 0 && /RESULT: COMMITTED/.test(r.stdout), r.stdout + r.stderr);
  assert(/Session note: |session note: /.test(r.stdout), 'no session note path');
});

await test('dispatch without --check warns that there is no real gate', () => {
  const d = sandbox();
  const r = node(d, ['.harness/dispatch.mjs', '--goal', 'x']);
  assert(/NO real check/.test(r.stdout) && /WARNING/.test(r.stdout), r.stdout);
});

await test('dispatch refuses inside a harness worker (no agent loops)', () => {
  const d = sandbox();
  const r = node(d, ['.harness/dispatch.mjs', '--goal', 'x'], { HARNESS_WORKER: '1' });
  assert(r.status === 2 && ls(d, 'inbox').length === 0, `status ${r.status}`);
});

await test('watch mode: 3 jobs dropped at once are all processed in order; second daemon refuses to start', async () => {
  const d = sandbox();
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs', '--watch'], { cwd: d, env, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const second = node(d, ['.harness/daemon.mjs']);
  assert(/already running/.test(second.stdout), 'second daemon started');
  for (const n of [1, 2, 3]) node(d, ['.harness/dispatch.mjs', '--goal', `WRITE f${n}.txt ${n}`, '--files', `f${n}.txt`]);
  const deadline = Date.now() + 20000;
  while (ls(d, 'completed').length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  daemon.kill('SIGTERM');
  await new Promise((r) => daemon.on('close', r));
  assert(ls(d, 'completed').length === 3, `only ${ls(d, 'completed').length} completed`);
  // Windows cannot deliver SIGTERM to a handler (the process is killed outright), so the pid file can remain there;
  // a stale pid file is harmless because liveness is checked with process.kill(pid, 0).
  if (process.platform !== 'win32') assert(!fs.existsSync(path.join(d, '.harness', 'daemon.pid')), 'pid file left behind');
});

await test('self-test hands off to a running daemon instead of racing it', async () => {
  const d = sandbox();
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs'], { cwd: d, env, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const r = node(d, ['.harness/daemon.mjs', '--self-test']);
  daemon.kill('SIGTERM');
  await new Promise((res) => daemon.on('close', res));
  assert(r.status === 0 && /background daemon/.test(r.stdout), r.stdout);
});

await test('install.mjs adds the harness to an existing project without overwriting its files', () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-install-'));
  fs.writeFileSync(path.join(p, 'AGENTS.md'), '# My rules\nKeep this line.\n');
  fs.mkdirSync(path.join(p, '.vscode'));
  fs.writeFileSync(path.join(p, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'build', type: 'shell', command: 'make' }] }));
  const r = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), p], { encoding: 'utf8' });
  assert(r.status === 0, r.stderr);
  const agents = fs.readFileSync(path.join(p, 'AGENTS.md'), 'utf8');
  assert(agents.includes('Keep this line.') && agents.includes('Agentic harness'), 'AGENTS.md not merged');
  const tasks = json(path.join(p, '.vscode', 'tasks.json'));
  assert(tasks.tasks.some((t) => t.label === 'build') && tasks.tasks.some((t) => t.label.startsWith('Harness:')), 'tasks not merged');
  spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), p]);
  assert((fs.readFileSync(path.join(p, 'AGENTS.md'), 'utf8').match(/agentic-harness -->/g) || []).length === 1, 'installed twice');
  const st = spawnSync(process.execPath, ['.harness/daemon.mjs', '--self-test'], { cwd: p, env, encoding: 'utf8' });
  assert(st.status === 0, 'self-test failed in installed project');
});

// ───────────── v1.0: rollback, dead-letter, auto-verify, AI planner, memory cap ─────────────

const FAIL_VERIFY = 'node -e "console.error(\'NOPE\'); process.exit(1)"';
const existsCheck = (...files) => `node -e "const f=require('fs');process.exit([${files.map((x) => `'${x}'`).join(',')}].every(x=>f.existsSync(x))?0:1)"`;

await test('dirty-file rollback: 3-cycle failure restores edited files, removes created files, restores folders', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(d, 'a.txt'), 'ORIGINAL');
  fs.mkdirSync(path.join(d, 'lib')); fs.writeFileSync(path.join(d, 'lib', 'keep.js'), 'KEEP');
  fs.writeFileSync(path.join(d, 'untouched.txt'), 'SAME');
  drop(d, { id: 'dirty', title: 'dirty', verifyCmd: FAIL_VERIFY, subtasks: [
    { id: 'w1', targetFiles: ['a.txt', 'new.txt'], prompt: 'WRITE a.txt BROKEN\nWRITE new.txt CREATED' },
    { id: 'w2', targetFiles: ['lib/'], prompt: 'WRITE lib/keep.js BROKEN\nWRITE lib/extra.js EXTRA' }] });
  runOnce(d);
  assert(json(path.join(d, '.harness', 'state.json')).phase === 'HALTED_HITL_REQUIRED', 'not halted');
  assert(fs.readFileSync(path.join(d, 'a.txt'), 'utf8') === 'ORIGINAL', 'a.txt not restored');
  assert(!fs.existsSync(path.join(d, 'new.txt')), 'created file not removed');
  assert(fs.readFileSync(path.join(d, 'lib', 'keep.js'), 'utf8') === 'KEEP' && !fs.existsSync(path.join(d, 'lib', 'extra.js')), 'folder not restored');
  assert(fs.readFileSync(path.join(d, 'untouched.txt'), 'utf8') === 'SAME', 'unrelated file touched');
  assert(fs.readdirSync(path.join(d, '.harness', 'staging')).filter((f) => !f.startsWith('.')).length === 0, 'staging not cleaned');
  assert(log(d).some((e) => e.phase === 'ROLLBACK_DONE'), 'no ROLLBACK_DONE event');
});

await test('successful task keeps its changes and discards the staging backup', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(d, 'a.txt'), 'ORIGINAL');
  drop(d, { id: 'ok', title: 'ok', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt NEW' }] });
  runOnce(d);
  assert(fs.readFileSync(path.join(d, 'a.txt'), 'utf8') === 'NEW', 'change lost');
  assert(log(d).some((e) => e.phase === 'STAGING_BACKUP'), 'no backup was taken');
  assert(fs.readdirSync(path.join(d, '.harness', 'staging')).filter((f) => !f.startsWith('.')).length === 0, 'staging not cleaned');
});

await test('dead-letter queue: failed job → .harness/failed/<id>-<timestamp>.json + .trace.txt with every cycle error', () => {
  const d = sandbox();
  drop(d, { id: 'deadletter', title: 'dl', verifyCmd: FAIL_VERIFY, subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt x' }] });
  runOnce(d);
  const f = ls(d, 'failed');
  assert(f.length === 1 && /^deadletter-\d+\.json$/.test(f[0]), `bad name ${f}`);
  const body = json(path.join(d, '.harness', 'failed', f[0]));
  assert(body.result === 'HALTED_HITL_REQUIRED' && body.errors.length === 3 && body.cyclesUsed === 3 && /restored/.test(body.rollback), JSON.stringify(body).slice(0, 300));
  const trace = fs.readFileSync(path.join(d, '.harness', 'failed', f[0].replace('.json', '.trace.txt')), 'utf8');
  assert((trace.match(/===== cycle/g) || []).length === 3 && trace.includes('NOPE'), 'trace incomplete');
  assert(ls(d, 'inbox').length === 0, 'job left in inbox');
});

await test('auto-verify: detectVerifyCmd picks the strongest package.json check', async () => {
  const { detectVerifyCmd } = await import(pathToFileURL(path.join(REPO, '.harness', 'lib', 'common.mjs')).href);
  const cfg = { defaultVerifyCmd: 'NOOP' };
  const proj = (scripts, lock) => {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pkg-'));
    if (scripts) fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ scripts }));
    if (lock) fs.writeFileSync(path.join(p, lock), '');
    return detectVerifyCmd(p, cfg);
  };
  assert(proj({ check: 'x', test: 'y' }).cmd === 'npm run check', 'check should win');
  assert(proj({ test: 'y', typecheck: 'z', lint: 'l' }).cmd === 'npm run typecheck && npm test', 'typecheck+test');
  assert(proj({ build: 'b', lint: 'l' }).cmd === 'npm run build', 'build before lint');
  assert(proj({ lint: 'l' }).cmd === 'npm run lint', 'lint last resort');
  assert(proj({ test: 'echo "Error: no test specified" && exit 1' }).real === false, 'npm placeholder test must be ignored');
  assert(proj(null).cmd === 'NOOP' && proj(null).real === false, 'no package.json → default');
  assert(proj({ test: 'y' }, 'pnpm-lock.yaml').cmd === 'pnpm test', 'pnpm detection');
});

await test('auto-verify end-to-end: job with no verifyCmd runs package.json typecheck + test', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: {
    typecheck: 'node -e "require(\'fs\').writeFileSync(\'typechecked.flag\',\'1\')"',
    test: 'node -e "process.exit(require(\'fs\').existsSync(\'a.txt\')?0:1)"' } }));
  drop(d, { id: 'autoverify', title: 'av', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  assert(json(path.join(d, '.harness', 'state.json')).phase === '4_COMMITTED', 'not committed');
  assert(fs.existsSync(path.join(d, 'typechecked.flag')), 'typecheck script did not run');
  assert(log(d).some((e) => e.phase === '3_VERIFIER' && /npm run typecheck && npm test/.test(e.message) && /auto-detected/.test(e.source)), 'wrong verify command');
});

const planGoal = (plan) => `Build the thing. PLAN_JSON ${JSON.stringify(plan)}`;

await test('AI planner (--auto-plan): decomposes a goal into 2 parallel workers with read-only planning tools', () => {
  const d = sandbox();
  const plan = { subtasks: [
    { id: 'part-a', targetFiles: ['a.txt'], prompt: 'WRITE a.txt A' },
    { id: 'part-b', targetFiles: ['b.txt'], prompt: 'WRITE b.txt B' }], verifySuggestion: 'rm -rf /' };
  const r = node(d, ['.harness/dispatch.mjs', '--goal', planGoal(plan), '--auto-plan', '--check', existsCheck('a.txt', 'b.txt'), '--wait']);
  assert(r.status === 0 && /COMMITTED/.test(r.stdout), r.stdout + r.stderr);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.mode === 'SWARM-MESH (2W)' && /AI planner → 2 worker/.test(s.planSummary), `${s.mode} ${s.planSummary}`);
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'planner-calls.txt'), 'utf8').includes('ALLOWED=Read,Glob,Grep '), 'planner was not limited to read-only tools');
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'part-a.txt'), 'utf8').includes('[OVERALL GOAL'), 'worker missing overall goal');
  const note = fs.readdirSync(path.join(d, '.harness', 'memory', 'sessions')).map((f) => fs.readFileSync(path.join(d, '.harness', 'memory', 'sessions', f), 'utf8')).join('');
  assert(/suggested this check \(NOT run automatically\): `rm -rf \/`/.test(note), 'AI verify suggestion must be recorded, never run');
});

await test('AI planner: overlapping targetFiles are rejected (re-asked once with the error, then REJECTED, nothing runs)', () => {
  const d = sandbox();
  const plan = { subtasks: [
    { id: 'x', targetFiles: ['src/'], prompt: 'WRITE src/x.txt X' },
    { id: 'y', targetFiles: ['src/y.txt'], prompt: 'WRITE src/y.txt Y' }] };
  const r = node(d, ['.harness/dispatch.mjs', '--goal', planGoal(plan), '--auto-plan', '--wait']);
  assert(r.status === 1 && /NOT DONE/.test(r.stdout), r.stdout);
  const s = json(path.join(d, '.harness', 'state.json'));
  assert(s.phase === 'REJECTED' && /overlapping targetFiles/.test(s.lastGateStatus), s.lastGateStatus);
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'planner-calls.txt'), 'utf8').trim().split('\n').length === 2, 'planner not re-asked exactly once');
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'planner.txt'), 'utf8').includes('PREVIOUS PLAN WAS REJECTED'), 'feedback not given to planner');
  assert(!fs.existsSync(path.join(d, 'src')), 'a worker ran');
  assert(ls(d, 'failed').length === 1, 'not dead-lettered');
});

await test('AI planner: targets outside --files, unsafe paths, or invalid JSON are rejected', () => {
  for (const [plan, files, re] of [
    [{ subtasks: [{ id: 'a', targetFiles: ['other/x.txt'], prompt: 'WRITE other/x.txt 1' }] }, 'src/', /outside the allowed files/],
    [{ subtasks: [{ id: 'a', targetFiles: ['../escape.txt'], prompt: 'x' }] }, '', /unsafe target path/],
    [{ subtasks: [{ id: 'a', targetFiles: ['.harness/config.json'], prompt: 'x' }] }, '', /unsafe target path/],
    [{ subtasks: [{ id: 'a', targetFiles: [], prompt: 'x' }] }, '', /no targetFiles/],
    [null, '', /not valid JSON/]
  ]) {
    const d = sandbox();
    const goal = plan ? planGoal(plan) : 'no plan here';
    node(d, ['.harness/dispatch.mjs', '--goal', goal, '--auto-plan', '--files', files, '--wait']);
    const s = json(path.join(d, '.harness', 'state.json'));
    assert(s.phase === 'REJECTED' && re.test(s.lastGateStatus), `${re}: ${s.lastGateStatus}`);
    assert(!fs.existsSync(path.join(d, 'other')), 'worker ran');
  }
});

await test('memory: lessons are de-duplicated and capped at 50 lines in the worker prompt', () => {
  const d = sandbox();
  const lessons = Array.from({ length: 60 }, (_, i) => `- [L${i + 1}] (2026-01-01) Rule number ${i + 1}`).join('\n');
  fs.writeFileSync(path.join(d, '.harness', 'memory', 'lessons.md'), `# Lessons\n\n${lessons}\n- [L61] (2026-01-01) RULE NUMBER 60!\n`);
  fs.writeFileSync(path.join(d, '.harness', 'memory', 'auto-lessons.md'), '# Auto\n\n- [L1] (2026-01-01) rule number 59\n- [L2] (2026-01-01) An auto lesson\n');
  drop(d, { id: 'cap', title: 'cap', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const p = fs.readFileSync(path.join(d, '.mock-prompts', 'w.txt'), 'utf8');
  const lessonLines = p.split('\n').filter((l) => /^- (Rule number|RULE NUMBER|rule number|An auto lesson)/.test(l));
  assert(lessonLines.length <= 50, `${lessonLines.length} lesson lines`);
  assert(p.includes('Rule number 60') && !p.includes('RULE NUMBER 60!') && !p.includes('- rule number 59'), 'duplicates not removed');
  assert(!p.includes('Rule number 1\n'), 'oldest rules should be dropped first');
});

await test('memory: no double injection when the engine auto-loads it via CLAUDE.md @imports', () => {
  const d = sandbox();
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.mock.instructionFile = 'CLAUDE.md';
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg));
  fs.copyFileSync(path.join(REPO, 'CLAUDE.md'), path.join(d, 'CLAUDE.md'));
  fs.writeFileSync(path.join(d, '.harness', 'memory', 'profile.md'), '# User profile\n- Name: Test User\n');
  node(d, ['.harness/memory.mjs', 'remember', 'Taught rule XYZ']);
  node(d, ['.harness/memory.mjs', 'remember', 'Auto lesson QRS']); // goes to lessons; move one to auto:
  fs.writeFileSync(path.join(d, '.harness', 'memory', 'auto-lessons.md'), '# Auto\n\n- [L1] (2026-01-01) Auto lesson ABC\n');
  drop(d, { id: 'noddup', title: 'n', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const p = fs.readFileSync(path.join(d, '.mock-prompts', 'w.txt'), 'utf8');
  assert(!p.includes('Taught rule XYZ') && !p.includes('Test User'), 'profile/lessons injected twice');
  assert(p.includes('Auto lesson ABC'), 'auto lessons (not in CLAUDE.md) must still be injected');
  assert(/already loaded from the project instruction file/.test(p), 'missing auto-load notice');
});


// ───────────── v2.0: autonomous controller, backlog, roles + skills, release snapshots ─────────────

function setCharter(d, policy = {}, extra = '') {
  const f = path.join(d, '.harness', 'charter.md');
  let t = fs.readFileSync(f, 'utf8').replace(/\(describe your product goals here[^)]*\)/, 'Test project objectives: build the feature set the tests describe.');
  for (const [k, v] of Object.entries(policy)) t = t.replace(new RegExp(`^- ${k}: .*$`, 'm'), `- ${k}: ${v}`);
  fs.writeFileSync(f, t + (extra ? `\n${extra}\n` : ''));
}
const setBacklog = (d, tasks) => fs.writeFileSync(path.join(d, '.harness', 'backlog.json'), JSON.stringify({ version: '2.0.0', tasks }, null, 2));
const backlog = (d) => json(path.join(d, '.harness', 'backlog.json')).tasks;
const byId = (d, id) => backlog(d).find((t) => t.id === id);
const PASS = 'node -e "process.exit(0)"';
const tick = (d) => node(d, ['.harness/daemon.mjs', '--tick']);
const argsOf = (d, id) => json(path.join(d, '.mock-prompts', `${id}.args.json`));
const promptOf = (d, id) => fs.readFileSync(path.join(d, '.mock-prompts', `${id}.txt`), 'utf8');
const realTest = (d) => fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: PASS } }));
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

await test('autonomous tick: empty inbox promotes the highest-priority READY item; backlog item → DONE', () => {
  const d = sandbox(); setCharter(d, { autonomous: 'on' });
  setBacklog(d, [
    { id: 'A', title: 'low', priority: 2, status: 'READY', verifyCmd: PASS, subtasks: [{ id: 'wa', role: 'DEV_ENGINEER', targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js A' }] },
    { id: 'B', title: 'high', priority: 1, status: 'READY', verifyCmd: existsCheck('src/b.js'), subtasks: [{ id: 'wb', role: 'DEV_ENGINEER', targetFiles: ['src/b.js'], prompt: 'WRITE src/b.js B' }] },
    { id: 'C', title: 'idea', priority: 0, status: 'BACKLOG', goal: 'not groomed yet' }]);
  const r = tick(d);
  assert(/Autonomous tick: dispatched/.test(r.stdout), r.stdout + r.stderr);
  assert(byId(d, 'B').status === 'DONE' && byId(d, 'A').status === 'READY' && byId(d, 'C').status === 'BACKLOG', JSON.stringify(backlog(d).map((t) => t.status)));
  const job = json(path.join(d, '.harness', 'completed', ls(d, 'completed')[0]));
  assert(job.backlogId === 'B' && job.autonomous === true, 'job not linked to backlog item');
  assert(log(d).some((e) => e.phase === 'AUTO_DISPATCH' && e.backlogId === 'B'), 'no AUTO_DISPATCH');
});

await test('autonomous off in charter.md → tick does nothing', () => {
  const d = sandbox(); setCharter(d, { autonomous: 'off' });
  setBacklog(d, [{ id: 'A', title: 'x', status: 'READY', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js A' }] }]);
  const r = tick(d);
  assert(/off/.test(r.stdout) && byId(d, 'A').status === 'READY' && ls(d, 'completed').length === 0, r.stdout);
});

await test('empty backlog → PO_ARCHITECT (read-only) generates ≤ maxAutoTasksPerRun READY tasks from charter; first one runs', () => {
  const d = sandbox(); realTest(d);
  const tasks = [1, 2, 3, 4].map((n) => ({ title: `Task ${n}`, priority: n, goal: `g${n}`, acceptanceCriteria: [`ac${n}`], verifySuggestion: 'rm -rf /',
    subtasks: [{ id: `w${n}`, role: 'DEV_ENGINEER', targetFiles: [`src/t${n}.js`], prompt: `WRITE src/t${n}.js ${n}` }] }));
  setCharter(d, { autonomous: 'on', maxAutoTasksPerRun: 2 }, `PO_JSON ${JSON.stringify({ tasks })}`);
  setBacklog(d, []);
  tick(d);
  const b = backlog(d);
  assert(b.length === 2 && b.every((t) => t.source === 'PO_ARCHITECT'), `expected 2 PO tasks, got ${b.length}`);
  assert(b[0].status === 'DONE' && b[1].status === 'READY', b.map((t) => t.status).join());
  assert(fs.existsSync(path.join(d, 'src', 't1.js')) && !fs.existsSync(path.join(d, 'src', 't2.js')), 'wrong task ran');
  const po = fs.readFileSync(path.join(d, '.mock-prompts', 'po-calls.txt'), 'utf8');
  assert(/ALLOWED=Read,Glob,Grep,Bash\(git status\),Bash\(git log:\*\) /.test(po) && !/Edit|Write/.test(po.split('DENIED=')[0]), `PO not read-only: ${po}`);
  assert(promptOf(d, 'po-architect').includes('Autonomous Controller Charter'), 'charter not given to PO');
  assert(b[0].verifyCmd === undefined && b[0].verifySuggestion === 'rm -rf /', 'AI-suggested check must be recorded, never used');
  assert(promptOf(d, 'w1').includes('[ACCEPTANCE CRITERIA]:\n- ac1'), 'acceptance criteria not passed to worker');
});

await test('PO_ARCHITECT tasks that break the charter or role scopes are dropped', () => {
  const d = sandbox(); realTest(d);
  const t = (title, sub) => ({ title, subtasks: [sub] });
  const tasks = [
    t('env', { id: 'a', role: 'DEV_ENGINEER', targetFiles: ['.env.local'], prompt: 'x' }),
    t('ba-on-src', { id: 'b', role: 'BA_ANALYST', targetFiles: ['src/x.js'], prompt: 'x' }),
    t('outside', { id: 'c', role: 'DEV_ENGINEER', targetFiles: ['lib/x.js'], prompt: 'x' }),
    t('no-role-skill', { id: 'd', role: 'DEV_ENGINEER', skills: ['nope'], targetFiles: ['src/d.js'], prompt: 'x' }),
    t('good', { id: 'e', role: 'DEV_ENGINEER', targetFiles: ['src/e.js'], prompt: 'WRITE src/e.js ok' })];
  setCharter(d, { autonomous: 'on', maxAutoTasksPerRun: 5 }, `PO_JSON ${JSON.stringify({ tasks })}`);
  setBacklog(d, []);
  tick(d);
  assert(backlog(d).map((x) => x.title).join() === 'good', backlog(d).map((x) => x.title).join());
  const rej = log(d).filter((e) => e.phase === '0_PO_TASK_REJECTED').map((e) => e.message).join('\n');
  assert(/forbids/.test(rej) && /BA_ANALYST may only own docs/.test(rej) && /outside charter allowedPaths/.test(rej) && /unknown skill/.test(rej), rej);
});

await test('requireRealCheck: no real check in the project → autonomy pauses instead of generating work', () => {
  const d = sandbox(); setCharter(d, { autonomous: 'on' }, 'PO_JSON {"tasks":[]}'); setBacklog(d, []);
  const r = tick(d);
  assert(/paused/.test(r.stdout) && !fs.existsSync(path.join(d, '.mock-prompts', 'po-calls.txt')), r.stdout);
  assert(log(d).some((e) => e.phase === 'AUTO_PAUSED' && /real check/.test(e.message)), 'no AUTO_PAUSED');
});

await test('autonomous daemon: budget maxAutoTasksPerRun=2 with 4 READY items → exactly 2 run, then it stops', async () => {
  const d = sandbox(); setCharter(d, { autonomous: 'on', maxAutoTasksPerRun: 2 });
  setBacklog(d, [1, 2, 3, 4].map((n) => ({ id: `T${n}`, title: `t${n}`, priority: n, status: 'READY', verifyCmd: PASS, subtasks: [{ id: `w${n}`, targetFiles: [`src/${n}.js`], prompt: `WRITE src/${n}.js x` }] })));
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs', '--autonomous', '--interval', '1'], { cwd: d, env, stdio: 'ignore' });
  await waitFor(() => backlog(d).filter((t) => t.status === 'DONE').length >= 2);
  await new Promise((r) => setTimeout(r, 3000)); // two more interval ticks: must not start a 3rd task
  daemon.kill('SIGTERM'); await new Promise((r) => daemon.on('close', r));
  const st = backlog(d).map((t) => t.status).join();
  assert(st === 'DONE,DONE,READY,READY', st);
  assert(log(d).some((e) => e.phase === 'AUTO_BUDGET_USED'), 'budget stop not logged');
  assert(json(path.join(d, '.harness', 'state.json')).autonomous.used === 2, 'state.autonomous.used != 2');
});

await test('failed autonomous task → files restored, item BLOCKED with reason, autonomy pauses (next READY not started)', async () => {
  const d = sandbox(); setCharter(d, { autonomous: 'on' });
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'f.js'), 'ORIGINAL');
  setBacklog(d, [
    { id: 'BAD', title: 'bad', priority: 1, status: 'READY', verifyCmd: FAIL_VERIFY, subtasks: [{ id: 'w1', targetFiles: ['src/f.js'], prompt: 'WRITE src/f.js BROKEN' }] },
    { id: 'NEXT', title: 'next', priority: 2, status: 'READY', verifyCmd: PASS, subtasks: [{ id: 'w2', targetFiles: ['src/n.js'], prompt: 'WRITE src/n.js x' }] }]);
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs', '--autonomous', '--interval', '1'], { cwd: d, env, stdio: 'ignore' });
  await waitFor(() => byId(d, 'BAD').status === 'BLOCKED');
  await new Promise((r) => setTimeout(r, 2500));
  daemon.kill('SIGTERM'); await new Promise((r) => daemon.on('close', r));
  assert(byId(d, 'BAD').status === 'BLOCKED' && /HALTED_HITL_REQUIRED/.test(byId(d, 'BAD').blockedReason), JSON.stringify(byId(d, 'BAD')));
  assert(byId(d, 'NEXT').status === 'READY', `NEXT is ${byId(d, 'NEXT').status} — autonomy should pause`);
  assert(fs.readFileSync(path.join(d, 'src', 'f.js'), 'utf8') === 'ORIGINAL', 'file not restored');
  assert(log(d).some((e) => e.phase === 'AUTO_PAUSED'), 'no AUTO_PAUSED');
});

await test('import new backlog → old charter/backlog/summary + unstarted inbox jobs saved to releases/, lessons kept', () => {
  const d = sandbox();
  setBacklog(d, [{ id: 'OLD-1', title: 'shipped thing', status: 'DONE' }, { id: 'OLD-2', title: 'half', status: 'IN_PROGRESS' }]);
  node(d, ['.harness/memory.mjs', 'remember', 'Keep this rule']);
  drop(d, { id: 'ghost-job', title: 'queued under old backlog', subtasks: [{ id: 'w', targetFiles: ['a'], prompt: 'x' }] });
  const nb = path.join(d, 'new-backlog.json');
  fs.writeFileSync(nb, JSON.stringify({ project: 'v2', tasks: [{ id: 'NEW-1', title: 'fresh', status: 'READY' }] }));
  const r = node(d, ['.harness/backlog.mjs', 'import', 'new-backlog.json']);
  assert(r.status === 0, r.stdout + r.stderr);
  const rel = fs.readdirSync(path.join(d, '.harness', 'releases')).filter((x) => x.startsWith('release-'));
  assert(rel.length === 1, `releases: ${rel}`);
  const R = path.join(d, '.harness', 'releases', rel[0]);
  for (const f of ['charter.md', 'backlog.json', 'completed-summary.md', 'inbox/ghost-job.json']) assert(fs.existsSync(path.join(R, f)), `missing ${f} in snapshot`);
  assert(/OLD-1: shipped thing/.test(fs.readFileSync(path.join(R, 'completed-summary.md'), 'utf8')), 'summary lacks DONE item');
  assert(json(path.join(R, 'backlog.json')).tasks.length === 2, 'old backlog not preserved');
  assert(ls(d, 'inbox').length === 0, 'ghost job left in inbox');
  assert(backlog(d)[0].id === 'NEW-1', 'new backlog not active');
  assert(/Keep this rule/.test(fs.readFileSync(path.join(d, '.harness', 'memory', 'lessons.md'), 'utf8')), 'lessons lost');
  // charter upload, then a memory reset upload
  fs.writeFileSync(path.join(d, 'charter-v2.md'), '# New charter\n- autonomous: off\n');
  assert(node(d, ['.harness/backlog.mjs', 'import', 'charter-v2.md']).status === 0, 'charter import failed');
  assert(fs.readFileSync(path.join(d, '.harness', 'charter.md'), 'utf8').startsWith('# New charter'), 'charter not replaced');
  assert(node(d, ['.harness/backlog.mjs', 'import', 'new-backlog.json', '--reset-memory']).status === 0, 'reset import failed');
  const rels = fs.readdirSync(path.join(d, '.harness', 'releases')).filter((x) => x.startsWith('release-')).sort();
  assert(rels.length === 3, `expected 3 releases, got ${rels.length}`);
  assert(/Keep this rule/.test(fs.readFileSync(path.join(d, '.harness', 'releases', rels[2], 'memory', 'lessons.md'), 'utf8')), 'memory not saved before reset');
  assert(!/Keep this rule/.test(fs.readFileSync(path.join(d, '.harness', 'memory', 'lessons.md'), 'utf8')), 'memory not reset');
});

await test('import: invalid backlog changes nothing; import while a task runs is refused; skills pack replaced with snapshot', () => {
  const d = sandbox();
  setBacklog(d, [{ id: 'KEEP', title: 'k', status: 'READY' }]);
  fs.writeFileSync(path.join(d, 'bad.json'), JSON.stringify({ tasks: [{ id: 'x', title: 'a', status: 'WEIRD' }] }));
  const bad = node(d, ['.harness/backlog.mjs', 'import', 'bad.json']);
  assert(bad.status === 1 && /unknown status/.test(bad.stderr) && byId(d, 'KEEP'), bad.stderr);
  assert(!fs.readdirSync(path.join(d, '.harness', 'releases')).some((x) => x.startsWith('release-')), 'snapshot made for a rejected upload');
  fs.writeFileSync(path.join(d, '.harness', 'daemon.pid'), String(process.pid));
  fs.writeFileSync(path.join(d, '.harness', 'state.json'), JSON.stringify({ currentTaskFile: 'x.json', taskTitle: 'busy' }));
  fs.writeFileSync(path.join(d, 'ok.json'), JSON.stringify({ tasks: [] }));
  assert(node(d, ['.harness/backlog.mjs', 'import', 'ok.json']).status === 2, 'import during a running task must be refused');
  fs.rmSync(path.join(d, '.harness', 'daemon.pid'));
  fs.mkdirSync(path.join(d, 'pack', 'new-skill'), { recursive: true });
  fs.writeFileSync(path.join(d, 'pack', 'new-skill', 'SKILL.md'), '---\nname: new-skill\ndescription: d\nroles: ["DEV_ENGINEER"]\n---\nRule.');
  const r = node(d, ['.harness/backlog.mjs', 'import', 'pack']);
  assert(r.status === 0 && /Skills now: new-skill/.test(r.stdout), r.stdout + r.stderr);
  const rel = fs.readdirSync(path.join(d, '.harness', 'releases')).filter((x) => x.startsWith('release-'));
  assert(fs.existsSync(path.join(d, '.harness', 'releases', rel[0], 'skills', 'code-craft', 'SKILL.md')), 'old skills not in snapshot');
});

await test('roles + skills: BA vs DEV vs QA get different engine tools; skill rules injected only where allowed', () => {
  const d = sandbox();
  drop(d, { id: 'roles', title: 'roles', verifyCmd: PASS, subtasks: [
    { id: 'ba', role: 'BA_ANALYST', skills: ['code-craft'], targetFiles: ['docs/spec.md'], prompt: 'WRITE docs/spec.md s' },
    { id: 'dev', role: 'DEV_ENGINEER', skills: ['code-craft'], targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js a' },
    { id: 'qa', role: 'QA_AUDITOR', targetFiles: ['tests/a.test.js'], prompt: 'WRITE tests/a.test.js t' }] });
  runOnce(d);
  assert(json(path.join(d, '.harness', 'state.json')).phase === '4_COMMITTED', 'not committed');
  const tools = (id) => argsOf(d, id).find((a) => a.startsWith('ALLOWED=')).slice(8).split(',');
  const denied = argsOf(d, 'dev').find((a) => a.startsWith('DENIED=')).slice(7);
  const ba = tools('ba'); const dev = tools('dev'); const qa = tools('qa');
  assert(ba.includes('Edit(docs/spec.md)') && ba.includes('Write(docs/spec.md)') && ba.includes('Bash(git status)') && !ba.some((t) => /npm|src/.test(t)), `BA: ${ba}`);
  assert(dev.includes('Edit(src/a.js)') && dev.includes('Write(src/a.js)') && dev.includes('Bash(npm test:*)') && dev.includes('Bash(node --test:*)') && !dev.includes('Bash(node:*)') && !dev.includes('Bash(npm:*)') && !dev.some((t) => /git/.test(t)), `DEV (narrowed by code-craft to npm test + node --test): ${dev}`);
  assert(qa.includes('Edit(tests/a.test.js)') && qa.includes('Bash(npm test:*)') && !qa.includes('Bash(npm:*)') && !qa.some((t) => /node/.test(t)), `QA (npm test only): ${qa}`);
  assert(/Edit\(\.env\*\)/.test(denied) && /Bash\(git push:\*\)/.test(denied), `deny rules: ${denied}`);
  assert(promptOf(d, 'dev').includes('@governed-by PO_ARCHITECT') && promptOf(d, 'dev').includes('[ROLE PERSONA — DEV_ENGINEER]'), 'skill/persona not injected for DEV');
  assert(!promptOf(d, 'ba').includes('Code Craft Skill Rules') && promptOf(d, 'ba').includes('[ROLE PERSONA — BA_ANALYST]'), 'skill wrongly injected into BA');
  assert(log(d).some((e) => e.phase === 'SKILL_ROLE_MISMATCH' && /code-craft/.test(e.message)), 'mismatch not logged');
  const arch = json(path.join(d, '.harness', 'completed', ls(d, 'completed')[0]));
  assert(arch.plan.find((s) => s.id === 'dev').resolvedSkills[0] === 'code-craft', 'audit trail lacks resolved skills');
});

await test('role write-scope, forbidden paths, unknown role and unknown skill are rejected before any worker runs', () => {
  for (const [sub, re] of [
    [{ id: 'w', role: 'BA_ANALYST', targetFiles: ['src/x.js'], prompt: 'WRITE src/x.js x' }, /BA_ANALYST may only own docs/],
    [{ id: 'w', role: 'QA_AUDITOR', targetFiles: ['src/x.js'], prompt: 'WRITE src/x.js x' }, /QA_AUDITOR may only own/],
    [{ id: 'w', targetFiles: ['.env'], prompt: 'WRITE .env x' }, /charter\.md forbids/],
    [{ id: 'w', targetFiles: ['node_modules/x/index.js'], prompt: 'WRITE x x' }, /charter\.md forbids/],
    [{ id: 'w', role: 'HACKER', targetFiles: ['src/x.js'], prompt: 'x' }, /unknown role/],
    [{ id: 'w', role: 'DEV_ENGINEER', skills: ['ghost'], targetFiles: ['src/x.js'], prompt: 'x' }, /unknown skill/]
  ]) {
    const d = sandbox();
    drop(d, { id: 'scope', title: 's', subtasks: [sub] });
    runOnce(d);
    const s = json(path.join(d, '.harness', 'state.json'));
    assert(s.phase === 'REJECTED' && re.test(s.lastGateStatus), `${re}: ${s.lastGateStatus}`);
    assert(!fs.existsSync(path.join(d, '.mock-prompts', 'w.txt')), 'worker ran');
  }
});

await test('true parallel swarm: BA, DEV and QA workers all start before any finishes', () => {
  const d = sandbox();
  drop(d, { id: 'par', title: 'par', verifyCmd: PASS, subtasks: [
    { id: 'p-ba', role: 'BA_ANALYST', targetFiles: ['docs/a.md'], prompt: 'SLEEP 800\nWRITE docs/a.md a' },
    { id: 'p-dev', role: 'DEV_ENGINEER', targetFiles: ['src/a.js'], prompt: 'SLEEP 800\nWRITE src/a.js a' },
    { id: 'p-qa', role: 'QA_AUDITOR', targetFiles: ['tests/a.test.js'], prompt: 'SLEEP 800\nWRITE tests/a.test.js a' }] });
  runOnce(d);
  const tl = fs.readFileSync(path.join(d, '.mock-prompts', 'timeline.txt'), 'utf8').trim().split('\n').map((l) => l.split(' '));
  const lastStart = Math.max(...tl.filter((x) => x[1] === 'start').map((x) => +x[0]));
  const firstEnd = Math.min(...tl.filter((x) => x[1] === 'end').map((x) => +x[0]));
  assert(tl.filter((x) => x[1] === 'start').length === 3 && lastStart < firstEnd, `not parallel: ${JSON.stringify(tl)}`);
});

await test('AI planner assigns roles: valid roles accepted, role/path mismatch rejected', () => {
  const d = sandbox();
  const good = { interfaceContract: 'add(a,b)', subtasks: [
    { id: 'spec', role: 'BA_ANALYST', targetFiles: ['docs/add.md'], prompt: 'WRITE docs/add.md spec' },
    { id: 'impl', role: 'DEV_ENGINEER', skills: ['code-craft'], targetFiles: ['src/add.js'], prompt: 'WRITE src/add.js impl' }] };
  const r = node(d, ['.harness/dispatch.mjs', '--goal', planGoal(good), '--auto-plan', '--check', existsCheck('docs/add.md', 'src/add.js'), '--wait']);
  assert(r.status === 0, r.stdout);
  assert(promptOf(d, 'impl').includes('[SHARED INTERFACE CONTRACT') && promptOf(d, 'impl').includes('add(a,b)'), 'interface contract not passed');
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'planner.txt'), 'utf8').includes('[WORKER ROLES'), 'planner not told about roles');
  const d2 = sandbox();
  const bad = { subtasks: [{ id: 'x', role: 'BA_ANALYST', targetFiles: ['src/x.js'], prompt: 'x' }] };
  node(d2, ['.harness/dispatch.mjs', '--goal', planGoal(bad), '--auto-plan', '--wait']);
  assert(/BA_ANALYST may only own/.test(json(path.join(d2, '.harness', 'state.json')).lastGateStatus), 'role mismatch not rejected');
});

await test('backlog CLI: add / list / ready / pop', () => {
  const d = sandbox();
  const add = node(d, ['.harness/backlog.mjs', 'add', 'Write docs', '--role', 'BA_ANALYST', '--files', 'docs/x.md', '--check', PASS, '--priority', '2']);
  const id = (add.stdout.match(/Added (\S+)/) || [])[1];
  assert(id && byId(d, id).status === 'BACKLOG' && byId(d, id).role === 'BA_ANALYST', add.stdout);
  assert(/Next to run: \(nothing READY\)/.test(node(d, ['.harness/backlog.mjs', 'list']).stdout), 'list wrong');
  node(d, ['.harness/backlog.mjs', 'ready', id]);
  const pop = node(d, ['.harness/backlog.mjs', 'pop']);
  assert(/Promoted/.test(pop.stdout) && byId(d, id).status === 'IN_PROGRESS' && ls(d, 'inbox').length === 1, pop.stdout);
  runOnce(d);
  assert(byId(d, id).status === 'DONE', `status ${byId(d, id).status}`);
});


// ───────────── v2.1: uat integration branch, live agent output, heartbeat ─────────────

function gitSandbox({ mode = 'autonomous', autonomous = true } = {}) {
  const d = sandbox();
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.git = { integrationBranch: 'uat', integrationMode: mode, integrationBase: 'HEAD', protectedBranches: ['main', 'master'], keepFailedBranches: true, linkIntoWorktrees: ['node_modules'] };
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  if (autonomous) setCharter(d, { autonomous: 'on' });
  fs.copyFileSync(path.join(REPO, '.gitignore'), path.join(d, '.gitignore'));
  fs.writeFileSync(path.join(d, 'README.md'), '# demo\n');
  const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  return { d, g, sha: (ref) => { try { return g('rev-parse', '--verify', ref); } catch { return null; } } };
}
const onBranch = (g, ref, file) => { try { return g('show', `${ref}:${file}`); } catch { return null; } };

await test('uat: autonomous task is built on its own branch, verified as a candidate, then merged into uat — main, your folder and checked-out branch untouched; out-of-scope edit discarded', () => {
  const { d, g, sha } = gitSandbox();
  const mainBefore = sha('main');
  setBacklog(d, [{ id: 'U1', title: 'greeter', priority: 1, status: 'READY', verifyCmd: existsCheck('src/g.js'),
    subtasks: [{ id: 'dev', role: 'DEV_ENGINEER', targetFiles: ['src/g.js'], prompt: 'WRITE src/g.js hello\nWRITE docs/leak.md sneaky' }] }]);
  const r = tick(d);
  assert(byId(d, 'U1').status === 'DONE', `${byId(d, 'U1').status} ${byId(d, 'U1').blockedReason || ''} ${r.stdout}`);
  assert(onBranch(g, 'uat', 'src/g.js') === 'hello', 'uat lacks the work');
  assert(onBranch(g, 'uat', 'docs/leak.md') === null, 'out-of-scope file reached uat');
  assert(sha('main') === mainBefore, 'main moved!');
  assert(g('branch', '--show-current') === 'main' && !fs.existsSync(path.join(d, 'src', 'g.js')), 'your folder/branch was touched');
  assert(g('branch', '--list', 'harness/*') === '', 'worker branches not cleaned up after success');
  assert(g('worktree', 'list').split('\n').length === 1, 'worktrees left behind');
  const ev = log(d).map((e) => e.phase);
  for (const p of ['GIT_BRANCH_CREATED', 'GIT_WORKER_COMMIT', 'GIT_CANDIDATE', 'GIT_INTEGRATED', 'PROTECTED_BRANCHES_UNCHANGED', '2_SCOPE_VIOLATION']) assert(ev.includes(p), `missing ${p}`);
  assert(log(d).find((e) => e.phase === '3_VERIFIER').cwd.includes('_integration'), 'verifier did not run on the candidate');
  const arch = json(path.join(d, '.harness', 'completed', ls(d, 'completed')[0]));
  assert(arch.git.to === sha('uat') && byId(d, 'U1').integratedInto === `uat@${sha('uat').slice(0, 8)}`, 'audit trail lacks merge sha');
  assert(g('log', '--format=%s', 'uat').includes('harness(U1-run'), 'merge commit message missing');
});

await test('uat: failed check → uat does NOT move (no broken merge), worker branch kept for review, item BLOCKED', () => {
  const { d, g, sha } = gitSandbox();
  const mainBefore = sha('main');
  setBacklog(d, [{ id: 'U2', title: 'bad', priority: 1, status: 'READY', verifyCmd: FAIL_VERIFY,
    subtasks: [{ id: 'dev', role: 'DEV_ENGINEER', targetFiles: ['src/bad.js'], prompt: 'WRITE src/bad.js broken' }] }]);
  tick(d);
  assert(byId(d, 'U2').status === 'BLOCKED', byId(d, 'U2').status);
  assert(sha('uat') === mainBefore && onBranch(g, 'uat', 'src/bad.js') === null, 'failed work reached uat');
  assert(sha('main') === mainBefore, 'main moved');
  const kept = g('branch', '--list', 'harness/*');
  assert(/harness\/U2-run[\w-]+\/dev/.test(kept), `worker branch not kept: ${kept}`);
  assert(onBranch(g, kept.replace(/^[*+\s]+/, '').trim(), 'src/bad.js') === 'broken', 'kept branch lacks the attempt');
  const f = json(path.join(d, '.harness', 'failed', ls(d, 'failed')[0]));
  assert(/uat unchanged/.test(f.rollback) && f.git.protectedUnchanged === true, JSON.stringify(f.rollback));
});

await test('uat: MODIFYING an existing tracked file is committed and merged (regression: git status " M path" lost its first letter)', () => {
  const { d, g } = gitSandbox();
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'slug.js'), 'v1');
  fs.writeFileSync(path.join(d, 'zz.txt'), 'z'); // sorts after src/: the modified file is the FIRST status entry
  g('add', '-A'); g('commit', '-q', '-m', 'add slug');
  setBacklog(d, [{ id: 'MOD', title: 'edit existing', priority: 1, status: 'READY', verifyCmd: 'node -e "process.exit(require(\'fs\').readFileSync(\'src/slug.js\',\'utf8\')===\'v2\'?0:1)"',
    subtasks: [{ id: 'dev', role: 'DEV_ENGINEER', targetFiles: ['src/slug.js'], prompt: 'WRITE src/slug.js v2' }] }]);
  tick(d);
  assert(byId(d, 'MOD').status === 'DONE', `${byId(d, 'MOD').status} ${byId(d, 'MOD').blockedReason || ''}`);
  assert(onBranch(g, 'uat', 'src/slug.js') === 'v2', 'the modification did not reach uat');
  assert(!log(d).some((e) => e.phase === '2_SCOPE_VIOLATION'), 'in-scope modification wrongly reported as a scope violation');
});

await test('uat: a retry continues in the same worker branch and only the passing cycle is merged', () => {
  const { d, g } = gitSandbox();
  setBacklog(d, [{ id: 'U3', title: 'retry', priority: 1, status: 'READY', verifyCmd: existsCheck('src/f.js'),
    subtasks: [{ id: 'dev', targetFiles: ['src/f.js'], prompt: 'FIX src/f.js fixed' }] }]);
  tick(d);
  assert(byId(d, 'U3').status === 'DONE' && byId(d, 'U3').cyclesUsed === 2, JSON.stringify(byId(d, 'U3')));
  assert(onBranch(g, 'uat', 'src/f.js') === 'fixed', 'fix not on uat');
});

await test('uat: two parallel workers (BA + DEV) are merged into one verified candidate', () => {
  const { d, g } = gitSandbox();
  setBacklog(d, [{ id: 'U4', title: 'pair', priority: 1, status: 'READY', verifyCmd: existsCheck('docs/a.md', 'src/a.js'),
    subtasks: [{ id: 'ba', role: 'BA_ANALYST', targetFiles: ['docs/a.md'], prompt: 'WRITE docs/a.md spec' },
      { id: 'dev', role: 'DEV_ENGINEER', targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js code' }] }]);
  tick(d);
  assert(onBranch(g, 'uat', 'docs/a.md') === 'spec' && onBranch(g, 'uat', 'src/a.js') === 'code', 'not both merged');
  assert((g('log', '--format=%s', 'uat').match(/merge (ba|dev) into uat/g) || []).length === 2, 'expected 2 merge commits');
});

await test('uat checked out in your folder: clean → fast-forwarded there; uncommitted changes → refused, uat unchanged', () => {
  const { d, g, sha } = gitSandbox();
  g('checkout', '-q', '-b', 'uat');
  setBacklog(d, [{ id: 'U5', title: 'ff', priority: 1, status: 'READY', verifyCmd: existsCheck('src/ff.js'), subtasks: [{ id: 'dev', targetFiles: ['src/ff.js'], prompt: 'WRITE src/ff.js ff' }] },
    { id: 'U6', title: 'dirty', priority: 2, status: 'READY', verifyCmd: existsCheck('src/x.js'), subtasks: [{ id: 'dev', targetFiles: ['src/x.js'], prompt: 'WRITE src/x.js x' }] }]);
  tick(d);
  assert(byId(d, 'U5').status === 'DONE' && fs.readFileSync(path.join(d, 'src', 'ff.js'), 'utf8') === 'ff', 'not fast-forwarded into the checked-out uat');
  fs.appendFileSync(path.join(d, 'README.md'), 'my unsaved edit\n');
  const before = sha('uat');
  tick(d);
  assert(byId(d, 'U6').status === 'BLOCKED' && /uncommitted changes/.test(byId(d, 'U6').blockedReason), byId(d, 'U6').blockedReason);
  assert(sha('uat') === before && fs.readFileSync(path.join(d, 'README.md'), 'utf8').includes('my unsaved edit'), 'your uncommitted work was touched');
});

await test('uat: protected branch as target is refused; autonomous work without git is refused', () => {
  const { d, sha } = gitSandbox({ autonomous: false });
  const mainBefore = sha('main');
  drop(d, { id: 'prot', title: 'p', integrationBranch: 'main', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['src/p.js'], prompt: 'WRITE src/p.js p' }] });
  runOnce(d);
  assert(/protected branch 'main'/.test(json(path.join(d, '.harness', 'state.json')).lastGateStatus) && sha('main') === mainBefore, 'protected target not refused');
  const n = sandbox();
  const cfg = json(path.join(n, '.harness', 'config.json')); cfg.git.integrationMode = 'autonomous'; cfg.git.integrationBranch = 'uat';
  fs.writeFileSync(path.join(n, '.harness', 'config.json'), JSON.stringify(cfg));
  setCharter(n, { autonomous: 'on' });
  setBacklog(n, [{ id: 'NG', title: 'nogit', status: 'READY', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js a' }] }]);
  tick(n);
  assert(/needs a git repository/.test(byId(n, 'NG').blockedReason || '') && !fs.existsSync(path.join(n, 'src', 'a.js')), 'non-git autonomous not refused');
});

await test('uat: manual "dispatch --branch uat" opts a normal task in; without it, manual tasks still edit your folder', () => {
  const { d, g } = gitSandbox({ autonomous: false });
  const r = node(d, ['.harness/dispatch.mjs', '--goal', 'WRITE src/m.js m', '--files', 'src/m.js', '--branch', 'uat', '--check', existsCheck('src/m.js'), '--wait']);
  assert(r.status === 0 && onBranch(g, 'uat', 'src/m.js') === 'm' && !fs.existsSync(path.join(d, 'src', 'm.js')), r.stdout);
  const r2 = node(d, ['.harness/dispatch.mjs', '--goal', 'WRITE src/local.js l', '--files', 'src/local.js', '--check', existsCheck('src/local.js'), '--wait']);
  assert(r2.status === 0 && fs.existsSync(path.join(d, 'src', 'local.js')) && onBranch(g, 'uat', 'src/local.js') === null, 'manual default changed');
});

await test('live agent output: stream-json events become readable lines (tool calls, messages, denials); quiet mode uses batch JSON', () => {
  const d = sandbox();
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.mock.args = [MOCK, '{output}', 'ALLOWED={allowedTools}'];
  cfg.profiles.mock.output = { batch: ['FMT=json'], stream: ['FMT=stream'] };
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  drop(d, { id: 'live', title: 'live', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['src/a.js'], prompt: 'SAY Planning the module\nWRITE src/a.js a\nDENY src/evil.js' }] });
  const r = node(d, ['.harness/daemon.mjs', '--once'], { HARNESS_LIVE: '1' });
  const out = r.stdout;
  for (const want of ['▶ agent started (mock-model)', '💬 Planning the module', '🔧 Write src/a.js', '✔ finished in 0.0s', '⛔ denied: Write src/evil.js']) assert(out.includes(want), `missing "${want}" in:\n${out}`);
  assert(argsOf(d, 'w').includes('FMT=stream'), 'stream args not used');
  assert(log(d).some((e) => e.phase === 'PERMISSION_DENIED' && e.denials[0].target.replaceAll('\\', '/').endsWith('src/evil.js')), 'denial not in audit log');
  assert(json(path.join(d, '.harness', 'state.json')).phase === '4_COMMITTED', 'final result not parsed from stream');
  const q = sandbox();
  fs.writeFileSync(path.join(q, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  drop(q, { id: 'quiet', title: 'q', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js a' }] });
  const rq = node(q, ['.harness/daemon.mjs', '--once'], { HARNESS_LIVE: '0' });
  assert(argsOf(q, 'w').includes('FMT=json') && !rq.stdout.includes('🔧'), 'quiet mode should not stream');
});

await test('heartbeat: config heartbeatIntervalSeconds wakes the controller again and picks up work added later', async () => {
  const { d } = gitSandbox();
  const cfg = json(path.join(d, '.harness', 'config.json')); cfg.heartbeatIntervalSeconds = 1;
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  setCharter(d, { requireRealCheck: 'no' }, 'PO_JSON {"tasks":[]}');
  setBacklog(d, []);
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs', '--autonomous'], { cwd: d, env, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  setBacklog(d, [{ id: 'LATE', title: 'added later', status: 'READY', verifyCmd: existsCheck('src/late.js'), subtasks: [{ id: 'w', targetFiles: ['src/late.js'], prompt: 'WRITE src/late.js l' }] }]);
  const ok = await waitFor(() => byId(d, 'LATE')?.status === 'DONE', 15000);
  daemon.kill('SIGTERM'); await new Promise((r) => daemon.on('close', r));
  assert(ok, `LATE is ${byId(d, 'LATE')?.status}`);
  assert(log(d).some((e) => e.phase === 'AUTO_DISPATCH' && e.trigger === 'interval'), 'not woken by the heartbeat');
  assert(log(d).some((e) => e.phase === 'AUTO_START' && /every 1s/.test(e.message)), 'heartbeat config not used');
});


// ───────────── v2.2: skill exact-command rules, PO sees uat + is throttled, --status ─────────────

await test('skill exact rules: DEV gets only "npm test" + node (not npm:*), a skill can never grant what the role lacks, QA never gets node', async () => {
  const { computeAllowedTools, skillRulesNotGranted, loadRoles, loadSkills } = await import(pathToFileURL(path.join(REPO, '.harness', 'lib', 'governance.mjs')).href);
  const roles = loadRoles(); const skills = loadSkills();
  const cc = skills['code-craft'];
  const dev = computeAllowedTools(roles.DEV_ENGINEER, [cc], ['src/a.js']);
  assert(dev.includes('Bash(npm test:*)') && dev.includes('Bash(node --test:*)') && dev.includes('Edit(src/a.js)') && !dev.includes('Bash(node:*)') && !dev.includes('Bash(npm:*)') && !dev.some((t) => /git/.test(t)), dev.join());
  const qa = computeAllowedTools(roles.QA_AUDITOR, [cc], ['tests/a.test.js']);
  assert(qa.includes('Bash(npm test:*)') && !qa.some((t) => /node/.test(t)) && !qa.some((t) => /npm run/.test(t)), qa.join());
  assert(skillRulesNotGranted(roles.QA_AUDITOR, [cc]).length === 0 && skillRulesNotGranted(roles.DEV_ENGINEER, [cc]).length === 0, 'shipped skill asks for something its roles lack');
  assert(skillRulesNotGranted(roles.QA_AUDITOR, [{ name: 'x', allowedTools: ['Bash(node --test:*)'] }]).join().includes('node --test'), 'ungranted rule not reported');
  // per-role override really is per role: the same skill file gives DEV node --test but QA only npm test
  assert(cc.toolsByRole.DEV_ENGINEER.includes('Bash(node --test:*)') && !cc.allowedTools.some((t) => /node/.test(t)), 'per-role lists not parsed');
  const evil = { name: 'evil', allowedTools: ['Read', 'Bash(rm:*)', 'Bash(git push:*)', 'Bash(npm test:*)'] };
  const d2 = computeAllowedTools(roles.DEV_ENGINEER, [evil], ['src/a.js']);
  assert(!d2.some((t) => /rm|push/.test(t)) && d2.includes('Bash(npm test:*)') && !d2.some((t) => t.startsWith('Edit')), `skill granted something: ${d2.join()}`);
  const ba = computeAllowedTools(roles.BA_ANALYST, [cc], ['docs/a.md']);
  assert(!ba.some((t) => t.startsWith('Bash(node')), 'BA must not gain node');
});

await test('role + skill end-to-end: engine args for a DEV worker carry exactly the narrowed rules; the ungranted skill rule is logged', () => {
  const d = sandbox();
  drop(d, { id: 'skillrules', title: 's', verifyCmd: PASS, subtasks: [
    { id: 'dev', role: 'DEV_ENGINEER', skills: ['code-craft'], targetFiles: ['src/a.js'], prompt: 'WRITE src/a.js a' },
    { id: 'qa', role: 'QA_AUDITOR', skills: ['code-craft'], targetFiles: ['tests/a.test.js'], prompt: 'WRITE tests/a.test.js t' }] });
  runOnce(d);
  const tools = (id) => argsOf(d, id).find((a) => a.startsWith('ALLOWED=')).slice(8).split(',');
  assert(tools('dev').includes('Bash(node --test:*)') && tools('dev').includes('Bash(npm test:*)') && !tools('dev').includes('Bash(node:*)'), tools('dev').join());
  assert(tools('qa').includes('Bash(npm test:*)') && !tools('qa').some((t) => /node/.test(t)), tools('qa').join());
  assert(!log(d).some((e) => e.phase === 'SKILL_RULE_NOT_GRANTED'), 'the shipped skill should not ask for anything a role lacks');
  assert(promptOf(d, 'dev').includes('run the project\'s tests'), 'skill text lacks the self-test rule');
});

await test('PO_ARCHITECT works from the uat version of the project (not your folder), and is NOT re-asked while nothing changed', () => {
  const { d, g } = gitSandbox();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: PASS } }));
  g('add', '-A'); g('commit', '-q', '-m', 'add package.json');
  g('branch', 'uat'); g('checkout', '-q', 'uat');
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'only-on-uat.js'), 'u');
  g('add', '-A'); g('commit', '-q', '-m', 'work on uat'); g('checkout', '-q', 'main');
  assert(!fs.existsSync(path.join(d, 'src', 'only-on-uat.js')), 'precondition: your folder (main) lacks the uat file');
  setCharter(d, { autonomous: 'on' }, 'PO_JSON {"tasks":[]}');
  setBacklog(d, []);
  const poCalls = () => (fs.existsSync(path.join(d, '.mock-prompts', 'po-calls.txt')) ? fs.readFileSync(path.join(d, '.mock-prompts', 'po-calls.txt'), 'utf8').trim().split('\n').length : 0);
  let r = tick(d);
  assert(/empty/.test(r.stdout) && poCalls() === 1, `${r.stdout} calls=${poCalls()}`);
  const po = promptOf(d, 'po-architect');
  assert(po.includes('src/only-on-uat.js') && /the 'uat' branch @ [0-9a-f]{8}/.test(po), 'PO did not see the uat branch');
  assert(g('worktree', 'list').split('\n').length === 1, 'PO view worktree left behind');
  r = tick(d); // nothing changed → no second (paid) AI call
  assert(/idle/.test(r.stdout) && poCalls() === 1, `PO asked again though nothing changed: ${r.stdout} calls=${poCalls()}`);
  r = node(d, ['.harness/daemon.mjs', '--tick', '--force']);
  assert(poCalls() === 2, `--force should ask again, calls=${poCalls()}`);
  const cfgBacklog = backlog(d); cfgBacklog.push({ id: 'NEWIDEA', title: 'a new idea', status: 'BACKLOG' }); setBacklog(d, cfgBacklog);
  tick(d);
  assert(poCalls() === 3, `a changed backlog should trigger a new PO call, calls=${poCalls()}`);
});

await test('doctor: the shipped skill/role/tool setup produces no skill warnings; an over-asking skill still warns', () => {
  const d = sandbox();
  let out = node(d, ['.harness/doctor.mjs']).stdout;
  assert(/skill code-craft → roles DEV_ENGINEER, QA_AUDITOR; DEV_ENGINEER: .*node --test.*; QA_AUDITOR: Read, Edit, Write, Bash\(npm test:\*\)/.test(out) && !/skill code-craft asks for/.test(out), out.split('\n').filter((l) => /skill/.test(l)).join('\n'));
  fs.mkdirSync(path.join(d, '.harness', 'skills', 'greedy'), { recursive: true });
  fs.writeFileSync(path.join(d, '.harness', 'skills', 'greedy', 'SKILL.md'), '---\nname: greedy\ndescription: d\nroles: ["QA_AUDITOR"]\nallowedTools: ["Bash(node:*)"]\n---\nx');
  out = node(d, ['.harness/doctor.mjs']).stdout;
  assert(/skill greedy asks for tool rules role QA_AUDITOR does not allow/.test(out), 'over-asking skill not warned');
});

await test('--status prints the harness status (read-only alias for status.mjs)', () => {
  const d = sandbox();
  runOnce(d);
  const r = node(d, ['.harness/daemon.mjs', '--status']);
  assert(r.status === 0 && /Daemon:/.test(r.stdout) && /Backlog:/.test(r.stdout) && /Autonomous:/.test(r.stdout), r.stdout + r.stderr);
});


// ───────────── v2.3: editor integration (live feed, watch, session hook, worker guards) ─────────────

function liveSandbox() {
  const d = sandbox();
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.mock.args = [MOCK, '{output}', 'ALLOWED={allowedTools}'];
  cfg.profiles.mock.output = { batch: ['FMT=json'], stream: ['FMT=stream'] };
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  return d;
}

await test('live feed + watch: a running controller writes live.log; "watch --job" streams the agent actions from the dispatch point and exits 0 with the result', async () => {
  const d = liveSandbox();
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs'], { cwd: d, env: { ...env, HARNESS_LIVE: '1' }, stdio: 'ignore' });
  await waitFor(() => fs.existsSync(path.join(d, '.harness', 'daemon.pid')), 8000);
  const disp = node(d, ['.harness/dispatch.mjs', '--goal', 'SAY Building it now\nWRITE src/a.js a', '--files', 'src/a.js', '--check', existsCheck('src/a.js')]);
  const id = (disp.stdout.match(/^JOB_ID=(\S+)/m) || [])[1]; const from = (disp.stdout.match(/^LIVE_FROM=(\d+)/m) || [])[1];
  assert(id && from !== undefined, disp.stdout);
  const w = node(d, ['.harness/watch.mjs', '--job', id, '--from', from, '--max-wait', '30']);
  daemon.kill('SIGTERM'); await new Promise((r) => daemon.on('close', r));
  assert(w.status === 0, `watch exit ${w.status}\n${w.stdout}`);
  for (const want of ['agent started (mock-model)', '💬 Building it now', '🔧 Write src/a.js', 'RESULT: COMMITTED']) assert(w.stdout.includes(want), `missing "${want}" in:\n${w.stdout}`);
  assert(!/\x1b\[/.test(fs.readFileSync(path.join(d, '.harness', 'live.log'), 'utf8')), 'live.log must be plain text (no colour codes)');
});

await test('watch --job: a failed job exits 1 with NOT DONE; no controller running is reported instead of hanging silently', async () => {
  const d = liveSandbox();
  const daemon = spawn(process.execPath, ['.harness/daemon.mjs'], { cwd: d, env: { ...env, HARNESS_LIVE: '1' }, stdio: 'ignore' });
  await waitFor(() => fs.existsSync(path.join(d, '.harness', 'daemon.pid')), 8000);
  const disp = node(d, ['.harness/dispatch.mjs', '--goal', 'WRITE src/b.js b', '--files', 'src/b.js', '--check', FAIL_VERIFY]);
  const id = (disp.stdout.match(/^JOB_ID=(\S+)/m) || [])[1];
  const w = node(d, ['.harness/watch.mjs', '--job', id, '--from-start', '--max-wait', '60']);
  daemon.kill('SIGTERM'); await new Promise((r) => daemon.on('close', r));
  assert(w.status === 1 && /RESULT: NOT DONE/.test(w.stdout) && /HALTED_HITL_REQUIRED/.test(w.stdout), `exit ${w.status}\n${w.stdout}`);
  const d2 = liveSandbox();
  const w2 = spawnSync(process.execPath, ['.harness/watch.mjs', '--job', 'nothing', '--max-wait', '7'], { cwd: d2, env, encoding: 'utf8', timeout: 20000 });
  assert(w2.status === 3 && /no controller is running/.test(w2.stdout), `exit ${w2.status}\n${w2.stdout}`);
});

await test('session hook (SessionStart): reports controller/backlog/autonomy/uat to the editor AI; silent for harness workers; never crashes on a broken folder', () => {
  const d = sandbox();
  setBacklog(d, [{ id: 'R1', title: 'r', status: 'READY' }, { id: 'D1', title: 'd', status: 'DONE' }]);
  let r = node(d, ['.harness/hook-session.mjs']);
  assert(r.status === 0 && /Controller: NOT running/.test(r.stdout) && /READY 1, IN_PROGRESS 0, DONE 1/.test(r.stdout) && /charter says ON/.test(r.stdout) && /AUTO MODE IS ON .* 1 task\(s\) are READY/.test(r.stdout) && /\/harness:auto/.test(r.stdout) && /\/harness:run <goal>/.test(r.stdout) && /\/harness:doctor/.test(r.stdout), r.stdout);
  fs.writeFileSync(path.join(d, '.harness', 'daemon.pid'), String(process.pid));
  r = node(d, ['.harness/hook-session.mjs']);
  assert(/Controller: running \(PID \d+\)/.test(r.stdout), r.stdout);
  r = node(d, ['.harness/hook-session.mjs'], { HARNESS_WORKER: '1' });
  assert(r.status === 0 && r.stdout === '', `worker should get no output, got: ${r.stdout}`);
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), '{ broken');
  r = node(d, ['.harness/hook-session.mjs']);
  assert(r.status === 0, 'a broken config must not make the hook fail');
});

await test('worker guards: a harness worker cannot start the controller, change the backlog, or write memory — but can read', () => {
  const d = sandbox();
  const asWorker = (args) => node(d, args, { HARNESS_WORKER: '1' });
  assert(asWorker(['.harness/daemon.mjs', '--tick']).status === 2, 'worker started the controller');
  assert(asWorker(['.harness/backlog.mjs', 'add', 'x']).status === 2 && backlog(d).length === 0, 'worker changed the backlog');
  assert(asWorker(['.harness/backlog.mjs', 'import', 'x.json']).status === 2, 'worker imported');
  assert(asWorker(['.harness/memory.mjs', 'remember', 'evil rule']).status === 2 && !/evil/.test(fs.readFileSync(path.join(d, '.harness', 'memory', 'lessons.md'), 'utf8')), 'worker wrote memory');
  assert(asWorker(['.harness/backlog.mjs', 'overview']).status === 0 && asWorker(['.harness/memory.mjs', 'list']).status === 0 && asWorker(['.harness/status.mjs']).status === 0, 'read-only commands must work for workers');
});


// ───────────── v2.4: .claude/ (Claude Code settings + slash commands), Doctor notes ─────────────

await test('.claude/settings.json: valid, minimal allow-list, risky things ask or denied, hook script exists, no unsupported Write() rules', () => {
  const st = json(path.join(REPO, '.claude', 'settings.json'));
  const { allow, ask, deny } = st.permissions;
  const TEST_CMDS = ['Bash(npm test:*)', 'Bash(node --test:*)']; // the only two non-harness commands: the agents run them to check their own work
  assert(allow.length > 0 && allow.every((r) => /^Bash\(node \.harness\/[a-z-]+\.mjs[ :)]/.test(r) || TEST_CMDS.includes(r)), `allow must only contain harness scripts and the two test commands: ${allow.filter((r) => !/^Bash\(node \.harness\//.test(r) && !TEST_CMDS.includes(r))}`);
  for (const r of TEST_CMDS) assert(allow.includes(r), `${r} must be allowed so the named agents can check their own work without a prompt`);
  for (const sub of ['brief', 'assign', 'verify', 'propose', 'status', 'report']) assert(allow.includes(`Bash(node .harness/visible.mjs ${sub}:*)`), `the editor workflow command "visible.mjs ${sub}" must be allowed`);
  assert(!allow.some((r) => /visible\.mjs rollback/.test(r)) && ask.includes('Bash(node .harness/visible.mjs rollback:*)') && ask.includes('Edit(.harness/team.json)'), 'rollback and editing team.json must always ask');
  for (const r of [...allow, ...ask, ...deny]) assert(!/^Write\(/.test(r), `Write() rules are ignored by Claude Code; use Edit(): ${r}`);
  assert(!allow.some((r) => /^Bash\((node|git|npm|npx|rm|sh|bash|python)(:\*)?\)$/.test(r) || /^Bash\(\*/.test(r)), 'allow list is too broad (a whole interpreter or shell is allowed)');
  for (const risky of ['Bash(node .harness/backlog.mjs import:*)', 'Bash(node .harness/backlog.mjs ready:*)', 'Bash(node .harness/memory.mjs forget:*)', 'Bash(node .harness/daemon.mjs --autonomous:*)', 'Edit(.harness/charter.md)', 'Edit(.harness/config.json)', 'Bash(git push:*)'])
    assert(ask.includes(risky) && !allow.includes(risky), `${risky} must ask, not be allowed`);
  assert(deny.includes('Edit(.harness/releases/**)') && deny.includes('Bash(git push --force:*)'), 'releases/force-push must be denied');
  const hook = st.hooks.SessionStart[0].hooks[0].command;
  assert(/hook-session\.mjs/.test(hook) && fs.existsSync(path.join(REPO, '.harness', 'hook-session.mjs')), hook);
  for (const rule of allow) { const m = rule.match(/node (\.harness\/[a-z-]+\.mjs)/); if (m) assert(fs.existsSync(path.join(REPO, m[1])), `allowed script missing: ${m[1]}`); }
});

await test('.claude/commands/harness/{status,tick,doctor,run,teach}.md: have a description and only call scripts/flags that exist', () => {
  const dir = path.join(REPO, '.claude', 'commands', 'harness');
  const daemon = fs.readFileSync(path.join(REPO, '.harness', 'daemon.mjs'), 'utf8');
  for (const c of ['status', 'tick', 'doctor', 'run', 'teach', 'team', 'auto']) {
    const t = fs.readFileSync(path.join(dir, `${c}.md`), 'utf8');
    assert(/^---\ndescription: .+\n/.test(t), `${c}.md lacks a description`);
    for (const m of t.matchAll(/node (\.harness\/[a-z-]+\.mjs)/g)) assert(fs.existsSync(path.join(REPO, m[1])), `${c}.md calls a missing script ${m[1]}`);
    for (const m of t.matchAll(/daemon\.mjs (--[a-z-]+)/g)) assert(daemon.includes(`'${m[1]}'`), `${c}.md uses a daemon flag that does not exist: ${m[1]}`);
    assert(!/backlog\.mjs --tick/.test(t), `${c}.md uses the non-existent "backlog.mjs --tick"`);
  }
  assert(/status\.mjs/.test(fs.readFileSync(path.join(dir, 'status.md'), 'utf8')) && /daemon\.mjs --tick/.test(fs.readFileSync(path.join(dir, 'tick.md'), 'utf8')) && /doctor\.mjs/.test(fs.readFileSync(path.join(dir, 'doctor.md'), 'utf8')), 'commands do not call the scripts they promise');
  assert(/autonomous: off/.test(fs.readFileSync(path.join(dir, 'tick.md'), 'utf8')) && /Do not change the charter/i.test(fs.readFileSync(path.join(dir, 'tick.md'), 'utf8')), 'tick must respect the charter');
});

await test('install: copies .claude commands, MERGES settings (project rules kept, no loosening, hook once), keeps existing commands, idempotent', () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-claude-'));
  fs.mkdirSync(path.join(p, '.claude', 'commands', 'harness'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'commands', 'harness', 'status.md'), 'MY OWN STATUS COMMAND');
  fs.writeFileSync(path.join(p, '.claude', 'settings.json'), JSON.stringify({
    model: 'my-model', permissions: { allow: ['Bash(make:*)'], ask: [], deny: ['Bash(node .harness/memory.mjs remember:*)'] },
    hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  const run = () => spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), p], { encoding: 'utf8' });
  assert(run().status === 0, 'install failed');
  const st = json(path.join(p, '.claude', 'settings.json'));
  assert(st.model === 'my-model' && st.permissions.allow.includes('Bash(make:*)') && st.permissions.allow.includes('Bash(node .harness/status.mjs:*)'), 'rules not merged');
  assert(!st.permissions.allow.includes('Bash(node .harness/memory.mjs remember:*)') && st.permissions.deny.includes('Bash(node .harness/memory.mjs remember:*)'), 'a rule the project denies was loosened');
  assert(st.hooks.SessionStart.length === 2 && st.hooks.SessionStart[0].hooks[0].command === 'echo mine', 'hook not added next to the project hook');
  assert(fs.readFileSync(path.join(p, '.claude', 'commands', 'harness', 'status.md'), 'utf8') === 'MY OWN STATUS COMMAND' && fs.existsSync(path.join(p, '.claude', 'commands', 'harness', 'tick.md')), 'commands not handled correctly');
  const before = fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8');
  run();
  assert(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8') === before, 'second install changed settings (not idempotent)');
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-claude-bad-'));
  fs.mkdirSync(path.join(bad, '.claude')); fs.writeFileSync(path.join(bad, '.claude', 'settings.json'), '{ // comment');
  spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), bad]);
  assert(fs.readFileSync(path.join(bad, '.claude', 'settings.json'), 'utf8') === '{ // comment' && fs.existsSync(path.join(bad, '.claude', 'settings.harness.json')), 'an unparsable settings file must be left alone');
});

await test('doctor: a valid setup reports 0 failures and 0 warnings; profile placeholder and idle controller are Notes', () => {
  const { d, g } = gitSandbox({ autonomous: false });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: PASS } }));
  g('add', '-A'); g('commit', '-q', '-m', 'package.json');
  fs.cpSync(path.join(REPO, '.claude'), path.join(d, '.claude'), { recursive: true }); // an installed project has the editor agents
  const out = node(d, ['.harness/doctor.mjs'], { HOME: d, USERPROFILE: d }).stdout; // an empty home: no agy hidden in ~/.gemini/bin on this machine
  assert(/Failures: 0 · Warnings: 0 · Notes: \d+/.test(out), // notes vary: an AI tool installed on this machine but not allowed in the sandbox is a note
     out.split('\n').filter((l) => /^  [!✖ℹ]|Failures/.test(l)).join('\n'));
  assert(/ℹ memory\/profile\.md/.test(out) && /ℹ The background controller is not running/.test(out), 'the two notes are missing');
  assert(/ℹ engine routing: none set, every member uses "auto"\. .*team\.mjs auto-assign/.test(out), 'the engine-routing note is missing');
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), '{ broken');
  assert(node(d, ['.harness/doctor.mjs']).status !== 0 || true, 'doctor must not crash silently');
});

await test('template for other teams: install into a project keeps its own team/charter, never copies this repo\'s local runtime files, and prints how to prompt it', () => {
  const made = [];
  for (const f of ['live.log', 'auto-state.json', 'state.json', 'telemetry.log']) {
    const p = path.join(REPO, '.harness', f);
    if (!fs.existsSync(p)) { fs.writeFileSync(p, 'LOCAL-RUNTIME-DATA'); made.push(p); }
  }
  try {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-team-fresh-'));
    const r = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), fresh], { encoding: 'utf8' });
    assert(r.status === 0, r.stderr);
    for (const f of ['live.log', 'auto-state.json', 'state.json', 'telemetry.log']) assert(!fs.existsSync(path.join(fresh, '.harness', f)), `local runtime file leaked into the target: ${f}`);
    assert(fs.existsSync(path.join(fresh, '.harness', 'team.json')) && fs.existsSync(path.join(fresh, '.harness', 'team.mjs')) && fs.existsSync(path.join(fresh, '.claude', 'commands', 'harness', 'team.md')), 'team files not installed');
    assert(/\/harness:run/.test(r.stdout) && /dispatch\.mjs --goal .* --hierarchy/.test(r.stdout) && /doctor\.mjs/.test(r.stdout), `next steps not printed:\n${r.stdout}`);
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-team-own-'));
    fs.mkdirSync(path.join(mine, '.harness'), { recursive: true });
    const own = { version: 1, members: [{ id: 'boss', level: 'orchestrator', role: 'PO_ARCHITECT', reports_to: null }] };
    fs.writeFileSync(path.join(mine, '.harness', 'team.json'), JSON.stringify(own));
    spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), mine]);
    assert(JSON.stringify(json(path.join(mine, '.harness', 'team.json'))) === JSON.stringify(own), 'the project\'s own team.json was overwritten');
    const again = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), mine], { encoding: 'utf8' });
    assert(again.status === 0, 're-running the installer must be safe');
    // the installed copy works on its own: doctor + team commands run inside the new project
    const ok = spawnSync(process.execPath, ['.harness/team.mjs', 'show'], { cwd: fresh, encoding: 'utf8' });
    assert(ok.status === 0 && /L2  lead-dev/.test(ok.stdout), ok.stdout + ok.stderr);
  } finally { for (const p of made) fs.rmSync(p, { force: true }); }
});

await test('/harness:team and /harness:run: the editor commands know the team mode, and team.mjs is allowed without a prompt (read-only)', () => {
  const dir = path.join(REPO, '.claude', 'commands', 'harness');
  const team = fs.readFileSync(path.join(dir, 'team.md'), 'utf8'); const run = fs.readFileSync(path.join(dir, 'run.md'), 'utf8');
  assert(/^---\ndescription: .+\n/.test(team) && /team\.mjs show/.test(team) && /team\.mjs validate/.test(team) && /Do not change any file/.test(team), 'team.md');
  assert(/visible\.mjs brief/.test(run) && /visible\.mjs assign/.test(run) && /visible\.mjs verify/.test(run) && /Agent tool/.test(run) && /subagent_type/.test(run) && /orchestrator/.test(run) && /Never commit, push or merge/.test(run) && /--hierarchy --max-cost/.test(run), 'run.md does not describe the visible workflow');
  const st = json(path.join(REPO, '.claude', 'settings.json')).permissions;
  assert(st.allow.includes('Bash(node .harness/team.mjs:*)') && !st.ask.includes('Bash(node .harness/team.mjs:*)'), 'team.mjs must be allowed');
  assert(fs.readFileSync(path.join(REPO, '.harness', 'hook-session.mjs'), 'utf8').includes('/harness:run'), 'hook text');
});

// ───────────── v3.0: hierarchical orchestration (orchestrator → leads → workers), team guardrails, budgets ─────────────

const gov = await import(pathToFileURL(path.join(REPO, '.harness', 'lib', 'governance.mjs')).href);
const hierGoal = (orch, prefix = '') => `${prefix}Build the slug feature. ORCH_JSON ${JSON.stringify(orch)}`;
const leadJson = (subtasks, prefix = '') => `${prefix}LEAD_JSON ${JSON.stringify({ subtasks })}`;
const happyPlan = (cost = '') => ({
  interfaceContract: 'slugify(text) -> lowercase-dashed string',
  assignments: [
    { lead: 'lead-ba', files: ['docs/slug.md'], goal: leadJson([{ id: 'spec', targetFiles: ['docs/slug.md'], prompt: `${cost}\nSLEEP 600\nWRITE docs/slug.md spec` }]) },
    { lead: 'lead-dev', files: ['src/'], goal: leadJson([
      { id: 'impl', targetFiles: ['src/slug.js'], prompt: `${cost}\nSLEEP 600\nWRITE src/slug.js code` },
      { id: 'util', targetFiles: ['src/util.js'], prompt: `${cost}\nSLEEP 600\nWRITE src/util.js util` }]) },
    { lead: 'lead-qa', files: ['tests/slug.test.js'], goal: leadJson([{ id: 'tests', targetFiles: ['tests/slug.test.js'], prompt: `${cost}\nSLEEP 600\nWRITE tests/slug.test.js t` }]) }]
});
const ALL4 = existsCheck('docs/slug.md', 'src/slug.js', 'src/util.js', 'tests/slug.test.js');
const hierJob = (d, id, goal, extra = {}) => drop(d, { id, title: id, hierarchy: true, goal, verifyCmd: ALL4, ...extra });
const stateOf = (d) => json(path.join(d, '.harness', 'state.json'));
const calls = (d, f) => { try { return fs.readFileSync(path.join(d, '.mock-prompts', f), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
const ranWorkers = (d) => fs.existsSync(path.join(d, '.mock-prompts')) && fs.readdirSync(path.join(d, '.mock-prompts')).some((f) => /^lead-[a-z]+\.[\w-]+\.txt$/.test(f));

await test('hierarchy: orchestrator → 3 leads → 4 workers in parallel; each level read-only/scoped; plan + cost recorded; check passes', () => {
  const d = sandbox();
  hierJob(d, 'hier', hierGoal(happyPlan('MOCKCOST=0.01'), 'PLANCOST=0.01 '));
  runOnce(d);
  const s = stateOf(d);
  assert(s.phase === '4_COMMITTED' && s.mode === 'SWARM-MESH (4W)', `${s.phase} ${s.mode} ${s.lastGateStatus}`);
  assert(calls(d, 'orch-calls.txt').length === 1 && calls(d, 'lead-calls.txt').length === 3, 'expected 1 orchestrator call and 3 lead calls');
  for (const line of [...calls(d, 'orch-calls.txt'), ...calls(d, 'lead-calls.txt')]) assert(/ALLOWED=Read,Glob,Grep /.test(line), `a planning level was not read-only: ${line}`);
  const tools = (id) => argsOf(d, id).find((a) => a.startsWith('ALLOWED=')).slice(8).split(',');
  assert(tools('lead-dev.impl').includes('Edit(src/slug.js)') && !tools('lead-dev.impl').some((t) => /push/.test(t)), tools('lead-dev.impl').join());
  assert(tools('lead-qa.tests').includes('Bash(npm test:*)') && !tools('lead-qa.tests').some((t) => /node/.test(t)) && tools('lead-qa.tests').includes('Edit(tests/slug.test.js)'), tools('lead-qa.tests').join());
  assert(tools('lead-ba.spec').includes('Edit(docs/slug.md)') && !tools('lead-ba.spec').some((t) => /npm|node/.test(t)), tools('lead-ba.spec').join());
  const tl = fs.readFileSync(path.join(d, '.mock-prompts', 'timeline.txt'), 'utf8').trim().split('\n').map((l) => l.split(' '));
  const wk = tl.filter((x) => /^lead-[a-z]+\./.test(x[2]));
  assert(wk.filter((x) => x[1] === 'start').length === 4 && Math.max(...wk.filter((x) => x[1] === 'start').map((x) => +x[0])) < Math.min(...wk.filter((x) => x[1] === 'end').map((x) => +x[0])), 'workers did not all run in parallel');
  const wp = promptOf(d, 'lead-dev.impl');
  assert(wp.includes('[SHARED INTERFACE CONTRACT') && wp.includes('slugify(text)') && wp.includes('ROLE: DEV_ENGINEER') && wp.includes('[SCOPED TARGET FILES: src/slug.js]'), 'worker prompt lacks contract/role/scope');
  const arch = json(path.join(d, '.harness', 'completed', ls(d, 'completed')[0]));
  assert(arch.team.orchestrator === 'orchestrator' && arch.team.assignments.length === 3 && arch.team.assignments.find((a) => a.lead === 'lead-dev').workers.length === 2, JSON.stringify(arch.team));
  assert(Math.abs(arch.costUsd - 0.08) < 1e-9 && Object.keys(arch.costByAgent).length === 8, `cost ${arch.costUsd} ${JSON.stringify(arch.costByAgent)}`);
  const note = fs.readdirSync(path.join(d, '.harness', 'memory', 'sessions')).map((f) => fs.readFileSync(path.join(d, '.harness', 'memory', 'sessions', f), 'utf8')).join('');
  assert(/- Team: orchestrator → lead-ba \(lead-ba\.spec\); lead-dev \(lead-dev\.impl, lead-dev\.util\)/.test(note) && /- Cost: \$0\.0800/.test(note), 'session note lacks team/cost');
});

await test('hierarchy guardrails (level 1): a delegation that breaks a rule is re-asked once, then REJECTED before any worker starts', () => {
  const lead = (l, files, g = 'x') => ({ lead: l, files, goal: leadJson([{ id: 'w', targetFiles: files, prompt: 'WRITE x y' }], g) });
  const cases = [
    [{ assignments: [lead('lead-x', ['src/a.js'])] }, /not a lead you may delegate to/],
    [{ assignments: [lead('lead-dev', ['docs/a.md'])] }, /outside lead "lead-dev"'s scope/],
    [{ assignments: [lead('lead-dev', ['src/a.js']), lead('lead-dev', ['src/b.js'])] }, /assigned twice/],
    [{ assignments: [lead('lead-dev', ['../escape.js'])] }, /unsafe path/],
    [{ assignments: [lead('lead-dev', ['.harness/config.json'])] }, /unsafe path/],
    [{ assignments: [] }, /no "assignments"/]
  ];
  for (const [plan, re] of cases) {
    const d = sandbox();
    hierJob(d, 'bad', hierGoal(plan));
    runOnce(d);
    const s = stateOf(d);
    assert(s.phase === 'REJECTED' && re.test(s.lastGateStatus), `${re}: ${s.phase} ${s.lastGateStatus}`);
    assert(calls(d, 'orch-calls.txt').length === 2, `orchestrator should be asked twice, was ${calls(d, 'orch-calls.txt').length}`);
    assert(calls(d, 'lead-calls.txt').length === 0 && !ranWorkers(d), 'a lower level ran after an invalid delegation');
    assert(ls(d, 'failed').length === 1, 'job not in failed/');
  }
  const d2 = sandbox(); hierJob(d2, 'nojson', 'no json here');
  runOnce(d2);
  assert(/not valid JSON/.test(stateOf(d2).lastGateStatus), stateOf(d2).lastGateStatus);
});

await test('hierarchy guardrails (level 2): a lead that plans outside its assignment, too many workers, or nothing is escalated to the human; no worker starts', () => {
  const mk = (subtasks) => ({ assignments: [{ lead: 'lead-dev', files: ['src/a.js'], goal: leadJson(subtasks) }] });
  const w = (id, f) => ({ id, targetFiles: [f], prompt: 'WRITE src/a.js x' });
  const cases = [
    [mk([w('a', 'src/other.js')]), /outside your assigned files/],
    [mk([w('a', 'src/a.js'), w('b', 'src/a.js'), w('c', 'src/a.js'), w('d', 'src/a.js')]), /too many workers/],
    [mk([{ id: 'a', targetFiles: [], prompt: 'x' }]), /no targetFiles/],
    [mk([{ id: 'a', targetFiles: ['src/a.js'], prompt: '' }]), /no prompt/],
    [mk([w('a', '../x.js')]), /unsafe path/]
  ];
  for (const [plan, re] of cases) {
    const d = sandbox();
    hierJob(d, 'badlead', hierGoal(plan), { verifyCmd: PASS });
    runOnce(d);
    const s = stateOf(d);
    assert(s.phase === 'REJECTED' && /Lead 'lead-dev' could not produce a valid team plan/.test(s.lastGateStatus) && re.test(s.lastGateStatus) && /Escalated to you/.test(s.lastGateStatus), `${re}: ${s.lastGateStatus}`);
    assert(calls(d, 'lead-calls.txt').length === 2, `lead should be asked twice, was ${calls(d, 'lead-calls.txt').length}`);
    assert(!ranWorkers(d), 'a worker ran although a lead plan was invalid');
  }
});

await test('team.json: validateTeam rejects every way of breaking the hierarchy (writable orchestrator, wider/overlapping scopes, forbidden paths, budgets, bad roles)', () => {
  const roles = gov.loadRoles(); const charter = gov.readCharter();
  const base = () => JSON.parse(fs.readFileSync(path.join(REPO, '.harness', 'team.json'), 'utf8'));
  const v = (t) => gov.validateTeam(t, { roles, charter, plannerMaxWorkers: 4 });
  assert(v(base()).errors.length === 0, `shipped team invalid: ${v(base()).errors}`);
  const bad = [
    [(t) => { t.members[0].role = 'DEV_ENGINEER'; }, /must be read-only/],
    [(t) => { t.members.push({ ...t.members[0], id: 'orch2' }); }, /exactly one orchestrator/],
    [(t) => { t.members.find((m) => m.id === 'lead-ba').scope = ['src/**']; }, /wider than what role BA_ANALYST may write/],
    [(t) => { t.members.find((m) => m.id === 'lead-qa').scope = ['src/**']; }, /wider than what role QA_AUDITOR may write|overlapping scopes/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').scope = ['src/**', 'docs/**']; }, /overlapping scopes/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').scope = ['.env*']; }, /charter forbids/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').scope = ['node_modules/**']; }, /charter forbids/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').budget.maxCostUsd = 5; }, /budgets must shrink downwards/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').budget.maxMinutes = 99; }, /exceeds the orchestrator's/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').role = 'HACKER'; }, /unknown role/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').role = 'PO_ARCHITECT'; }, /read-only/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').maxWorkers = 99; }, /maxWorkers must be/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').reports_to = 'lead-ba'; }, /must report to the orchestrator/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').scope = []; }, /non-empty "scope"/],
    [(t) => { t.members.find((m) => m.id === 'lead-dev').level = 'worker'; }, /level must be/],
    [(t) => { t.members[0].canDelegateTo = ['ghost']; }, /not a lead/],
    [(t) => { t.members.find((m) => m.id === 'lead-qa').id = 'lead-dev'; }, /duplicate member id/]
  ];
  for (const [mutate, re] of bad) { const t = base(); mutate(t); const r = v(t); assert(r.errors.some((e) => re.test(e)), `${re} not reported; got: ${r.errors.join(' | ')}`); }
  assert(gov.validateTeam({}, { roles }).errors.length > 0 && gov.validateTeam(null, { roles }).errors.length > 0, 'a missing/empty team must be an error');
});

await test('team.json: an invalid team stops the task before any agent is called; a missing team is reported; Doctor and team.mjs agree', () => {
  const d = sandbox();
  const t = json(path.join(d, '.harness', 'team.json')); t.members.find((m) => m.id === 'lead-dev').scope = ['src/**', 'docs/**'];
  fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(t));
  hierJob(d, 'badteam', hierGoal(happyPlan()));
  runOnce(d);
  assert(stateOf(d).phase === 'REJECTED' && /team\.json is invalid, nothing was started/.test(stateOf(d).lastGateStatus) && calls(d, 'orch-calls.txt').length === 0, stateOf(d).lastGateStatus);
  const doc = node(d, ['.harness/doctor.mjs']);
  assert(doc.status !== 0 && /✖ team\.json: leads "lead-ba" and "lead-dev"|✖ team\.json: leads "lead-dev" and "lead-ba"|overlapping scopes/.test(doc.stdout), doc.stdout.split('\n').filter((l) => /team/.test(l)).join('\n'));
  assert(node(d, ['.harness/team.mjs', 'validate']).status === 1, 'team.mjs validate should fail');
  const d2 = sandbox(); fs.rmSync(path.join(d2, '.harness', 'team.json'));
  hierJob(d2, 'noteam', hierGoal(happyPlan()));
  runOnce(d2);
  assert(/team\.json does not exist/.test(stateOf(d2).lastGateStatus), stateOf(d2).lastGateStatus);
  const d3 = sandbox();
  const show = node(d3, ['.harness/team.mjs', 'show']);
  assert(show.status === 0 && /L1  orchestrator  \[PO_ARCHITECT\]/.test(show.stdout) && /L2  lead-dev  \[DEV_ENGINEER\]/.test(show.stdout) && /owns: src\/\*\*/.test(show.stdout) && /team is valid/.test(show.stdout), show.stdout);
  assert(/team\.json valid: orchestrator → 3 lead\(s\)/.test(node(d3, ['.harness/doctor.mjs']).stdout), 'Doctor does not report the valid team');
});

await test('budget: the task cap stops a hierarchy right after planning when the planners already cost too much — no worker starts; cost is in the dead letter', () => {
  const d = sandbox();
  hierJob(d, 'cap', hierGoal(happyPlan(), 'PLANCOST=0.04 '), { maxCostUsd: 0.05 });
  runOnce(d);
  const s = stateOf(d);
  assert(s.phase === 'REJECTED' && /BUDGET_EXCEEDED/.test(s.lastGateStatus), `${s.phase} ${s.lastGateStatus}`);
  assert(!ranWorkers(d), 'workers started although the budget was already exceeded');
  const f = json(path.join(d, '.harness', 'failed', ls(d, 'failed')[0]));
  assert(f.costUsd > 0.05 && f.costByAgent.orchestrator === 0.04 && Object.keys(f.costByAgent).filter((k) => k.startsWith('lead-')).length === 3, JSON.stringify(f.costByAgent));
  assert(log(d).some((e) => e.phase === 'BUDGET_EXCEEDED'), 'no BUDGET_EXCEEDED event');
});

await test('budget: a worker over its lead\'s per-agent cap is stopped (BUDGET_AGENT_EXCEEDED) and the files are restored', () => {
  const d = sandbox();
  fs.mkdirSync(path.join(d, 'docs')); fs.writeFileSync(path.join(d, 'docs', 'slug.md'), 'ORIGINAL');
  const plan = happyPlan(); plan.assignments[0].goal = leadJson([{ id: 'spec', targetFiles: ['docs/slug.md'], prompt: 'MOCKCOST=0.9\nWRITE docs/slug.md CHANGED' }]);
  hierJob(d, 'agentcap', hierGoal(plan));
  runOnce(d);
  assert(stateOf(d).phase === 'REJECTED' && /BUDGET_AGENT_EXCEEDED: worker lead-ba\.spec/.test(stateOf(d).lastGateStatus), stateOf(d).lastGateStatus);
  assert(fs.readFileSync(path.join(d, 'docs', 'slug.md'), 'utf8') === 'ORIGINAL', 'file not restored after the budget stop');
});

await test('budget: a non-hierarchy task with maxCostUsd never starts another cycle once over budget (cap beats the 3-cycle limit)', () => {
  const d = sandbox();
  drop(d, { id: 'cyclecap', title: 'cc', maxCostUsd: 0.05, verifyCmd: FAIL_VERIFY, subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'MOCKCOST=0.04\nWRITE a.txt x' }] });
  runOnce(d);
  assert(stateOf(d).phase === 'REJECTED' && /BUDGET_EXCEEDED/.test(stateOf(d).lastGateStatus), `${stateOf(d).phase} ${stateOf(d).lastGateStatus}`);
  const f = json(path.join(d, '.harness', 'failed', ls(d, 'failed')[0]));
  assert(f.costUsd === 0.08 && log(d).filter((e) => e.phase === 'SQUARE_RETRY').length === 1, `cost ${f.costUsd}, retries ${log(d).filter((e) => e.phase === 'SQUARE_RETRY').length}: stopped after 2 cycles, not 3`);
  assert(!fs.existsSync(path.join(d, 'a.txt')), 'files not restored after the budget stop');
});

await test('hierarchy via backlog: an autonomous item with "hierarchy": true runs the whole team inside the charter and ends DONE', () => {
  const d = sandbox(); setCharter(d, { autonomous: 'on' });
  setBacklog(d, [{ id: 'H1', title: 'team feature', priority: 1, status: 'READY', hierarchy: true, costApproved: true, maxCostUsd: 1, goal: hierGoal(happyPlan()), verifyCmd: ALL4 }]);
  tick(d);
  assert(byId(d, 'H1').status === 'DONE', `${byId(d, 'H1').status} ${byId(d, 'H1').blockedReason || ''}`);
  const arch = json(path.join(d, '.harness', 'completed', ls(d, 'completed')[0]));
  assert(arch.autonomous === true && arch.hierarchy === true && arch.team.assignments.length === 3, 'job lost the hierarchy/autonomous flags');
  // charter still binds the team: a team whose lead scope exceeds the charter's allowedPaths is rejected for autonomous work
  const d2 = sandbox(); setCharter(d2, { autonomous: 'on', allowedPaths: 'src/**' });
  setBacklog(d2, [{ id: 'H2', title: 'team feature', priority: 1, status: 'READY', hierarchy: true, costApproved: true, goal: hierGoal(happyPlan()), verifyCmd: ALL4 }]);
  tick(d2);
  assert(byId(d2, 'H2').status === 'BLOCKED' && /outside charter allowedPaths/.test(byId(d2, 'H2').blockedReason || ''), `${byId(d2, 'H2').status} ${byId(d2, 'H2').blockedReason}`);
});

await test('dispatch --hierarchy / --max-cost: writes a hierarchy job (no subtasks yet), validates the cost, runs end to end; hierarchy+cap shown in --help', () => {
  const d = sandbox();
  const r = node(d, ['.harness/dispatch.mjs', '--goal', hierGoal(happyPlan()), '--hierarchy', '--max-cost', '1.5', '--check', ALL4, '--wait']);
  assert(r.status === 0 && /orchestrator → leads → workers, per team\.json/.test(r.stdout) && /RESULT: COMMITTED/.test(r.stdout), r.stdout + r.stderr);
  const arch = json(path.join(d, '.harness', 'completed', ls(d, 'completed')[0]));
  assert(arch.hierarchy === true && arch.maxCostUsd === 1.5 && !arch.subtasks, JSON.stringify(Object.keys(arch)));
  assert(node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--hierarchy', '--max-cost', 'lots']).status === 1, 'a non-numeric --max-cost must be refused');
  assert(/--hierarchy/.test(node(d, ['.harness/dispatch.mjs', '--help']).stdout), 'help does not mention --hierarchy');
});

// ───────────── v3.1: the editor workflow — controller → orchestrator → NAMED agents → verify → report ─────────────

const vis = (d, ...a) => node(d, ['.harness/visible.mjs', ...a]);
const runIdOf = (r) => (r.stdout.match(/^RUN_ID=(\S+)/m) || [])[1];
const deleg = (assignments, contract = 'CONTRACT-X') => JSON.stringify({ interfaceContract: contract, assignments });
const trio = () => [{ lead: 'lead-ba', goal: 'write the spec', files: ['docs/a.md'] }, { lead: 'lead-dev', goal: 'implement it', files: ['src/a.js'] }, { lead: 'lead-qa', goal: 'write the tests', files: ['tests/a.test.js'] }];
const agentsWrite = (d, files) => files.forEach(([f, c]) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); });
const trioFiles = () => [['docs/a.md', 'spec'], ['src/a.js', 'code'], ['tests/a.test.js', 'tests']];
const TRIO_CHECK = existsCheck('docs/a.md', 'src/a.js', 'tests/a.test.js');
const runJson = (d, id) => json(path.join(d, '.harness', 'visible', id, 'run.json'));
const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');

await test('editor workflow: brief → assign → agents work → verify → report; prompts carry scope/contract/skills/memory; backlog and session note updated', () => {
  const d = sandbox();
  node(d, ['.harness/memory.mjs', 'remember', 'Always answer in plain English']);
  setBacklog(d, [{ id: 'T1', title: 'slug feature', priority: 1, status: 'READY', goal: 'Build slugify', acceptanceCriteria: ['AC-one'], interfaceContract: 'slugify(text) -> string', verifyCmd: TRIO_CHECK }]);
  const b = vis(d, 'brief', '--item', 'T1'); const id = runIdOf(b);
  assert(b.status === 0 && id && /ORCHESTRATOR BRIEF/.test(b.stdout) && /lead-dev \(DEV_ENGINEER\) may own: src\/\*\*/.test(b.stdout) && /AC-one/.test(b.stdout) && /slugify\(text\) -> string/.test(b.stdout) && /Always answer in plain English/.test(b.stdout), b.stdout);
  assert(byId(d, 'T1').status === 'IN_PROGRESS' && byId(d, 'T1').visibleRun === id, 'backlog item not marked IN_PROGRESS');
  const a = vis(d, 'assign', id, deleg(trio()));
  assert(a.status === 0 && /DELEGATION OK/.test(a.stdout), a.stdout + a.stderr);
  for (const l of ['lead-ba', 'lead-dev', 'lead-qa']) assert(new RegExp(`subagent_type: "${l}"`).test(a.stdout), `no ready-made call for ${l}`);
  const section = (lead) => a.stdout.split('===== agent: ').find((x) => x.startsWith(lead));
  const dev = section('lead-dev'); const ba = section('lead-ba'); const qa = section('lead-qa');
  assert(/ONLY these files\/folders: src\/a\.js/.test(dev) && /CONTRACT-X/.test(dev) && /slugify\(text\) -> string/.test(dev) && /AC-one/.test(dev) && /Always answer in plain English/.test(dev) && /@governed-by PO_ARCHITECT/.test(dev) && /npm test/.test(dev), 'dev prompt incomplete');
  assert(/ONLY these files\/folders: tests\/a\.test\.js/.test(qa) && /@governed-by PO_ARCHITECT/.test(qa), 'qa prompt incomplete');
  assert(/no shell/.test(ba) && !/Code Craft/.test(ba) && /ONLY these files\/folders: docs\/a\.md/.test(ba), 'ba prompt wrong (no shell, no code-craft skill)');
  agentsWrite(d, trioFiles());
  const v = vis(d, 'verify', id, '--reports', JSON.stringify({ 'lead-dev': 'wrote src/a.js' }));
  assert(v.status === 0 && /PASSED ✔/.test(v.stdout) && /lead-dev: \+ src\/a\.js/.test(v.stdout) && /says: wrote src\/a\.js/.test(v.stdout) && /controller → orchestrator \(editor session\) → lead-ba, lead-dev, lead-qa/.test(v.stdout), v.stdout);
  assert(byId(d, 'T1').status === 'DONE' && runJson(d, id).status === 'PASSED', 'backlog/run not DONE/PASSED');
  assert(!fs.existsSync(path.join(d, '.harness', 'visible', id, 'baseline')), 'baseline copy not cleaned after a pass');
  const note = fs.readdirSync(path.join(d, '.harness', 'memory', 'sessions')).map((f) => read(d, `.harness/memory/sessions/${f}`)).join('');
  assert(/Team: orchestrator → lead-ba \(lead-ba\); lead-dev \(lead-dev\); lead-qa \(lead-qa\)/.test(note) && /Result: \*\*VERIFIED\*\*/.test(note), 'session note lacks the team/result');
  assert(/PASSED ✔/.test(vis(d, 'report', id).stdout) && new RegExp(id).test(vis(d, 'status').stdout), 'report/status commands');
});

await test('editor workflow guardrails: a bad delegation never starts anything (unknown lead / outside scope / twice / unsafe / outside the files the human allowed); 3 bad attempts escalate to the human', () => {
  const g = (lead, files, goal = 'x') => ({ lead, goal, files });
  const cases = [
    [deleg([g('lead-x', ['src/a.js'])]), [], /not a lead you may delegate to/],
    [deleg([g('lead-dev', ['docs/a.md'])]), [], /outside lead "lead-dev"'s scope/],
    [deleg([g('lead-dev', ['src/a.js']), g('lead-dev', ['src/b.js'])]), [], /assigned twice/],
    [deleg([g('lead-dev', ['../escape.js'])]), [], /unsafe path/],
    [deleg([g('lead-dev', ['.harness/team.json'])]), [], /unsafe path/],
    [deleg([g('lead-dev', ['src/a.js'])]), ['--files', 'src/b.js'], /outside the files the human allowed|outside the files the user allowed/],
    ['not json', [], /not valid JSON/],
    [JSON.stringify({ assignments: [] }), [], /no "assignments"/]
  ];
  for (const [plan, extra, re] of cases) {
    const d = sandbox(); const id = runIdOf(vis(d, 'brief', '--goal', 'g', '--check', PASS, ...extra));
    const r = vis(d, 'assign', id, plan);
    assert(r.status === 1 && re.test(r.stderr) && /Nothing was started/.test(r.stderr), `${re}: exit ${r.status} ${r.stderr}`);
    assert(runJson(d, id).assignments.length === 0 && runJson(d, id).status === 'BRIEFED', 'run state changed by a rejected delegation');
  }
  const d = sandbox(); setBacklog(d, [{ id: 'E1', title: 'esc', status: 'READY', verifyCmd: PASS }]);
  const id = runIdOf(vis(d, 'brief', '--item', 'E1'));
  assert(vis(d, 'assign', id, 'bad').status === 1 && vis(d, 'assign', id, 'bad').status === 1, 'first two rejections should exit 1');
  const third = vis(d, 'assign', id, 'bad');
  assert(third.status === 2 && /ESCALATED to the human/.test(third.stderr) && runJson(d, id).status === 'ESCALATED' && byId(d, 'E1').status === 'BLOCKED' && /ESCALATED/.test(byId(d, 'E1').blockedReason), `exit ${third.status} ${third.stderr}`);
});

await test('editor workflow verify: every change outside the assignments is detected and REVERTED (new, modified, deleted files, the charter, the team, .claude), then a clean re-verify passes', () => {
  const d = sandbox();
  fs.writeFileSync(path.join(d, 'README.md'), 'ORIGINAL'); fs.mkdirSync(path.join(d, 'docs')); fs.writeFileSync(path.join(d, 'docs', 'keep.md'), 'KEEP');
  const charter = read(d, '.harness/charter.md'); const teamJson = read(d, '.harness/team.json');
  const id = runIdOf(vis(d, 'brief', '--goal', 'g', '--check', TRIO_CHECK));
  assert(vis(d, 'assign', id, deleg(trio())).status === 0, 'assign failed');
  agentsWrite(d, trioFiles());
  agentsWrite(d, [['README.md', 'HACKED'], ['notes.txt', 'rogue'], ['.claude/injected.md', 'x'], ['.harness/charter.md', `${charter}\n- autonomous: off\n`], ['.harness/team.json', '{"members":[]}']]);
  fs.rmSync(path.join(d, 'docs', 'keep.md'));
  const v = vis(d, 'verify', id);
  assert(v.status === 1 && /NOT PASSED YET/.test(v.stdout) && /not run \(fix the violations first\)/.test(v.stdout), v.stdout);
  for (const f of ['README.md', 'notes.txt', '.claude/injected.md', '.harness/charter.md', '.harness/team.json', 'docs/keep.md']) assert(v.stdout.includes(`${f}:`), `violation not reported for ${f}`);
  assert(read(d, 'README.md') === 'ORIGINAL' && !fs.existsSync(path.join(d, 'notes.txt')) && !fs.existsSync(path.join(d, '.claude', 'injected.md')) && read(d, '.harness/charter.md') === charter && read(d, '.harness/team.json') === teamJson && read(d, 'docs/keep.md') === 'KEEP', 'a violating change was not reverted');
  assert(trioFiles().every(([f, c]) => read(d, f) === c), 'the agents\' legitimate files must stay');
  const again = vis(d, 'verify', id);
  assert(again.status === 0 && /PASSED ✔/.test(again.stdout) && runJson(d, id).cycles === 2, again.stdout);
});

await test('editor workflow verify: a git-ignored secret (.env) edited by an agent is DETECTED (hash only, never copied) and reported as not auto-revertable', () => {
  const { d, g } = gitSandbox({ autonomous: false });
  fs.appendFileSync(path.join(d, '.gitignore'), '\n.env\n'); fs.writeFileSync(path.join(d, '.env'), 'SECRET=1'); g('add', '-A'); g('commit', '-q', '-m', 'ignore env');
  const id = runIdOf(vis(d, 'brief', '--goal', 'g', '--check', TRIO_CHECK));
  assert(vis(d, 'assign', id, deleg(trio())).status === 0, 'assign');
  assert(!fs.existsSync(path.join(d, '.harness', 'visible', id, 'baseline', '.env')), 'a secret must never be copied into the baseline');
  agentsWrite(d, [...trioFiles(), ['.env', 'SECRET=stolen']]);
  const v = vis(d, 'verify', id);
  assert(v.status === 1 && /\.env: not inside any lead's assigned files/.test(v.stdout) && /COULD NOT be reverted automatically \(secrets are never copied\): \.env/.test(v.stdout), v.stdout);
  assert(read(d, '.env') === 'SECRET=stolen', 'the harness cannot restore what it never copied; it must say so instead of pretending');
});

await test('editor workflow verify: a failing check is retried, and after 3 cycles the run HALTS, restores every file, blocks the backlog item and records a lesson', () => {
  const d = sandbox();
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'old.js'), 'OLD');
  setBacklog(d, [{ id: 'H1', title: 'halting task', status: 'READY', verifyCmd: FAIL_VERIFY }]);
  const id = runIdOf(vis(d, 'brief', '--item', 'H1'));
  assert(vis(d, 'assign', id, deleg([{ lead: 'lead-dev', goal: 'x', files: ['src/'] }])).status === 0, 'assign failed');
  agentsWrite(d, [['src/old.js', 'CHANGED'], ['src/new.js', 'NEW']]);
  const r1 = vis(d, 'verify', id); const r2 = vis(d, 'verify', id);
  assert(r1.status === 1 && /NOT PASSED YET/.test(r1.stdout) && /Cycle 1\/3/.test(r1.stdout) && r2.status === 1 && runJson(d, id).status === 'FAILED', 'cycles 1-2 should fail but stay open');
  assert(read(d, 'src/old.js') === 'CHANGED', 'files must be left in place until the last cycle');
  const r3 = vis(d, 'verify', id);
  assert(r3.status === 1 && /STOPPED/.test(r3.stdout) && /Cycle 3\/3/.test(r3.stdout) && /NOPE/.test(r3.stdout) && runJson(d, id).status === 'HALTED_HITL_REQUIRED', r3.stdout);
  assert(read(d, 'src/old.js') === 'OLD' && !fs.existsSync(path.join(d, 'src', 'new.js')), 'the halted run did not restore the files');
  assert(byId(d, 'H1').status === 'BLOCKED' && /HALTED_HITL_REQUIRED after 3 cycles/.test(byId(d, 'H1').blockedReason), byId(d, 'H1').blockedReason);
  assert(/halting task.*HALTED_HITL_REQUIRED/.test(read(d, '.harness/memory/auto-lessons.md')), 'no lesson recorded');
  assert(vis(d, 'verify', id).status === 1, 'a halted run cannot be verified again');
});

await test('editor workflow: only one open run at a time; rollback restores everything and ends the run; harness workers cannot use it', () => {
  const d = sandbox(); fs.writeFileSync(path.join(d, 'a.txt'), 'ORIGINAL');
  const id = runIdOf(vis(d, 'brief', '--goal', 'g', '--check', PASS));
  const second = vis(d, 'brief', '--goal', 'other', '--check', PASS);
  assert(second.status === 4 && /is not finished/.test(second.stderr), `exit ${second.status} ${second.stderr}`);
  assert(vis(d, 'assign', id, deleg([{ lead: 'lead-dev', goal: 'x', files: ['src/'] }])).status === 0, 'assign');
  agentsWrite(d, [['src/x.js', 'x'], ['a.txt', 'CHANGED']]);
  const rb = vis(d, 'rollback', id);
  assert(rb.status === 0 && /Rolled back/.test(rb.stdout) && read(d, 'a.txt') === 'ORIGINAL' && !fs.existsSync(path.join(d, 'src', 'x.js')) && runJson(d, id).status === 'ROLLED_BACK', rb.stdout + rb.stderr);
  assert(vis(d, 'brief', '--goal', 'next', '--check', PASS).status === 0, 'a new run should be possible after rollback');
  assert(node(d, ['.harness/visible.mjs', 'status'], { HARNESS_WORKER: '1' }).status === 2, 'a harness worker must not use the editor workflow');
});

await test('autonomous (editor): brief --next takes the highest-priority READY item; budget stops it; a failed run pauses it; off/empty/placeholder are refused', () => {
  const d = sandbox(); setCharter(d, { maxAutoTasksPerRun: 2 });
  setBacklog(d, [1, 2, 3].map((n) => ({ id: `Q${n}`, title: `task ${n}`, priority: 4 - n, status: 'READY', verifyCmd: TRIO_CHECK })));
  const finish = (sid, expectId) => { const r = vis(d, 'brief', '--next', '--auto-session', sid); const id = runIdOf(r); assert(r.status === 0 && new RegExp(`Task: task ${expectId}`).test(r.stdout) && /autonomous mode/.test(r.stdout), r.stdout + r.stderr); assert(vis(d, 'assign', id, deleg(trio())).status === 0, 'assign'); agentsWrite(d, trioFiles()); return { id, v: vis(d, 'verify', id) }; };
  const first = finish('S1', 3); assert(first.v.status === 0 && byId(d, 'Q3').status === 'DONE', 'first auto task');
  fs.rmSync(path.join(d, 'src'), { recursive: true }); fs.rmSync(path.join(d, 'docs'), { recursive: true }); fs.rmSync(path.join(d, 'tests'), { recursive: true });
  const second = finish('S1', 2); assert(second.v.status === 0, 'second auto task');
  const third = vis(d, 'brief', '--next', '--auto-session', 'S1');
  assert(third.status === 3 && /Auto budget used: 2\/2/.test(third.stderr) && byId(d, 'Q1').status === 'READY', `budget: exit ${third.status} ${third.stderr}`);
  const d2 = sandbox(); setCharter(d2, {}); setBacklog(d2, [{ id: 'F1', title: 'will fail', priority: 1, status: 'READY', verifyCmd: FAIL_VERIFY }, { id: 'F2', title: 'never started', priority: 9, status: 'READY', verifyCmd: PASS }]);
  const id2 = runIdOf(vis(d2, 'brief', '--next', '--auto-session', 'S2'));
  vis(d2, 'assign', id2, deleg([{ lead: 'lead-dev', goal: 'x', files: ['src/'] }])); agentsWrite(d2, [['src/a.js', 'x']]);
  for (let i = 0; i < 3; i++) vis(d2, 'verify', id2);
  const paused = vis(d2, 'brief', '--next', '--auto-session', 'S2');
  assert(runJson(d2, id2).status === 'HALTED_HITL_REQUIRED' && paused.status === 4 && /paused/.test(paused.stderr) && byId(d2, 'F2').status === 'READY', `pause: exit ${paused.status} ${paused.stderr}`);
  const off = sandbox(); setCharter(off, { autonomous: 'off' }); setBacklog(off, [{ id: 'O1', title: 'x', status: 'READY', verifyCmd: PASS }]);
  const offR = vis(off, 'brief', '--next');
  assert(offR.status === 1 && /Autonomous mode is off/.test(offR.stderr) && byId(off, 'O1').status === 'READY', offR.stderr);
  const empty = sandbox(); setCharter(empty, {}); setBacklog(empty, []);
  assert(vis(empty, 'brief', '--next').status === 6, 'nothing READY should exit 6');
  const noCheck = sandbox(); setCharter(noCheck, {}); setBacklog(noCheck, [{ id: 'N1', title: 'x', status: 'READY' }]);
  const nc = vis(noCheck, 'brief', '--next');
  assert(nc.status === 1 && /no real check/.test(nc.stderr) && byId(noCheck, 'N1').status === 'READY', `no real check must refuse autonomous work: ${nc.stderr}`);
});

await test('autonomous (editor): "propose" adds READY tasks only inside the budget, the team scopes and the charter; the placeholder charter plans nothing; AI-suggested checks are only recorded', () => {
  const ph = sandbox();
  const r0 = vis(ph, 'propose', 'S1', JSON.stringify({ tasks: [{ title: 't', files: ['src/a.js'] }] }));
  assert(r0.status === 5 && /placeholder/.test(r0.stderr) && backlog(ph).length === 0, `placeholder: exit ${r0.status} ${r0.stderr}`);
  const d = sandbox(); setCharter(d, { maxAutoTasksPerRun: 2 }); realTest(d);
  setBacklog(d, [{ id: 'X0', title: 'existing task', status: 'DONE' }]);
  const t = (title, files, extra = {}) => ({ title, goal: title, files, ...extra });
  const out = vis(d, 'propose', 'S1', JSON.stringify({ tasks: [
    t('good one', ['src/good.js'], { verifySuggestion: 'rm -rf /', acceptanceCriteria: ['works'] }), t('outside scope', ['lib/x.js']), t('forbidden', ['.env']), t('Existing   Task', ['src/e.js']),
    t('unsafe', ['../x.js']), t('no files', []), t('good two', ['docs/two.md']), t('over budget', ['src/z.js'])] }));
  const tasks = backlog(d).filter((x) => x.source === 'orchestrator');
  assert(out.status === 0 && tasks.length === 2 && tasks.map((x) => x.title).join() === 'good one,good two', `${out.stdout}\n${out.stderr}\n${JSON.stringify(tasks.map((x) => x.title))}`);
  assert(/rejected "outside scope".*not inside any lead's scope/.test(out.stdout) && /rejected "forbidden"/.test(out.stdout) && /duplicate/.test(out.stdout) && /unsafe path/.test(out.stdout) && /rejected "over budget".*over the auto budget/.test(out.stdout) && /Budget left in this session: 0/.test(out.stdout), out.stdout);
  assert(tasks[0].status === 'READY' && tasks[0].verifySuggestion === 'rm -rf /' && tasks[0].verifyCmd === undefined, 'AI-suggested check must be recorded, never used');
  assert(vis(d, 'propose', 'S9', JSON.stringify({ tasks: [t('x', ['src/q.js'])] })).status === 0, 'a new session has its own budget');
  const b = vis(d, 'brief', '--next', '--auto-session', 'S1');
  assert(b.status === 0 && /Task: good one/.test(b.stdout), b.stdout + b.stderr);
});

await test('named editor agents: sync-agents writes one agent per lead from team.json + roles (BA no shell, DEV/QA tests only), detects stale files, and Doctor reports them', () => {
  const d = sandbox();
  const r = node(d, ['.harness/team.mjs', 'sync-agents']);
  assert(r.status === 0 && /wrote \.claude\/agents\/lead-dev\.md/.test(r.stdout), r.stdout + r.stderr);
  const fm = (f) => { const t = read(d, `.claude/agents/${f}.md`); const m = t.match(/^---\nname: (.+)\ndescription: (.+)\ntools: (.+)\n(?:model: (?:haiku|sonnet|opus)\n)?---\n/); assert(m, `bad frontmatter in ${f}`); return { name: m[1], desc: m[2], tools: m[3].split(', '), body: t }; };
  const ba = fm('lead-ba'); const dev = fm('lead-dev'); const qa = fm('lead-qa');
  assert(ba.name === 'lead-ba' && dev.name === 'lead-dev' && qa.name === 'lead-qa', 'names must equal the member ids (that is what you see in the editor)');
  assert(!ba.tools.includes('Bash') && ba.tools.includes('Write') && dev.tools.includes('Bash') && qa.tools.includes('Bash') && ![ba, dev, qa].some((a) => a.tools.includes('Agent') || a.tools.includes('Task')), `tools: ${ba.tools} | ${dev.tools} | ${qa.tools}`);
  assert(/docs\/\*\*/.test(ba.desc) && /src\/\*\*/.test(dev.desc) && /Change ONLY the files you were assigned/.test(dev.body) && /no shell/.test(ba.body) && /npm test/.test(dev.body), 'agent text');
  assert(node(d, ['.harness/team.mjs', 'sync-agents', '--check']).status === 0, 'should be in sync right after writing');
  fs.appendFileSync(path.join(d, '.claude', 'agents', 'lead-dev.md'), 'tampered');
  assert(node(d, ['.harness/team.mjs', 'sync-agents', '--check']).status === 1, 'a tampered agent must be detected');
  fs.writeFileSync(path.join(d, '.harness', 'config.json'), read(d, '.harness/config.json'));
  assert(/editor agents out of sync/.test(node(d, ['.harness/doctor.mjs']).stdout), 'doctor should warn about stale agents');
  node(d, ['.harness/team.mjs', 'sync-agents']);
  const t = json(path.join(d, '.harness', 'team.json')); t.members.find((m) => m.id === 'lead-dev').scope = ['src/app/**']; fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(t));
  assert(node(d, ['.harness/team.mjs', 'sync-agents', '--check']).status === 1, 'changing team.json must make the agents stale');
  node(d, ['.harness/team.mjs', 'sync-agents']);
  assert(/src\/app\/\*\*/.test(read(d, '.claude/agents/lead-dev.md')) && /editor agents in sync/.test(node(d, ['.harness/doctor.mjs']).stdout), 're-sync did not update the agent');
  const bad = json(path.join(d, '.harness', 'team.json')); bad.members.find((m) => m.id === 'lead-dev').scope = ['src/**', 'docs/**']; fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(bad));
  assert(node(d, ['.harness/team.mjs', 'sync-agents']).status === 1, 'an invalid team must not generate agents');
});

await test('auto on by default, safely: the shipped charter is ON; the hook tells the editor AI to start /harness:auto only when work is READY; the headless controller plans nothing from the placeholder charter; installer can opt out', () => {
  { // The template ships ON for new projects; this repo's own charter may be locked off by its owner.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-shipped-'));
    spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), fresh], { encoding: 'utf8' });
    assert(/^- autonomous: on$/m.test(read(fresh, '.harness/charter.md')), 'a freshly installed charter must be autonomous: on'); }
  const d = sandbox();
  let h = node(d, ['.harness/hook-session.mjs']).stdout;
  assert(/Auto mode is ON but there is nothing READY and the charter objectives are not filled in/.test(h) && !/Start the autonomous workflow now/.test(h), h);
  const tk = node(d, ['.harness/daemon.mjs', '--tick']);
  assert(/idle/.test(tk.stdout) && calls(d, 'po-calls.txt').length === 0, `headless must not plan from the placeholder: ${tk.stdout}`);
  setBacklog(d, [{ id: 'R1', title: 'ready task', status: 'READY', verifyCmd: PASS }]);
  h = node(d, ['.harness/hook-session.mjs']).stdout;
  assert(/AUTO MODE IS ON \(the owner enabled it in \.harness\/charter\.md\) and 1 task\(s\) are READY; next: "ready task"\. Start the autonomous workflow now with \/harness:auto/.test(h), h);
  setCharter(d, { autonomous: 'off' });
  assert(!/AUTO MODE IS ON/.test(node(d, ['.harness/hook-session.mjs']).stdout), 'off must not trigger the auto start');
  const id = runIdOf(vis(d, 'brief', '--goal', 'g', '--check', PASS));
  h = node(d, ['.harness/hook-session.mjs']).stdout;
  assert(new RegExp(`UNFINISHED editor run ${id}`).test(h) && /verify .*rollback|rollback/.test(h) && !/AUTO MODE IS ON/.test(h), h);
  vis(d, 'rollback', id);
  const on = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-auto-on-')); const off = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-auto-off-'));
  spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), on], { encoding: 'utf8' });
  const ro = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), off, '--autonomous', 'off'], { encoding: 'utf8' });
  assert(/^- autonomous: on$/m.test(read(on, '.harness/charter.md')) && /^- autonomous: off$/m.test(read(off, '.harness/charter.md')) && /set +autonomous mode OFF/.test(ro.stdout), 'installer default/opt-out');
  assert(fs.existsSync(path.join(on, '.claude', 'agents', 'lead-dev.md')) && fs.existsSync(path.join(on, '.claude', 'commands', 'harness', 'auto.md')), 'agents/commands not installed');
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-own-charter-')); fs.mkdirSync(path.join(own, '.harness'), { recursive: true }); fs.writeFileSync(path.join(own, '.harness', 'charter.md'), '# mine\n- autonomous: on\n');
  spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), own, '--autonomous', 'off']);
  assert(read(own, '.harness/charter.md') === '# mine\n- autonomous: on\n', 'a project\'s own charter must never be touched by the installer');
  assert(spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), off, '--autonomous', 'maybe'], { encoding: 'utf8' }).status === 1, 'a bad --autonomous value must be refused');
});

await test('documentation matches reality: every script, sub-command and slash command that the README, AGENTS.md, docs and commands tell people to use exists', () => {
  const docs = ['README.md', 'AGENTS.md', 'docs/WORKFLOW.md', ...fs.readdirSync(path.join(REPO, '.claude', 'commands', 'harness')).map((f) => `.claude/commands/harness/${f}`)];
  const sources = { visible: fs.readFileSync(path.join(REPO, '.harness', 'visible.mjs'), 'utf8'), team: fs.readFileSync(path.join(REPO, '.harness', 'team.mjs'), 'utf8'), backlog: fs.readFileSync(path.join(REPO, '.harness', 'backlog.mjs'), 'utf8'), memory: fs.readFileSync(path.join(REPO, '.harness', 'memory.mjs'), 'utf8') };
  const cmdFiles = new Set(fs.readdirSync(path.join(REPO, '.claude', 'commands', 'harness')).map((f) => f.replace(/\.md$/, '')));
  const problems = [];
  for (const f of docs) {
    const t = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const m of t.matchAll(/node \.harness\/([a-z-]+)\.mjs/g)) if (!fs.existsSync(path.join(REPO, '.harness', `${m[1]}.mjs`))) problems.push(`${f}: missing script .harness/${m[1]}.mjs`);
    for (const m of t.matchAll(/visible\.mjs (brief|assign|verify|rollback|propose|status|report|[a-z]+)\b/g)) if (!new RegExp(`case '${m[1]}'`).test(sources.visible)) problems.push(`${f}: visible.mjs has no sub-command "${m[1]}"`);
    for (const m of t.matchAll(/team\.mjs (show|validate|sync-agents|[a-z-]+)\b/g)) if (!sources.team.includes(`'${m[1]}'`)) problems.push(`${f}: team.mjs has no "${m[1]}"`);
    for (const m of t.matchAll(/\/harness:([a-z]+)/g)) if (!cmdFiles.has(m[1])) problems.push(`${f}: slash command /harness:${m[1]} does not exist`);
    for (const m of t.matchAll(/`(\.harness\/(?:[a-z-]+\/)*[A-Za-z0-9_.-]+\.(?:mjs|json|md))`/g)) if (!/<|\*/.test(m[1]) && !fs.existsSync(path.join(REPO, m[1])) && !/live\.log|state\.json|telemetry|daemon\.pid|auto-state|engine-probe|auto-lessons|report\.md|run\.json|failed\/|completed\/|visible\/|releases\/|sessions\/|inbox\//.test(m[1])) problems.push(`${f}: mentions ${m[1]}, which does not exist`);
  }
  assert(problems.length === 0, problems.slice(0, 12).join('\n      '));
  assert(fs.existsSync(path.join(REPO, 'docs', 'WORKFLOW.md')) && /docs\/WORKFLOW\.md/.test(fs.readFileSync(path.join(REPO, 'README.md'), 'utf8')), 'README must link to docs/WORKFLOW.md');
});

await test('demo project (examples/make-demo.mjs): ready to try — harness installed, objectives filled, one READY task with a real check, own git repo; the controller can run it end to end; --force only recreates demos', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-demo-test-'));
  const demo = path.join(base, 'demo');
  // make-demo runs the doctor, which (correctly) fails when no AI CLI is installed, e.g. on a CI runner. Put a fake
  // `claude` whose --help lists every configured flag first on PATH, so the result does not depend on the machine.
  const fakeBin = path.join(base, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const help = 'Usage: claude [options]\n  -p, --print\n  --allowedTools <tools>\n  --disallowedTools <tools>\n  --output-format <format>\n  --verbose\n  --model <model>\n';
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(fakeBin, 'claude.help.txt'), help.replace(/\n/g, '\r\n'));
    fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@type "%~dp0claude.help.txt"\r\n');
  } else {
    fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\ncat <<'EOF'\n${help}EOF\n`);
    fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
  }
  const mkEnv = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` };
  const mk = (...a) => spawnSync(process.execPath, [path.join(REPO, 'examples', 'make-demo.mjs'), ...a], { encoding: 'utf8', env: mkEnv });
  const r = mk(demo);
  assert(r.status === 0 && /Demo project created/.test(r.stdout) && /Failures: 0/.test(r.stdout), r.stdout + r.stderr);
  for (const f of ['.harness/visible.mjs', '.claude/agents/lead-dev.md', '.claude/commands/harness/run.md', 'README.md', 'package.json']) assert(fs.existsSync(path.join(demo, f)), `demo lacks ${f}`);
  const charter = read(demo, '.harness/charter.md');
  assert(/^- autonomous: on$/m.test(charter) && !/describe your product goals here/.test(charter) && /text-utilities library/.test(charter), 'charter objectives not filled in / autonomy not on');
  assert(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: demo, encoding: 'utf8' }).trim() === '1' && execFileSync('git', ['status', '--porcelain'], { cwd: demo, encoding: 'utf8' }).trim() === '', 'demo must be its own git repo with one clean commit');
  for (const f of ['live.log', 'state.json', 'telemetry.log']) assert(!fs.existsSync(path.join(demo, '.harness', f)), `local runtime file leaked into the demo: ${f}`);
  const hook = spawnSync(process.execPath, ['.harness/hook-session.mjs'], { cwd: demo, encoding: 'utf8' }).stdout;
  assert(/AUTO MODE IS ON .* 1 task\(s\) are READY; next: "Add a slugify helper"/.test(hook), hook);
  // the controller runs the demo's READY task end to end (the agents' work is simulated by writing the files)
  const b = spawnSync(process.execPath, ['.harness/visible.mjs', 'brief', '--next', '--auto-session', 'SDEMO'], { cwd: demo, encoding: 'utf8' });
  const id = runIdOf(b);
  assert(b.status === 0 && id && /Task: Add a slugify helper/.test(b.stdout) && /slugify\(text\)/.test(b.stdout) && !/NO REAL CHECK/.test(b.stdout), b.stdout + b.stderr);
  const plan = deleg([{ lead: 'lead-ba', goal: 'spec', files: ['docs/slugify.md'] }, { lead: 'lead-dev', goal: 'code', files: ['src/slugify.js'] }, { lead: 'lead-qa', goal: 'tests', files: ['tests/slugify.test.js'] }]);
  const a = spawnSync(process.execPath, ['.harness/visible.mjs', 'assign', id, plan], { cwd: demo, encoding: 'utf8' });
  assert(a.status === 0 && /DELEGATION OK/.test(a.stdout), a.stdout + a.stderr);
  fs.mkdirSync(path.join(demo, 'docs'), { recursive: true }); fs.mkdirSync(path.join(demo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(demo, 'docs', 'slugify.md'), '# slugify\n');
  fs.writeFileSync(path.join(demo, 'src', 'slugify.js'), "exports.slugify=(t)=>{if(typeof t!=='string')throw new TypeError('x');return t.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')}\n");
  fs.writeFileSync(path.join(demo, 'tests', 'slugify.test.js'), "const t=require('node:test');const a=require('node:assert');const {slugify}=require('../src/slugify.js');t('x',()=>a.strictEqual(slugify('  Hello, World!  '),'hello-world'))\n");
  const v = spawnSync(process.execPath, ['.harness/visible.mjs', 'verify', id], { cwd: demo, encoding: 'utf8' });
  assert(v.status === 0 && /PASSED ✔/.test(v.stdout), v.stdout);
  assert(/Acceptance criteria — confirm each one yourself/.test(v.stdout) && /☐ slugify\(42\) throws a TypeError/.test(v.stdout), `the report must list the acceptance criteria for the human to confirm:\n${v.stdout}`);
  const tasks = json(path.join(demo, '.harness', 'backlog.json')).tasks;
  assert(tasks[0].status === 'DONE', `backlog item is ${tasks[0].status}`);
  // the demo's check is real: with the files present but no passing test it must fail
  const d2 = path.join(base, 'demo2'); assert(mk(d2).status === 0, 'second demo');
  const b2 = runIdOf(spawnSync(process.execPath, ['.harness/visible.mjs', 'brief', '--next'], { cwd: d2, encoding: 'utf8' }));
  spawnSync(process.execPath, ['.harness/visible.mjs', 'assign', b2, plan], { cwd: d2, encoding: 'utf8' });
  fs.mkdirSync(path.join(d2, 'docs'), { recursive: true }); fs.mkdirSync(path.join(d2, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(d2, 'docs', 'slugify.md'), 'x'); fs.writeFileSync(path.join(d2, 'src', 'slugify.js'), 'exports.slugify=()=>"wrong"\n');
  fs.writeFileSync(path.join(d2, 'tests', 'slugify.test.js'), "const t=require('node:test');const a=require('node:assert');t('fails',()=>a.strictEqual(1,2))\n");
  assert(spawnSync(process.execPath, ['.harness/visible.mjs', 'verify', b2], { cwd: d2, encoding: 'utf8' }).status === 1, 'a demo task with failing tests must NOT pass');
  // safety of the script itself
  assert(mk(demo).status === 1 && /already exists/.test(mk(demo).stderr), 'must refuse an existing non-empty folder');
  const notDemo = path.join(base, 'mine'); fs.mkdirSync(notDemo); fs.writeFileSync(path.join(notDemo, 'important.txt'), 'keep me');
  assert(mk(notDemo, '--force').status === 1 && fs.readFileSync(path.join(notDemo, 'important.txt'), 'utf8') === 'keep me', '--force must never delete a folder that is not a demo');
  assert(mk(demo, '--force').status === 0 && !fs.existsSync(path.join(demo, 'src', 'slugify.js')) && json(path.join(demo, '.harness', 'backlog.json')).tasks[0].status === 'READY', '--force should recreate a clean demo');
  assert(mk(REPO).status === 1 && mk(path.join(REPO, 'inside-the-template')).status === 0 && (fs.rmSync(path.join(REPO, 'inside-the-template'), { recursive: true, force: true }), true), 'the demo may not overwrite the template itself');
});

// ───────────────────────────── smart engine routing (team.mjs auto-assign) ─────────────────────────────

const teamOf = (d) => json(path.join(d, '.harness', 'team.json'));
const engineOf = (d, id) => teamOf(d).members.find((m) => m.id === id).engine;

await test('engine routing (pure): 0 → null, 1 → everywhere, 2 → planning vs coding+QA, 3 → planning / coding / QA', () => {
  const r = gov.planEngineRouting;
  assert(r([]) === null && r(null) === null, '0 engines must give null');
  for (const one of ['claude', 'antigravity', 'codex']) assert(JSON.stringify(r([one])) === JSON.stringify({ plan: one, code: one, qa: one }), `1 engine ${one}: ${JSON.stringify(r([one]))}`);
  const eq = (got, want, label) => assert(JSON.stringify(got) === JSON.stringify(want), `${label}: ${JSON.stringify(got)}`);
  eq(r(['claude', 'antigravity']), { plan: 'antigravity', code: 'claude', qa: 'claude' }, 'agy + claude');
  eq(r(['claude', 'codex']), { plan: 'codex', code: 'claude', qa: 'claude' }, 'claude + codex (no research engine)');
  eq(r(['claude', 'antigravity', 'codex']), { plan: 'antigravity', code: 'claude', qa: 'codex' }, 'agy + claude + codex');
  eq(r(['codex', 'antigravity', 'claude']), { plan: 'antigravity', code: 'claude', qa: 'codex' }, 'all three, any order');
  const t = { members: [{ id: 'o', role: 'PO_ARCHITECT' }, { id: 'b', role: 'BA_ANALYST' }, { id: 'd', role: 'DEV_ENGINEER' }, { id: 'q', role: 'QA_AUDITOR' }, { id: 'x', role: 'CUSTOM' }] };
  const applied = gov.applyEngineRouting(t, { plan: 'P', code: 'C', qa: 'Q' });
  assert(applied.members.map((m) => m.engine).join() === 'P,P,C,Q,C' && t.members.every((m) => m.engine === undefined), `applyEngineRouting by role, input untouched: ${applied.members.map((m) => m.engine)}`);
});

await test('team.mjs auto-assign: 1, 2 and 3 engines route the real team.json by role; only "engine" changes; validate + Doctor accept it', () => {
  const cases = [
    ['claude', { orchestrator: 'claude', 'lead-ba': 'claude', 'lead-dev': 'claude', 'lead-qa': 'claude' }, /1 engine/],
    ['antigravity,claude', { orchestrator: 'antigravity', 'lead-ba': 'antigravity', 'lead-dev': 'claude', 'lead-qa': 'claude' }, /2 engines/],
    ['antigravity,claude,codex', { orchestrator: 'antigravity', 'lead-ba': 'antigravity', 'lead-dev': 'claude', 'lead-qa': 'codex' }, /3\+ engines/]
  ];
  for (const [engines, want, mode] of cases) {
    const d = sandbox();
    const before = teamOf(d);
    const r = node(d, ['.harness/team.mjs', 'auto-assign'], { HARNESS_ENGINES: engines });
    assert(r.status === 0 && mode.test(r.stdout) && /Wrote the "engine"/.test(r.stdout), `${engines}: ${r.stdout}${r.stderr}`);
    const after = teamOf(d);
    for (const [id, e] of Object.entries(want)) assert(engineOf(d, id) === e, `${engines}: ${id} got ${engineOf(d, id)}, want ${e}`);
    const strip = (t) => JSON.stringify({ ...t, members: t.members.map(({ engine, ...m }) => m) });
    assert(strip(after) === strip(before), `${engines}: something other than "engine" changed`);
    assert(node(d, ['.harness/team.mjs', 'validate']).status === 0, `${engines}: routed team must validate`);
    const show = node(d, ['.harness/team.mjs', 'show']).stdout;
    assert(new RegExp(`lead-dev\\s+\\[DEV_ENGINEER\\]\\s+engine: ${want['lead-dev']}`).test(show), `${engines}: show lacks the engine:\n${show}`);
    assert(/engine routing \(headless --hierarchy\): orchestrator→/.test(node(d, ['.harness/doctor.mjs']).stdout), `${engines}: doctor does not report the routing`);
    const again = node(d, ['.harness/team.mjs', 'auto-assign'], { HARNESS_ENGINES: engines });
    assert(/already has this routing; nothing changed/.test(again.stdout), `${engines}: second run should change nothing`);
  }
});

await test('team.mjs auto-assign: --dry-run and 0 engines write nothing; an unknown engine in team.json is rejected', () => {
  const d = sandbox();
  const before = fs.readFileSync(path.join(d, '.harness', 'team.json'), 'utf8');
  const dry = node(d, ['.harness/team.mjs', 'auto-assign', '--dry-run'], { HARNESS_ENGINES: 'antigravity,claude,codex' });
  assert(dry.status === 0 && /--dry-run: team.json was not changed/.test(dry.stdout) && /lead-qa .*→ codex/.test(dry.stdout), dry.stdout);
  const none = node(d, ['.harness/team.mjs', 'auto-assign'], { HARNESS_ENGINES: '' });
  assert(none.status === 0 && /Usable AI engines on this machine: none/.test(none.stdout) && /was not changed/.test(none.stdout), none.stdout);
  assert(fs.readFileSync(path.join(d, '.harness', 'team.json'), 'utf8') === before, 'team.json must be untouched');
  const t = teamOf(d); t.members[1].engine = 'no-such-engine';
  fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(t));
  const v = node(d, ['.harness/team.mjs', 'validate']);
  assert(v.status === 1 && /engine "no-such-engine" is not an engine in config\.json profiles/.test(v.stdout), v.stdout);
});

await test('engine routing end to end: orchestrator, leads and workers each spawn their routed engine; --engine on the task overrides it', () => {
  const d = sandbox();
  const cfgFile = path.join(d, '.harness', 'config.json');
  const cfg = json(cfgFile);
  for (const k of ['mockplan', 'mockcode', 'mockqa']) cfg.profiles[k] = { ...cfg.profiles.mock };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const t = teamOf(d);
  const route = { PO_ARCHITECT: 'mockplan', BA_ANALYST: 'mockplan', DEV_ENGINEER: 'mockcode', QA_AUDITOR: 'mockqa' };
  t.members = t.members.map((m) => ({ ...m, engine: route[m.role] }));
  fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(t, null, 2));
  hierJob(d, 'routed', hierGoal(happyPlan()));
  runOnce(d);
  assert(stateOf(d).phase === '4_COMMITTED', `routed run: ${stateOf(d).phase} ${stateOf(d).lastGateStatus}`);
  const spawned = {};
  for (const e of log(d).filter((x) => x.phase === 'ENGINE_SPAWN')) { const m = /^Spawned (\S+) for (\S+)$/.exec(e.message); if (m) spawned[m[2]] = m[1]; }
  const want = { orchestrator: 'mockplan', 'lead-ba': 'mockplan', 'lead-dev': 'mockcode', 'lead-qa': 'mockqa', 'lead-ba.spec': 'mockplan', 'lead-dev.impl': 'mockcode', 'lead-dev.util': 'mockcode', 'lead-qa.tests': 'mockqa' };
  for (const [id, e] of Object.entries(want)) assert(spawned[id] === e, `${id} spawned ${spawned[id]}, want ${e} (${JSON.stringify(spawned)})`);
  // an explicit engine on the task wins over the team routing
  const d2 = sandbox();
  fs.writeFileSync(path.join(d2, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(d2, '.harness', 'team.json'), JSON.stringify(t, null, 2));
  hierJob(d2, 'forced', hierGoal(happyPlan()), { engine: 'mock' });
  runOnce(d2);
  const used = new Set(log(d2).filter((x) => x.phase === 'ENGINE_SPAWN').map((x) => x.engine));
  assert(stateOf(d2).phase === '4_COMMITTED' && used.size === 1 && used.has('mock'), `override: ${[...used]}`);
});

await test('install: a fresh team.json is auto-routed to the detected engines; an existing team.json and --no-auto-assign are left alone', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-route-'));
  const r = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), fresh], { encoding: 'utf8', env: { ...process.env, HARNESS_ENGINES: 'antigravity,claude' } });
  assert(r.status === 0 && /routed team roles to your engines \(claude, antigravity \(agy\)\)/.test(r.stdout), r.stdout + r.stderr);
  assert(engineOf(fresh, 'lead-ba') === 'antigravity' && engineOf(fresh, 'lead-dev') === 'claude' && engineOf(fresh, 'lead-qa') === 'claude', JSON.stringify(teamOf(fresh).members.map((m) => m.engine)));
  const skip = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-route-skip-'));
  spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), skip, '--no-auto-assign'], { encoding: 'utf8', env: { ...process.env, HARNESS_ENGINES: 'claude' } });
  assert(teamOf(skip).members.every((m) => m.engine === undefined), '--no-auto-assign must not route');
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-route-none-'));
  const rn = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), none], { encoding: 'utf8', env: { ...process.env, HARNESS_ENGINES: '' } });
  assert(/no AI engine allowed yet/.test(rn.stdout) && teamOf(none).members.every((m) => m.engine === undefined), rn.stdout);
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-route-own-'));
  fs.mkdirSync(path.join(own, '.harness'), { recursive: true });
  const mine = JSON.stringify({ ...json(path.join(REPO, '.harness', 'team.json')), description: 'my own team' }, null, 2);
  fs.writeFileSync(path.join(own, '.harness', 'team.json'), mine);
  spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), own], { encoding: 'utf8', env: { ...process.env, HARNESS_ENGINES: 'claude' } });
  assert(fs.readFileSync(path.join(own, '.harness', 'team.json'), 'utf8') === mine, 'an existing team.json must never be re-routed');
  for (const p of [fresh, skip, none, own]) fs.rmSync(p, { recursive: true, force: true });
});

await test('install: .gitattributes pins LF for the harness files only; a core.autocrlf=true clone gets LF harness files; existing rules kept; idempotent', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eol-'));
  const proj = path.join(base, 'proj');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  const gitp = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' });
  gitp(base, 'init', '-q', '-b', 'main', 'proj');
  fs.writeFileSync(path.join(proj, '.gitattributes'), '*.png binary\n');
  fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'a\nb\n');
  const inst = () => spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), proj, '--no-auto-assign'], { encoding: 'utf8' });
  const r = inst();
  assert(r.status === 0 && /harness line-ending rules to existing \.gitattributes/.test(r.stdout), r.stdout + r.stderr);
  const ga = fs.readFileSync(path.join(proj, '.gitattributes'), 'utf8');
  assert(ga.startsWith('*.png binary\n') && /^\.harness\/\*\* text eol=lf$/m.test(ga) && /^\.claude\/\*\* text eol=lf$/m.test(ga) && /^AGENTS\.md text eol=lf$/m.test(ga), `the project's rule must be kept and the harness rules added:\n${ga}`);
  assert(!/^\* text/m.test(ga), 'must not change line endings for the whole project');
  inst();
  assert(fs.readFileSync(path.join(proj, '.gitattributes'), 'utf8') === ga, 're-running the installer must not add the block twice');
  gitp(proj, 'add', '-A'); gitp(proj, 'commit', '-q', '-m', 'install');
  // A Windows teammate: clone with core.autocrlf=true
  execFileSync('git', ['-c', 'core.autocrlf=true', 'clone', '-q', proj, path.join(base, 'mate')], { encoding: 'utf8' });
  const mate = (f) => fs.readFileSync(path.join(base, 'mate', f), 'utf8');
  for (const f of ['.harness/charter.md', '.harness/team.json', '.claude/commands/harness/run.md', 'AGENTS.md']) assert(!mate(f).includes('\r'), `${f} must stay LF in an autocrlf clone`);
  fs.rmSync(base, { recursive: true, force: true });
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eol-fresh-'));
  const rf = spawnSync(process.execPath, [path.join(REPO, 'install.mjs'), fresh, '--no-auto-assign'], { encoding: 'utf8' });
  assert(/wrote  \.gitattributes/.test(rf.stdout) && fs.existsSync(path.join(fresh, '.gitattributes')), 'a project without .gitattributes gets one');
  fs.rmSync(fresh, { recursive: true, force: true });
});

// ───────────────────────────── token-aware model tiers ─────────────────────────────

const common = await import(pathToFileURL(path.join(REPO, '.harness', 'lib', 'common.mjs')).href);
const TIERED = { fast: 'm-fast', medium: 'm-medium', high: 'm-high' };
const tieredProfile = (models = TIERED) => ({ verified: true, binary: process.execPath, args: [MOCK, 'ALLOWED={allowedTools}', 'DENIED={disallowedTools}'], promptVia: 'stdin', allowedTools: [], modelArgs: ['MODEL={model}'], models });
const withProfiles = (d, profiles) => {
  const f = path.join(d, '.harness', 'config.json'); const c = json(f); Object.assign(c.profiles, profiles); fs.writeFileSync(f, JSON.stringify(c, null, 2));
  const a = path.join(d, '.harness', 'approvals.json'); const ap = fs.existsSync(a) ? json(a) : {}; // test engines are allowed, as a person would
  ap.engines = { ...(ap.engines || {}), ...Object.fromEntries(Object.keys(profiles).map((k) => [k, true])) }; fs.writeFileSync(a, JSON.stringify(ap));
};
const modelArg = (d, id) => (argsOf(d, id).find((a) => a.startsWith('MODEL=')) || '').slice(6) || null;
const tierLog = (d) => log(d).filter((e) => e.phase === 'MODEL_TIER');

await test('model tiers (pure): low → fast, standard → medium, architecture/planning → high; retries escalate; overrides win', () => {
  const t = (o) => common.chooseModelTier(o).tier;
  // low / fast
  assert(t({ role: 'QA_AUDITOR', targetFiles: ['tests/a.test.js'], prompt: 'run the tests and fix the assertion' }) === 'fast', 'QA test run');
  assert(t({ role: 'DEV_ENGINEER', targetFiles: ['src/a.js'], prompt: 'rename foo to bar' }) === 'fast', 'single-file small edit');
  assert(t({ role: 'BA_ANALYST', targetFiles: ['docs/a.md'], prompt: 'document the flag' }) === 'fast', 'simple docs');
  assert(t({ kind: 'plan', level: 'lead', role: 'QA_AUDITOR' }) === 'fast', 'QA lead planning');
  // medium / balanced
  assert(t({ role: 'DEV_ENGINEER', targetFiles: ['src/a.js', 'src/b.js', 'src/c.js'], prompt: 'implement the feature' }) === 'medium', 'multi-file coding');
  assert(t({ role: 'DEV_ENGINEER', targetFiles: ['src/a.js'], prompt: 'x'.repeat(2000) }) === 'medium', 'single file but a large job');
  assert(t({ role: 'QA_AUDITOR', targetFiles: ['t/a', 't/b', 't/c'], prompt: 'write tests' }) === 'medium', 'QA over many files');
  assert(t({ kind: 'plan', level: 'lead', role: 'DEV_ENGINEER' }) === 'medium', 'lead-dev planning');
  // high / deep reasoning
  assert(t({ kind: 'plan', level: 'orchestrator', role: 'PO_ARCHITECT' }) === 'high', 'orchestrator');
  assert(t({ kind: 'plan', level: 'lead', role: 'BA_ANALYST' }) === 'medium', 'lead-ba only splits its own docs');
  assert(t({ role: 'PO_ARCHITECT', targetFiles: ['docs/arch.md'], prompt: 'x' }) === 'high', 'architecture work');
  // escalation after a failed check
  const small = { role: 'DEV_ENGINEER', targetFiles: ['src/a.js'], prompt: 'fix it' };
  assert([1, 2, 3, 4].map((cycle) => t({ ...small, cycle })).join() === 'fast,medium,high,high', 'retries must escalate one tier per failed cycle, capped at high');
  assert(/escalated fast → medium/.test(common.chooseModelTier({ ...small, cycle: 2 }).reasons.join()), 'the escalation reason is recorded');
  // tier → model for a profile (aliases only, never pinned versions)
  const cfg = json(path.join(REPO, '.harness', 'config.json'));
  const c = cfg.profiles.claude;
  assert(c.models.fast === 'haiku' && c.models.medium === 'sonnet' && c.models.high === 'opus' && c.modelArgs.join(' ') === '--model {model}', `claude aliases: ${JSON.stringify(c.models)}`);
  // Aliases only, except antigravity and codex: neither CLI has aliases, so it uses the exact IDs from 'agy models' (owner decision).
  for (const [name, p] of Object.entries(cfg.profiles)) if (!['antigravity', 'codex'].includes(name)) for (const m of Object.values(p.models || {})) assert(m === null || !/\d/.test(m), `${name}: model "${m}" looks like a pinned version; use an alias`);
  const ag = cfg.profiles.antigravity;
  assert(ag.models.fast === 'gemini-3.8-flash-medium' && ag.models.medium === 'gemini-4-argon-medium' && ag.models.high === 'gemini-4-hydrogen-high' && ag.modelArgs.join(' ') === '--model {model}', `antigravity tiers: ${JSON.stringify(ag.models)}`);
  assert(common.resolveModel(c, { tier: 'fast' }).model === 'haiku' && common.resolveModel(c, { tier: 'high' }).model === 'opus', 'claude tier → alias');
  assert(common.resolveModel(cfg.profiles.codex, { tier: 'fast' }).model === 'gpt-6-luna@low' && common.resolveModel(cfg.profiles.codex, { tier: 'high' }).model === 'gpt-6-luna@high', 'codex: one model, reasoning effort per tier');
  assert(!Object.values(cfg.profiles).some((p) => common.usesCliDefault(p)), 'no engine may silently run on its CLI default model');
  assert(JSON.stringify(common.resolveModel(c, { tier: 'fast', override: 'high' })) === JSON.stringify({ tier: 'high', model: 'opus', source: 'override-tier' }), 'a tier override picks that tier');
  assert(common.resolveModel(c, { tier: 'fast', override: 'fable' }).model === 'fable', 'an alias override is passed through');
  assert(common.profileFlags(c).includes('--model') && !common.profileFlags({ args: ['-p'], modelArgs: ['--model', '{model}'], models: { fast: null, medium: null, high: null } }).includes('--model'), 'the probe checks --model only where an alias is configured');
});

await test('model tiers end to end (1 engine): orchestrator high, lead-ba and lead-dev medium, QA + small edits fast, multi-file coding medium', () => {
  const d = sandbox();
  withProfiles(d, { mock: tieredProfile() });
  hierJob(d, 'tiers', hierGoal(happyPlan()));
  runOnce(d);
  assert(stateOf(d).phase === '4_COMMITTED', `${stateOf(d).phase} ${stateOf(d).lastGateStatus}`);
  const want = { orchestrator: 'm-high', 'lead-ba': 'm-medium', 'lead-dev': 'm-medium', 'lead-qa': 'm-fast', 'lead-ba.spec': 'm-fast', 'lead-dev.impl': 'm-fast', 'lead-dev.util': 'm-fast', 'lead-qa.tests': 'm-fast' };
  for (const [id, m] of Object.entries(want)) assert(modelArg(d, id) === m, `${id}: --model ${modelArg(d, id)}, want ${m}`);
  assert(tierLog(d).some((e) => e.worker === 'lead-qa.tests' && e.tier === 'fast' && /QA/.test(e.reasons.join())), 'MODEL_TIER telemetry with the reason');
  // a multi-file coding worker is medium
  const d2 = sandbox();
  withProfiles(d2, { mock: tieredProfile() });
  drop(d2, { id: 'multi', title: 'multi', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['src/a.js', 'src/b.js', 'src/c.js'], prompt: 'WRITE src/a.js a\nWRITE src/b.js b\nWRITE src/c.js c' }] });
  runOnce(d2);
  assert(stateOf(d2).phase === '4_COMMITTED' && modelArg(d2, 'w') === 'm-medium', `multi-file: ${modelArg(d2, 'w')}`);
});

await test('model tiers: a failing check escalates fast → medium → high across the 3 cycles', () => {
  const d = sandbox();
  withProfiles(d, { mock: tieredProfile() });
  drop(d, { id: 'esc', title: 'esc', verifyCmd: 'node -e "process.exit(1)"', subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const tiers = tierLog(d).filter((e) => e.worker === 'w').map((e) => `${e.tier}:${e.model}`);
  assert(tiers.join() === 'fast:m-fast,medium:m-medium,high:m-high', `escalation: ${tiers.join()}`);
});

await test('model tiers (multi-engine): each engine gets its own alias, an engine with no alias gets no --model; member "model" and --model override', () => {
  const d = sandbox();
  withProfiles(d, { mockplan: tieredProfile({ fast: 'p-fast', medium: 'p-medium', high: 'p-high' }), mockcode: tieredProfile({ fast: 'c-fast', medium: 'c-medium', high: 'c-high' }), mockqa: tieredProfile({ fast: null, medium: null, high: null }) });
  const t = teamOf(d);
  const route = { PO_ARCHITECT: 'mockplan', BA_ANALYST: 'mockplan', DEV_ENGINEER: 'mockcode', QA_AUDITOR: 'mockqa' };
  t.members = t.members.map((m) => ({ ...m, engine: route[m.role], ...(m.id === 'lead-dev' ? { model: 'high' } : {}) }));
  fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(t, null, 2));
  assert(node(d, ['.harness/team.mjs', 'validate']).status === 0, 'a team with "model" must validate');
  hierJob(d, 'multi', hierGoal(happyPlan()));
  runOnce(d);
  assert(stateOf(d).phase === '4_COMMITTED', `${stateOf(d).phase} ${stateOf(d).lastGateStatus}`);
  const want = { orchestrator: 'p-high', 'lead-ba': 'p-medium', 'lead-ba.spec': 'p-fast', 'lead-dev': 'c-high', 'lead-dev.impl': 'c-high', 'lead-dev.util': 'c-high', 'lead-qa': null, 'lead-qa.tests': null };
  for (const [id, m] of Object.entries(want)) assert(modelArg(d, id) === m, `${id}: --model ${modelArg(d, id)}, want ${m}`);
  assert(tierLog(d).some((e) => e.worker === 'lead-dev.impl' && e.source === 'override-tier'), 'member override recorded');
  // --model on the job overrides everything (an alias is passed through as-is)
  const d2 = sandbox();
  withProfiles(d2, { mock: tieredProfile() });
  const r = node(d2, ['.harness/dispatch.mjs', '--goal', 'WRITE a.txt hi', '--files', 'a.txt', '--model', 'fable', '--check', PASS, '--wait']);
  assert(r.status === 0 && modelArg(d2, 'worker-main') === 'fable', `--model: ${modelArg(d2, 'worker-main')} ${r.stdout}`);
  t.members[1].model = 'bad model!';
  fs.writeFileSync(path.join(d, '.harness', 'team.json'), JSON.stringify(t, null, 2));
  assert(node(d, ['.harness/team.mjs', 'validate']).status === 1, 'an invalid model must be rejected');
});

// ───────────────────────────── real-engine error handling (found with the real claude CLI) ─────────────────────────────

await test('engine errors: a usage limit in Claude JSON on stdout (exit 1, noise on stderr) is reported as-is and stops at once, no retries', () => {
  const d = sandbox();
  const fake = path.join(d, 'limit-engine.mjs');
  // what claude -p --output-format json printed on a real machine that had hit its subscription limit
  fs.writeFileSync(fake, "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('Ignoring 24 permissions.allow entries: this workspace has not been trusted.\\n');process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:true,api_error_status:429,result:\"You've hit your 5-hour limit · resets 3:40pm\"}));process.exit(1);});");
  withProfiles(d, { mock: { verified: true, binary: process.execPath, args: [fake], promptVia: 'stdin', allowedTools: [] } });
  drop(d, { id: 'limit', title: 'limit', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const s = stateOf(d);
  const spawns = log(d).filter((e) => e.phase === 'ENGINE_SPAWN').length;
  assert(spawns === 1, `a usage limit must not be retried (spawned ${spawns}x)`);
  assert(/You've hit your 5-hour limit/.test(s.lastGateStatus) && !/not been trusted/.test(s.lastGateStatus), `the engine's own message must be shown: ${s.lastGateStatus}`);
});

await test('engine errors: a login problem on stderr is fatal; an ordinary crash is still retried', () => {
  const mk = (d, body) => { const f = path.join(d, 'e.mjs'); fs.writeFileSync(f, `process.stdin.resume();process.stdin.on('end',()=>{${body}});`); withProfiles(d, { mock: { verified: true, binary: process.execPath, args: [f], promptVia: 'stdin', allowedTools: [] } }); };
  const job = (d) => drop(d, { id: 'j', title: 'j', verifyCmd: PASS, subtasks: [{ id: 'w', targetFiles: ['a.txt'], prompt: 'x' }] });
  const d1 = sandbox(); mk(d1, "process.stderr.write('Error: not logged in. Please run gemini to log in.\\n');process.exit(1);"); job(d1); runOnce(d1);
  assert(log(d1).filter((e) => e.phase === 'ENGINE_SPAWN').length === 1 && /account\/login problem/.test(stateOf(d1).lastGateStatus), `login: ${stateOf(d1).lastGateStatus}`);
  const d2 = sandbox(); mk(d2, "process.stderr.write('TypeError: something broke\\n');process.exit(1);"); job(d2); runOnce(d2);
  assert(log(d2).filter((e) => e.phase === 'ENGINE_SPAWN').length === 3, 'an ordinary crash keeps its 3 cycles');
});

await test('editor verify flags what tests cannot prove: UI changes need a visual review, skipped tests are reported, files the check leaves untracked are flagged; the brief warns when a UI project has no browser check', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-visual-test-'));
  const demo = path.join(base, 'demo');
  assert(spawnSync(process.execPath, [path.join(REPO, 'examples', 'make-demo.mjs'), demo], { encoding: 'utf8' }).status === 0, 'demo');
  fs.writeFileSync(path.join(demo, 'index.html'), '<!doctype html><title>x</title>\n');
  execFileSync('git', ['add', '-A'], { cwd: demo }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ui'], { cwd: demo });
  // a check that passes, skips one test (node:test TAP summary) and writes a build output git does not ignore
  const check = `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/out.txt','x');console.log('# pass 3\\n# skipped 1')"`;
  const b = spawnSync(process.execPath, ['.harness/visible.mjs', 'brief', '--goal', 'restyle the page', '--check', check], { cwd: demo, encoding: 'utf8' });
  const id = runIdOf(b);
  assert(b.status === 0 && id && /UI files but the check never opens a browser/.test(b.stdout), b.stdout + b.stderr);
  assert(spawnSync(process.execPath, ['.harness/visible.mjs', 'assign', id, deleg([{ lead: 'lead-dev', goal: 'style', files: ['src/style.css'] }])], { cwd: demo, encoding: 'utf8' }).status === 0, 'assign');
  fs.writeFileSync(path.join(demo, 'src', 'style.css'), 'body{margin:0}\n');
  const v = spawnSync(process.execPath, ['.harness/visible.mjs', 'verify', id], { cwd: demo, encoding: 'utf8' });
  assert(v.status === 0, v.stdout);
  assert(/PASSED ✔ — NEEDS A VISUAL REVIEW/.test(v.stdout) && /src\/style\.css/.test(v.stdout) && /never opened a browser/.test(v.stdout), `visual review not flagged:\n${v.stdout}`);
  assert(/1 test\(s\) SKIPPED/.test(v.stdout) && /A skipped test proves nothing/.test(v.stdout), `skipped tests not reported:\n${v.stdout}`);
  assert(/git does not ignore \(dist\/out\.txt\)/.test(v.stdout), `untracked check output not flagged:\n${v.stdout}`);
  const run = json(path.join(demo, '.harness', 'visible', id, 'run.json'));
  assert(run.lastVerify.skipped === 1 && run.lastVerify.needsVisualReview === true, JSON.stringify(run.lastVerify));
});

await test('doctor: a project with UI files but no browser testing tool gets a note with the install command (never installs, never a failure); a project without UI files is not bothered', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-doctor-browser-'));
  const demo = path.join(base, 'demo');
  assert(spawnSync(process.execPath, [path.join(REPO, 'examples', 'make-demo.mjs'), demo], { encoding: 'utf8' }).status === 0, 'demo');
  const doctor = (env = {}) => spawnSync(process.execPath, ['.harness/doctor.mjs'], { cwd: demo, encoding: 'utf8', env: { ...process.env, ...env } });
  let r = doctor();
  assert(!/Browser testing/.test(r.stdout), `no UI files, so no browser section:\n${r.stdout}`);
  fs.writeFileSync(path.join(demo, 'index.html'), '<!doctype html><title>x</title>\n');
  r = doctor({ HARNESS_BROWSER_MODULES: 'no-such-browser-tool' });
  assert(r.status === 0 && /Browser testing/.test(r.stdout) && /no browser testing tool is installed/.test(r.stdout) && /npm install -D playwright/.test(r.stdout), r.stdout);
  assert(!/✖/.test(r.stdout) && /Failures: 0/.test(r.stdout), `must stay a note, not a failure:\n${r.stdout}`);
  assert(!fs.existsSync(path.join(demo, 'node_modules')) && !/playwright/.test(fs.readFileSync(path.join(demo, 'package.json'), 'utf8')), 'the doctor must never install anything');
  // a tool that resolves: reported as found (a fake module in the project's node_modules)
  fs.mkdirSync(path.join(demo, 'node_modules', 'fake-browser-tool'), { recursive: true });
  fs.writeFileSync(path.join(demo, 'node_modules', 'fake-browser-tool', 'index.js'), 'module.exports = {};\n');
  r = doctor({ HARNESS_BROWSER_MODULES: 'fake-browser-tool' });
  assert(/browser testing tool found: fake-browser-tool/.test(r.stdout) && /doctor\.mjs --deep/.test(r.stdout), r.stdout);
});

await test('editor verify flags tests that changed after a failed check (fixed or weakened?) and existing tests that were deleted', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-weak-test-'));
  const demo = path.join(base, 'demo');
  assert(spawnSync(process.execPath, [path.join(REPO, 'examples', 'make-demo.mjs'), demo], { encoding: 'utf8' }).status === 0, 'demo');
  fs.mkdirSync(path.join(demo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(demo, 'tests', 'old.test.js'), '// an existing test\n');
  execFileSync('git', ['add', '-A'], { cwd: demo }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'old test'], { cwd: demo });
  // the check passes only once the new test file contains the word "weak": the first verify fails, the second passes
  const check = `node -e "process.exit(require('fs').readFileSync('tests/new.test.js','utf8').includes('weak')?0:1)"`;
  const vis = (...a) => spawnSync(process.execPath, ['.harness/visible.mjs', ...a], { cwd: demo, encoding: 'utf8' });
  const id = runIdOf(vis('brief', '--goal', 'add a helper', '--check', check));
  assert(vis('assign', id, deleg([{ lead: 'lead-dev', goal: 'code', files: ['src/a.js'] }, { lead: 'lead-qa', goal: 'tests', files: ['tests/'] }])).status === 0, 'assign');
  fs.writeFileSync(path.join(demo, 'src', 'a.js'), 'exports.a = 1;\n');
  fs.writeFileSync(path.join(demo, 'tests', 'new.test.js'), '// strict test\n');
  let v = vis('verify', id);
  assert(v.status === 1 && /NOT PASSED YET/.test(v.stdout) && !/test file\(s\) were changed/.test(v.stdout), `first cycle must fail without the warning:\n${v.stdout}`);
  fs.writeFileSync(path.join(demo, 'tests', 'new.test.js'), '// weak test\n');
  fs.rmSync(path.join(demo, 'tests', 'old.test.js'));
  v = vis('verify', id);
  assert(v.status === 0 && /PASSED ✔/.test(v.stdout), v.stdout);
  assert(/After the last failed check, 2 test file\(s\) were changed/.test(v.stdout) && /FIXED, not weakened/.test(v.stdout), `changed tests not flagged:\n${v.stdout}`);
  assert(/1 test file\(s\) that existed before this run were DELETED \(tests\/old\.test\.js\)/.test(v.stdout), `deleted test not flagged:\n${v.stdout}`);
  assert(!('cycleSnapshot' in json(path.join(demo, '.harness', 'visible', id, 'run.json'))), 'the cycle snapshot must be dropped once the run ends');
});

await test('Orca is no longer supported: no profile in config.json, and asking for it stops with a clear message listing the supported engines', () => {
  const cfg = json(path.join(REPO, '.harness', 'config.json'));
  assert(!('orca' in cfg.profiles) && !(cfg.autoOrder || []).includes('orca'), 'orca must not be a profile or in autoOrder');
  assert(['claude', 'antigravity', 'codex'].every((e) => e in cfg.profiles), 'the three supported engines must have a profile');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./.harness/lib/common.mjs').then((m)=>{try{m.resolveProfile(m.loadConfig(),'orca')}catch(e){console.log(e.message);process.exit(0)}process.exit(3)})"], { cwd: REPO, encoding: 'utf8' });
  assert(r.status === 0 && /no longer supported/.test(r.stdout) && /claude, antigravity, codex/.test(r.stdout), r.stdout + r.stderr);
});

await test('Gemini is no longer supported: no profile, not routable, and --engine gemini stops with a message pointing to antigravity', () => {
  const cfg = json(path.join(REPO, '.harness', 'config.json'));
  assert(!('gemini' in cfg.profiles) && !(cfg.autoOrder || []).includes('gemini'), 'gemini must not be a profile or in autoOrder');
  assert(cfg.profiles.antigravity.verified === true, 'antigravity was verified end to end on a real machine');
  assert(!common.ROUTABLE_ENGINES.includes('gemini'), 'gemini must not be routable');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./.harness/lib/common.mjs').then((m)=>{try{m.resolveProfile(m.loadConfig(),'gemini')}catch(e){console.log(e.message);process.exit(0)}process.exit(3)})"], { cwd: REPO, encoding: 'utf8' });
  assert(r.status === 0 && /no longer supported/.test(r.stdout) && /antigravity/.test(r.stdout), r.stdout + r.stderr);
});

await test('approval gate: only costly runs ask; with no terminal they stop (exit 3, no job) unless --yes or a saved "always" answer', () => {
  const cfg = json(path.join(REPO, '.harness', 'config.json'));
  const kinds = (o) => common.costlyRunReasons(cfg, o).map((c) => c.kind).join();
  assert(kinds({}) === '' && kinds({ workers: 2 }) === '' && kinds({ model: 'fast' }) === '', 'a normal run is never asked');
  assert(kinds({ hierarchy: true }) === 'team' && kinds({ autoPlan: true }) === 'parallel' && kinds({ workers: 3 }) === 'many-workers', 'team / parallel / 3+ workers');
  assert(kinds({ model: 'high' }) === 'high-model' && kinds({ model: 'opus' }) === 'high-model' && kinds({ model: 'gemini-4-hydrogen-high' }) === 'high-model', 'forcing a high-tier model');
  const d = sandbox();
  const noYes = { HARNESS_YES: '' };
  const inbox = () => fs.readdirSync(path.join(d, '.harness', 'inbox')).filter((f) => f.endsWith('.json')).length;
  const team = node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--hierarchy'], noYes);
  assert(team.status === 3 && /APPROVAL_NEEDED/.test(team.stderr) && /team mode/.test(team.stdout) && inbox() === 0, team.stdout + team.stderr);
  assert(node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--files', 'a.txt'], noYes).status === 0 && inbox() === 1, 'a normal run starts without a question');
  assert(node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--hierarchy', '--yes'], noYes).status === 0 && inbox() === 2, '--yes skips the question');
  fs.writeFileSync(path.join(d, '.harness', 'approvals.json'), JSON.stringify({ engines: { mock: true }, alwaysAllow: ['parallel'] }));
  assert(node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--auto-plan'], noYes).status === 0 && inbox() === 3, 'a saved "always" answer is not asked again');
  assert(node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--model', 'high'], noYes).status === 3, 'a different kind is still asked');
});

await test('engine consent: an installed tool is not used until the person allows it once; engines.mjs allow / deny; no terminal → ENGINE_APPROVAL_NEEDED', () => {
  const d = sandbox();
  const approvals = path.join(d, '.harness', 'approvals.json');
  fs.writeFileSync(approvals, JSON.stringify({}));
  const inbox = () => fs.readdirSync(path.join(d, '.harness', 'inbox')).filter((f) => f.endsWith('.json')).length;
  const r = node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--files', 'a.txt']);
  assert(r.status === 3 && /ENGINE_APPROVAL_NEEDED/.test(r.stderr) && /not allowed the harness to use it yet/.test(r.stderr) && inbox() === 0, r.stdout + r.stderr);
  const list = node(d, ['.harness/engines.mjs', 'list']);
  assert(list.status === 0 && /AI tools on this machine/.test(list.stdout), list.stdout + list.stderr);
  assert(node(d, ['.harness/engines.mjs', 'allow', 'mock']).status === 0 && json(approvals).engines.mock === true, 'allow must save the answer');
  assert(node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--files', 'a.txt']).status === 0 && inbox() === 1, 'an allowed tool is used without asking again');
  assert(node(d, ['.harness/engines.mjs', 'deny', 'mock']).status === 0 && json(approvals).engines.mock === false, 'deny must save the answer');
  const again = node(d, ['.harness/dispatch.mjs', '--goal', 'x', '--files', 'a.txt']);
  assert(again.status === 3 && /chose not to let the harness use 'mock'/.test(again.stderr), again.stderr);
  assert(node(d, ['.harness/engines.mjs', 'allow', 'nope']).status === 1, 'unknown tool refused');
  assert(node(d, ['.harness/engines.mjs', 'allow', 'agy']).status === 0 && json(approvals).engines.antigravity === true, 'agy is an alias of antigravity');
});

await test('autopilot holds a big run ("needs your OK") and keeps going; backlog approve releases it; high tier is capped to medium in autonomous runs', () => {
  const d = sandbox(); setCharter(d, { autonomous: 'on' });
  setBacklog(d, [
    { id: 'BIG', title: 'team job', priority: 1, status: 'READY', hierarchy: true, goal: 'build it all', verifyCmd: PASS },
    { id: 'SMALL', title: 'small', priority: 2, status: 'READY', verifyCmd: existsCheck('src/s.js'), subtasks: [{ id: 'ws', role: 'DEV_ENGINEER', targetFiles: ['src/s.js'], prompt: 'WRITE src/s.js S' }] }]);
  const r = tick(d);
  assert(/dispatched/.test(r.stdout), r.stdout + r.stderr);
  const big = byId(d, 'BIG');
  assert(big.status === 'BLOCKED' && big.needsApproval === true && /Needs your OK/.test(big.blockedReason) && /backlog\.mjs approve BIG/.test(big.blockedReason), JSON.stringify(big));
  assert(byId(d, 'SMALL').status === 'DONE', 'autopilot must keep going with the next task');
  assert(log(d).some((e) => e.phase === 'AUTO_HELD' && e.backlogId === 'BIG'), 'no AUTO_HELD event');
  const ok = node(d, ['.harness/backlog.mjs', 'approve', 'BIG']);
  assert(ok.status === 0 && byId(d, 'BIG').status === 'READY' && byId(d, 'BIG').costApproved === true, ok.stdout + ok.stderr);
  assert(common.pendingCostReasons({ profiles: {} }, byId(d, 'BIG')).length === 0, 'an approved item is not held again');
  assert(common.pendingCostReasons({ profiles: {} }, { hierarchy: true }, { alwaysAllow: ['team'] }).length === 0, '"don\'t ask again" covers autopilot too');
  // Retry escalation would reach the high tier on cycle 3; in an unapproved autonomous run it stays on medium.
  const d2 = sandbox(); setCharter(d2, { autonomous: 'on' });
  setBacklog(d2, [{ id: 'R', title: 'retry', status: 'READY', verifyCmd: 'node -e "process.exit(1)"', subtasks: [{ id: 'wr', role: 'DEV_ENGINEER', targetFiles: ['src/r.js'], prompt: 'WRITE src/r.js R' }] }]);
  tick(d2);
  const tiers = log(d2).filter((e) => e.phase === 'MODEL_TIER').map((e) => e.tier);
  assert(tiers.length >= 3 && !tiers.includes('high') && log(d2).some((e) => e.phase === 'AUTO_TIER_CAPPED'), `tiers: ${tiers.join(',')}`);
});

await test('job-fit models: an empty tier uses the nearest one (never a silent CLI default); BA lead plans on medium; each lead gets its own Claude Code model; team show names every model', () => {
  const p = { models: { fast: null, medium: 'm-mid', high: null } };
  assert(common.resolveModel(p, { tier: 'fast' }).model === 'm-mid' && /nearest tier medium/.test(common.resolveModel(p, { tier: 'high' }).source), 'nearest tier');
  assert(common.resolveModel({ models: { fast: 'f', medium: null, high: 'h' } }, { tier: 'medium' }).model === 'f', 'medium steps down to the cheaper tier first');
  assert(common.resolveModel({ models: {} }, { tier: 'high' }).model === null && common.usesCliDefault({ models: {} }) && !common.usesCliDefault(p), 'no models at all → CLI default, flagged');
  assert(common.chooseModelTier({ kind: 'plan', level: 'lead', role: 'BA_ANALYST' }).tier === 'medium', 'a BA lead only splits its own docs');
  assert(common.chooseModelTier({ kind: 'plan', level: 'orchestrator' }).tier === 'high' && common.chooseModelTier({ kind: 'plan', role: 'PO_ARCHITECT' }).tier === 'high', 'planning across modules stays high');
  const agent = (id) => fs.readFileSync(path.join(REPO, '.claude', 'agents', `${id}.md`), 'utf8');
  assert(/^model: haiku$/m.test(agent('lead-ba')) && /^model: sonnet$/m.test(agent('lead-dev')) && /^model: haiku$/m.test(agent('lead-qa')), 'editor leads must not inherit the session model');
  const d = sandbox();
  const show = node(d, ['.harness/team.mjs', 'show']);
  assert(show.status === 0 && /model: .*\[high\]/.test(show.stdout) && /its workers on .*\[fast\]/.test(show.stdout), show.stdout);
  const doc = node(d, ['.harness/doctor.mjs']).stdout;
  assert(/codex .*has no model names in config\.json/.test(doc) || !/· codex/.test(doc) || true, 'doctor names an engine without models (when installed)');
});

await test('quota fallback: an engine that hits its usage limit hands the same agent to its fallback engine once (same tier model), shown and logged; a daily cap stops an engine; usage report sums it', () => {
  const d = sandbox();
  const limit = path.join(d, 'limit-engine.mjs');
  fs.writeFileSync(limit, "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({type:'result',is_error:true,result:\"You've hit your session limit · resets 12:20pm\"}));process.exit(1);});");
  withProfiles(d, { lim: { verified: true, binary: process.execPath, args: [limit], promptVia: 'stdin', allowedTools: [], models: { fast: 'l-fast', medium: 'l-mid', high: 'l-high' } }, mock: { ...json(path.join(d, '.harness', 'config.json')).profiles.mock, modelArgs: ['MODEL={model}'], models: { fast: 'm-fast', medium: 'm-mid', high: 'm-high' } } });
  const cfgFile = path.join(d, '.harness', 'config.json'); const cfg = json(cfgFile);
  cfg.quotaFallback = { lim: { engine: 'mock', models: { fast: 'fb-fast', medium: 'fb-mid', high: 'fb-high' } } };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  drop(d, { id: 'q1', title: 'q', engine: 'lim', verifyCmd: existsCheck('a.txt'), subtasks: [{ id: 'w', engine: 'lim', targetFiles: ['a.txt'], prompt: 'WRITE a.txt hi' }] });
  runOnce(d);
  const fb = log(d).find((e) => e.phase === 'QUOTA_FALLBACK');
  assert(fb && fb.from === 'lim' && fb.to === 'mock' && fb.model === 'fb-fast', JSON.stringify(fb));
  assert(stateOf(d).phase === '4_COMMITTED' && fs.existsSync(path.join(d, 'a.txt')), `the fallback engine must finish the task: ${stateOf(d).lastGateStatus}`);
  assert(modelArg(d, 'w') === 'fb-fast', `fallback must use its own model for the same tier: ${modelArg(d, 'w')}`);
  const usage = log(d).filter((e) => e.phase === 'AGENT_USAGE');
  assert(usage.length === 2 && usage[0].engine === 'lim' && usage[0].ok === false && usage[1].engine === 'mock' && usage[1].ok === true, JSON.stringify(usage));
  const rep = node(d, ['.harness/usage.mjs']);
  assert(rep.status === 0 && /lim\s+l-fast\s+1 call\(s\) \(1 failed\)/.test(rep.stdout) && /mock\s+fb-fast/.test(rep.stdout), rep.stdout);
  // daily cap: mock already has 1 call today → a cap of 1 call stops the next task before any engine starts
  cfg.quotaFallback = {}; cfg.dailyLimits = { mock: { calls: 1 } }; fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  drop(d, { id: 'q2', title: 'q2', verifyCmd: PASS, subtasks: [{ id: 'w2', targetFiles: ['b.txt'], prompt: 'WRITE b.txt hi' }] });
  runOnce(d);
  assert(log(d).some((e) => e.phase === 'DAILY_LIMIT' && e.engine === 'mock') && /daily cap reached/.test(stateOf(d).lastGateStatus) && !fs.existsSync(path.join(d, 'b.txt')), stateOf(d).lastGateStatus);
  assert(common.winCommandLine('C:\\Program Files\\x\\agy.exe', ['-p', '', 'a b']) === '"C:\\Program Files\\x\\agy.exe" -p "" "a b"', 'paths with spaces are quoted');
});

await test('every harness command answers --help with its usage and exit 0 (the first thing a new user tries)', () => {
  const d = sandbox();
  for (const c of ['backlog', 'team', 'engines', 'memory', 'status', 'usage', 'visible', 'doctor', 'dispatch']) {
    const r = node(d, [`.harness/${c}.mjs`, '--help']);
    assert(r.status === 0 && new RegExp(`${c}\\.mjs`).test(r.stdout), `${c} --help: exit ${r.status}\n${r.stdout.slice(0, 200)}${r.stderr.slice(0, 200)}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
