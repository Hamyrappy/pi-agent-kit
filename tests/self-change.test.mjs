import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, begin, check, requestChange, readJson } from '../src/self-change.mjs';
import { Supervisor } from '../deploy/supervisor.mjs';
const cleanups = new Map();

const workingChild = `import fs from 'node:fs/promises';
import path from 'node:path';
const directory=process.env.PI_KIT_CONTROL_DIR;
let busy=false;
async function mark(){
 try{await fs.access(path.join(process.cwd(),'busy'));busy=true;}catch{busy=false;}
 const data={pid:process.pid,epoch:process.env.PI_KIT_SUPERVISOR_EPOCH,ready:true,idle:!busy,updatedAt:new Date().toISOString()};
 const pending=path.join(directory,'ready-child.tmp');await fs.writeFile(pending,JSON.stringify(data));await fs.rename(pending,path.join(directory,'ready.json'));
}
await mark();const timer=setInterval(()=>mark().catch(()=>{}),20);
process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0)});
`;
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-self-change-'));
  t.after(async () => { if (cleanups.has(root)) await cleanups.get(root)(); cleanups.delete(root); await rm(root, { recursive: true, force: true }); });
  for (const entry of ['src', 'scripts', 'tests', 'vault', '.state', '.pi-agent', '.git', 'node_modules']) await mkdir(path.join(root, entry));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node -e "process.exit(0)"' } }));
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  await writeFile(path.join(root, 'node_modules/.package-lock.json'), '{"installed":true}');
  await writeFile(path.join(root, 'scripts/start.mjs'), workingChild);
  await writeFile(path.join(root, 'src/logic.mjs'), 'export const value=1;\n');
  await writeFile(path.join(root, 'vault/memory.md'), 'private memory');
  await writeFile(path.join(root, '.env'), 'PRIVATE_TEST_SECRET=fake\n');
  await writeFile(path.join(root, 'config.json'), '{"telegram":{"allowedUserIds":[42]}}');
  await writeFile(path.join(root, '.state/history'), 'private history');
  await writeFile(path.join(root, '.pi-agent/auth.json'), 'private fake auth');
  await writeFile(path.join(root, '.git/owner-marker'), 'private git');
  return root;
}
async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for self-change state');
}
async function running(t, root, options = {}) {
  const supervisor = new Supervisor(root, { pollMs: 15, startupMs: 2000, idleMs: 3000, stopMs: 500, graceMs: 60, stdio: 'ignore', ...options });
  let failure;
  const promise = supervisor.run().catch(error => { failure = error; });
  cleanups.set(root, async () => { await supervisor.stop(); await promise; });
  await until(async () => (await readJson(path.join(root, '.self-change/supervisor.json')))?.state === 'running');
  return { supervisor, promise, failure: () => failure };
}
async function privateDataUnchanged(root) {
  for (const [file, value] of [['vault/memory.md', 'private memory'], ['.env', 'PRIVATE_TEST_SECRET=fake\n'], ['.state/history', 'private history'], ['.pi-agent/auth.json', 'private fake auth'], ['.git/owner-marker', 'private git']]) assert.equal(await readFile(path.join(root, file), 'utf8'), value, file);
}
test('baseline is code-only, remembers owner and survives interrupted generation publication', async t => {
  const root = await fixture(t);
  await begin(root);
  const metadata = await readJson(path.join(root, '.self-change/baseline/snapshot.json'));
  assert.equal(metadata.chatId, 42);
  await assert.rejects(access(path.join(root, '.self-change/baseline/vault')));
  await assert.rejects(access(path.join(root, '.self-change/baseline/.env')));
  await rename(path.join(root, '.self-change/baseline'), path.join(root, '.self-change/baseline-old'));
  assert.equal((await check(root)).ok, true);
  assert.equal((await readJson(path.join(root, '.self-change/baseline/snapshot.json'))).id, metadata.id);
});
test('validation rejects invalid source and dependency changes without requesting restart', async t => {
  const root = await fixture(t);
  await running(t, root);
  await begin(root);
  await writeFile(path.join(root, 'src/logic.mjs'), 'export const = ;');
  await assert.rejects(check(root), /Validation exited/);
  await writeFile(path.join(root, 'src/logic.mjs'), 'export const value=2;');
  await writeFile(path.join(root, 'package-lock.json'), '{"changed":true}');
  for (const action of ['apply', 'rollback']) await assert.rejects(requestChange(root, { action, chatId: 42 }), /Dependencies differ/);
  await assert.rejects(access(path.join(root, '.self-change/request.json')));
  await privateDataUnchanged(root);
});
test('private vault paths inside source are rejected before snapshot or restore', async t => {
  const root = await fixture(t);
  await begin(root);
  await symlink(path.join(root, 'src'), path.join(root, 'source-alias'));
  for (const override of [{ vaultRoot: path.join(root, 'src/private-vault') }, { memoryFile: path.join(root, 'src/logic.mjs') }, { memoryFile: path.join(root, 'source-alias/new-memory.md') }, { facesDir: path.join(root, 'source-alias') }, { stateDir: path.join(root, 'scripts/state') }]) {
    await writeFile(path.join(root, 'config.json'), JSON.stringify({ ...override, telegram: { allowedUserIds: [42] } }));
    await assert.rejects(begin(root), /Private data paths overlap/);
    await assert.rejects(new Supervisor(root).restoreSource(), /Private data paths overlap/);
  }
  const previousHome = process.env.HOME, previousConfig = process.env.PI_KIT_CONFIG;
  try {
    process.env.HOME = root;
    await writeFile(path.join(root, 'config.json'), JSON.stringify({ memoryFile: '~/src/private-memory.md' }));
    await assert.rejects(begin(root), /Private data paths overlap/);
    await assert.rejects(new Supervisor(root).restoreSource(), /Private data paths overlap/);
    process.env.PI_KIT_CONFIG = path.join(root, 'src/custom-config.json');
    await writeFile(process.env.PI_KIT_CONFIG, '{}');
    await assert.rejects(begin(root), /Private data paths overlap/);
    await assert.rejects(new Supervisor(root).restoreSource(), /Private data paths overlap/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousConfig === undefined) delete process.env.PI_KIT_CONFIG; else process.env.PI_KIT_CONFIG = previousConfig;
  }
  assert.equal(await readFile(path.join(root, 'src/logic.mjs'), 'utf8'), 'export const value=1;\n');
});
test('restart without pre-edit baseline is rejected and current process keeps running', async t => {
  const root = await fixture(t);
  const { supervisor } = await running(t, root);
  const pid = supervisor.child.pid;
  await assert.rejects(requestChange(root, { action: 'restart', chatId: 42 }), /Run begin before editing/);
  assert.equal(supervisor.child.pid, pid);
});
test('apply waits for flushed idle, rejects stale ready epoch and starts the edited code once', async t => {
  const root = await fixture(t);
  const { supervisor, failure } = await running(t, root);
  await begin(root);
  await writeFile(path.join(root, 'src/logic.mjs'), 'export const value=2;\n');
  await writeFile(path.join(root, 'busy'), 'active reply');
  await until(async () => !(await readJson(path.join(root, '.self-change/ready.json')))?.idle);
  const oldPid = supervisor.child.pid;
  const request = await requestChange(root, { action: 'apply', chatId: 42 });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(supervisor.child.pid, oldPid);
  await atomicJson(path.join(root, '.self-change/ready.json'), { pid: oldPid, ready: true, idle: true, epoch: 'old-generation', updatedAt: new Date().toISOString() });
  assert.equal(await supervisor.ready(true), false);
  await rm(path.join(root, 'busy'));
  const result = await until(() => { if (failure()) throw failure(); return readJson(path.join(root, '.self-change/result.json')); });
  assert.equal(result.id, request.id); assert.equal(result.status, 'applied');
  assert.notEqual(supervisor.child.pid, oldPid);
  assert.equal(await readFile(path.join(root, 'src/logic.mjs'), 'utf8'), 'export const value=2;\n');
  await assert.rejects(access(path.join(root, '.self-change/request.json')));
  await privateDataUnchanged(root);
});
test('new startup failure restores deleted code, removes introduced code, retains failed source and all private data', async t => {
  const root = await fixture(t);
  const { supervisor, failure } = await running(t, root);
  await begin(root);
  await rm(path.join(root, 'src/logic.mjs'));
  await writeFile(path.join(root, 'src/introduced.mjs'), 'export const broken=1;\n');
  await writeFile(path.join(root, 'scripts/start.mjs'), 'process.exit(17);\n');
  await requestChange(root, { action: 'apply', chatId: 42 });
  const result = await until(() => readJson(path.join(root, '.self-change/result.json')));
  assert.equal(result.status, 'rolled_back'); assert.equal(result.chatId, 42);
  assert.equal(await readFile(path.join(root, 'src/logic.mjs'), 'utf8'), 'export const value=1;\n');
  await assert.rejects(access(path.join(root, 'src/introduced.mjs')));
  assert.equal(await readFile(path.join(root, '.self-change/failed/scripts/start.mjs'), 'utf8'), 'process.exit(17);\n');
  assert.equal(await readFile(path.join(root, '.self-change/failed/src/introduced.mjs'), 'utf8'), 'export const broken=1;\n');
  assert.equal(await supervisor.ready(), true); assert.equal(failure(), undefined);
  await privateDataUnchanged(root);
});
test('supervisor recovery uses its standalone code when the application recovery module is broken', async t => {
  const root = await fixture(t);
  await begin(root);
  const snapshot = await readJson(path.join(root, '.self-change/baseline/snapshot.json'));
  await writeFile(path.join(root, 'scripts/start.mjs'), 'process.exit(11);');
  await writeFile(path.join(root, 'src/self-change.mjs'), 'this is not JavaScript');
  await writeFile(path.join(root, '.self-change/active.json'), JSON.stringify({ request: { id: 'interrupted', chatId: 42, action: 'apply', baselineId: snapshot.id }, phase: 'restarting' }));
  const { supervisor } = await running(t, root);
  assert.equal((await readJson(path.join(root, '.self-change/result.json'))).id, 'interrupted');
  await assert.rejects(access(path.join(root, 'src/self-change.mjs')));
  assert.equal(await supervisor.ready(), true);
  await privateDataUnchanged(root);
});
test('standalone supervisor exits promptly after a cooperative child stops', async t => {
  const root = await fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../deploy/supervisor.mjs', import.meta.url)), root], { stdio: 'ignore' });
  let exited = false;
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  cleanups.set(root, async () => {
    if (!exited) child.kill('SIGKILL');
    await closed;
    const status = await readJson(path.join(root, '.self-change/supervisor.json'));
    if (status?.childPid) { try { process.kill(-status.childPid, 'SIGKILL'); } catch {} }
  });
  await until(async () => (await readJson(path.join(root, '.self-change/supervisor.json')))?.state === 'running');
  const started = performance.now();
  child.kill('SIGTERM');
  let timer;
  const result = await Promise.race([
    closed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Standalone supervisor retained its shutdown timeout after the child exited')), 2000); })
  ]).finally(() => clearTimeout(timer));
  assert.equal(result.code, 0);
  assert.ok(performance.now() - started < 2000);
});
