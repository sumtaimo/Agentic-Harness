#!/usr/bin/env node
/**
 * test/run-tests.mjs — end-to-end tests for the harness. Each test runs in a fresh temp copy.
 *   node test/run-tests.mjs
 * Uses test/mock-agent.mjs as a fake engine, so no AI account is needed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = path.join(REPO, 'test', 'mock-agent.mjs');
let passed = 0; let failed = 0;

function sandbox({ worktrees = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  fs.cpSync(path.join(REPO, '.harness'), path.join(dir, '.harness'), {
    recursive: true,
    filter: (src) => !/(state\.json|telemetry\.log|daemon\.pid)$/.test(src) && !/[\\/](inbox|completed|failed|sessions)[\\/][^.]/.test(src)
  });
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.harness', 'config.json'), 'utf8'));
  cfg.profiles.mock = { verified: true, binary: process.execPath, args: [MOCK, 'ALLOWED={allowedTools}', 'DENIED={disallowedTools}'], promptVia: 'stdin', allowedTools: [] };
  cfg.activeProfile = 'mock';
  cfg.autoOrder = ['mock'];
  cfg.useGitWorktrees = worktrees;
  cfg.workerTimeoutMs = 20000;
  cfg.git = { ...(cfg.git || {}), integrationMode: 'off' }; // v1/v2 in-place tests; uat tests switch it on
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  return dir;
}

const env = { ...process.env, HARNESS_SILENT: '1', HARNESS_AGENT: '', HARNESS_LIVE: '0' };
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
  const cfg = json(path.join(d, '.harness', 'config.json'));
  cfg.profiles.fake = { binary: fake, args: ['--needed-flag'], promptVia: 'stdin' };
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
  assert(!fs.existsSync(path.join(d, '.harness', 'daemon.pid')), 'pid file left behind');
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
  const { detectVerifyCmd } = await import(path.join(REPO, '.harness', 'lib', 'common.mjs'));
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
  let t = fs.readFileSync(f, 'utf8');
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
  const d = sandbox();
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
  assert(log(d).some((e) => e.phase === 'PERMISSION_DENIED' && e.denials[0].target.endsWith('src/evil.js')), 'denial not in audit log');
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
  const { computeAllowedTools, skillRulesNotGranted, loadRoles, loadSkills } = await import(path.join(REPO, '.harness', 'lib', 'governance.mjs'));
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
  assert(r.status === 0 && /Controller: NOT running/.test(r.stdout) && /READY 1, IN_PROGRESS 0, DONE 1/.test(r.stdout) && /charter says off/.test(r.stdout) && /\/harness <goal>/.test(r.stdout), r.stdout);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
