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
  cfg.profiles.mock = { verified: true, binary: process.execPath, args: [MOCK, '{allowedTools}'], promptVia: 'stdin', allowedTools: [] };
  cfg.activeProfile = 'mock';
  cfg.autoOrder = ['mock'];
  cfg.useGitWorktrees = worktrees;
  cfg.workerTimeoutMs = 20000;
  fs.writeFileSync(path.join(dir, '.harness', 'config.json'), JSON.stringify(cfg, null, 2));
  return dir;
}

const env = { ...process.env, HARNESS_SILENT: '1', HARNESS_AGENT: '' };
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
  assert(fs.readFileSync(path.join(d, '.mock-prompts', 'planner-calls.txt'), 'utf8').trim() === 'Read,Glob,Grep', 'planner was not limited to read-only tools');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
