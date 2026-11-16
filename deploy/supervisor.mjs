// Installed root-owned; executed as the bot user. Recovery imports only Node builtins.
import { spawn } from 'node:child_process';
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
const CODE_PATHS = ['src', 'scripts', 'deploy', 'tests', 'template', 'README.md', 'AGENTS.md', 'install.sh', '.gitignore', 'package.json', 'package-lock.json'];
const DEPENDENCIES = ['package.json', 'package-lock.json', 'node_modules/.package-lock.json'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function json(file, fallback = null) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
async function atomic(file, data) { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const pending = `${file}.tmp-${process.pid}-${randomUUID()}`; await writeFile(pending, JSON.stringify(data) + '\n', { mode: 0o600 }); await rename(pending, file); }
async function hashes(root) { return Object.fromEntries(await Promise.all(DEPENDENCIES.map(async file => { try { return [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')]; } catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error; } }))); }
const configFile = root => path.resolve(process.env.PI_KIT_CONFIG || path.join(root, 'config.json'));
async function assertPrivatePaths(root) {
  const config = await json(configFile(root), {});
  const resolve = async value => {
    const expanded = value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
    let absolute = path.resolve(root, expanded); const suffix = [];
    for (;;) { try { return path.join(await realpath(absolute), ...suffix); } catch { const parent = path.dirname(absolute); if (parent === absolute) return path.resolve(root, expanded); suffix.unshift(path.basename(absolute)); absolute = parent; } }
  };
  const privatePaths = await Promise.all([configFile(root), config.vaultRoot || 'vault', config.stateDir || '.state', config.facesDir, config.memoryFile, process.env.PI_CODING_AGENT_DIR || '.pi-agent'].filter(value => typeof value === 'string').map(resolve));
  const physicalRoot = await realpath(root);
  const codePaths = [...CODE_PATHS, '.self-change'].map(value => path.join(physicalRoot, value));
  if (privatePaths.some(privatePath => codePaths.some(codePath => privatePath === codePath || privatePath.startsWith(codePath + path.sep) || codePath.startsWith(privatePath + path.sep)))) throw new Error('Private data paths overlap source code or the self-change control directory. Automatic source recovery is disabled.');
}

export class Supervisor {
  constructor(root, options = {}) {
    this.root = path.resolve(root); this.directory = path.join(this.root, '.self-change');
    this.options = { pollMs: 300, startupMs: 60_000, idleMs: 300_000, stopMs: 25_000, graceMs: 600, ...options };
    this.child = null; this.stopping = false; this.state = 'starting';
  }
  file(name) { return path.join(this.directory, name); }
  async heartbeat(state = this.state) { this.state = state; await atomic(this.file('supervisor.json'), { pid: process.pid, childPid: this.child?.pid ?? null, epoch: this.epoch, state, updatedAt: new Date().toISOString() }); }
  startChild() {
    this.epoch = randomUUID();
    const child = spawn(process.execPath, [path.join(this.root, 'scripts/start.mjs')], { cwd: this.root, env: { ...process.env, PI_KIT_ROOT: this.root, PI_KIT_CONTROL_DIR: this.directory, PI_KIT_SUPERVISOR_EPOCH: this.epoch }, detached: true, stdio: this.options.stdio ?? 'inherit' });
    this.child = child; this.exited = false;
    this.exitPromise = new Promise(resolve => { child.once('exit', (code, signal) => { this.exited = true; resolve({ code, signal }); }); child.once('error', error => { this.exited = true; resolve({ error }); }); });
  }
  async ready(idle = false) {
    const marker = await json(this.file('ready.json'));
    return Boolean(!this.exited && marker?.ready && marker.pid === this.child?.pid && marker.epoch === this.epoch && Date.now() - Date.parse(marker.updatedAt) >= 0 && Date.now() - Date.parse(marker.updatedAt) < 5000 && (!idle || marker.idle));
  }
  async awaitReady() {
    const deadline = Date.now() + this.options.startupMs;
    while (!this.stopping && !this.exited && Date.now() < deadline) {
      await this.heartbeat('starting');
      if (await this.ready()) { await pause(this.options.graceMs); return !this.exited && await this.ready(); }
      await pause(this.options.pollMs);
    }
    return false;
  }
  async stopChild() {
    if (!this.child || this.exited) return;
    try { process.kill(-this.child.pid, 'SIGTERM'); } catch {}
    await Promise.race([this.exitPromise, pause(this.options.stopMs)]);
    if (!this.exited) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch {} await this.exitPromise; }
  }
  async snapshot() {
    await assertPrivatePaths(this.root);
    const directory = this.file('baseline');
    if (!await exists(directory) && await exists(this.file('baseline-old'))) await rename(this.file('baseline-old'), directory);
    const metadata = await json(path.join(directory, 'snapshot.json'));
    if (!metadata || metadata.format !== 1 || JSON.stringify(metadata.paths) !== JSON.stringify(CODE_PATHS)) throw new Error('Source baseline is missing or damaged.');
    let count = 0, bytes = 0;
    const visit = async file => { const info = await lstat(file); if (info.isSymbolicLink()) throw new Error('The source baseline contains a symlink.'); if (info.isDirectory()) { for (const name of await readdir(file)) await visit(path.join(file, name)); } else if (info.isFile()) { count++; bytes += info.size; if (count > 1000 || bytes > 25 * 1024 * 1024) throw new Error('The source baseline is too large.'); } else throw new Error('The source baseline contains a special file.'); };
    for (const entry of CODE_PATHS) if (await exists(path.join(directory, entry))) await visit(path.join(directory, entry));
    if (JSON.stringify(await hashes(this.root)) !== JSON.stringify(metadata.dependencies)) throw new Error('Dependencies differ from the baseline; automatic rollback is blocked.');
    return metadata;
  }
  async restoreSource() {
    await this.snapshot();
    const failed = this.file('failed');
    await rm(failed, { recursive: true, force: true }); await mkdir(failed);
    // Failed source is retained once for inspection. Never follow its symlinks.
    let bytes = 0, count = 0;
    const capture = async (source, destination) => {
      const info = await lstat(source);
      if (info.isSymbolicLink()) { await mkdir(path.dirname(destination), { recursive: true }); await cp(source, destination, { dereference: false, verbatimSymlinks: true }); }
      else if (info.isDirectory()) { await mkdir(destination, { recursive: true }); for (const name of await readdir(source)) await capture(path.join(source, name), path.join(destination, name)); }
      else if (info.isFile()) { bytes += info.size; count++; if (bytes > 25 * 1024 * 1024 || count > 1000) throw new Error('Failed source capture is incomplete: the limit is 25 MB or 1000 files.'); await mkdir(path.dirname(destination), { recursive: true }); await cp(source, destination); }
    };
    try { for (const entry of CODE_PATHS) if (await exists(path.join(this.root, entry))) await capture(path.join(this.root, entry), path.join(failed, entry)); }
    catch (error) { await atomic(path.join(failed, 'capture-error.json'), { message: error.message }); }
    for (const entry of CODE_PATHS) {
      await rm(path.join(this.root, entry), { recursive: true, force: true });
      if (await exists(path.join(this.file('baseline'), entry))) await cp(path.join(this.file('baseline'), entry), path.join(this.root, entry), { recursive: true, preserveTimestamps: true });
    }
  }
  async complete(request, status, message) {
    const config = await json(configFile(this.root), {});
    const chatId = request.chatId ?? config.telegram?.allowedUserIds?.[0] ?? null;
    const result = { id: request.id, chatId, status, message, createdAt: new Date().toISOString() };
    // Completed is durable before result delivery; a supervisor crash cannot replay apply.
    await atomic(this.file('active.json'), { request, phase: 'completed', result });
    await atomic(this.file('result.json'), result);
    await rm(this.file('request.json'), { force: true }); await rm(this.file('active.json'), { force: true });
  }
  async reject(request, message) { await this.complete(request, 'failed', message); }
  async processRequest(request) {
    try {
      if (!request?.id || !['apply', 'rollback'].includes(request.action)) throw new Error('Invalid source-change request.');
      const snapshot = await this.snapshot();
      if (snapshot.id !== request.baselineId) throw new Error('The request refers to another source baseline.');
    } catch (error) { await this.reject(request ?? { id: randomUUID() }, error.message); return; }
    const deadline = Date.now() + this.options.idleMs;
    while (!this.stopping && !this.exited && Date.now() < deadline && !await this.ready(true)) { await this.heartbeat('waiting-for-idle'); await pause(this.options.pollMs); }
    if (this.stopping) return;
    if (!this.exited && !await this.ready(true)) { await this.reject(request, 'Restart cancelled: the bot did not finish its current work before the deadline.'); return; }
    await atomic(this.file('active.json'), { request, phase: 'restarting' });
    await this.stopChild();
    // Keep request until old process is fully gone, so it cannot resume queued work.
    await rm(this.file('request.json'), { force: true });
    if (request.action === 'rollback') await this.restoreSource();
    this.startChild();
    if (await this.awaitReady()) { await this.complete(request, request.action === 'rollback' ? 'rolled_back' : 'applied', request.action === 'rollback' ? 'Previous source restored; the bot is running. Private data was preserved.' : 'Changes applied; the bot is running again.'); await this.heartbeat('running'); return; }
    if (this.stopping) return;
    await this.stopChild();
    if (request.action === 'apply') {
      await atomic(this.file('active.json'), { request, phase: 'recovering' });
      await this.restoreSource(); this.startChild();
      if (await this.awaitReady()) { await this.complete(request, 'rolled_back', 'The new version failed to start. The source baseline was restored and the bot is running; failed source is saved in .self-change/failed.'); await this.heartbeat('running'); return; }
    }
    await this.complete(request, 'failed', 'The restored source could not start. Private data was preserved; check the service logs.');
    throw new Error('Startup failed after one recovery attempt');
  }
  async recoverInterrupted(active) {
    if (active.phase === 'completed') { if (!await exists(this.file('result.json'))) await atomic(this.file('result.json'), active.result); await rm(this.file('request.json'), { force: true }); await rm(this.file('active.json'), { force: true }); return; }
    // A supervisor killed between stopping and readiness always returns to its saved baseline.
    await this.restoreSource();
    await this.complete(active.request, 'rolled_back', 'An interrupted restart was recovered from the source baseline. The bot is starting again.');
  }
  async run() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const active = await json(this.file('active.json'));
    if (active) await this.recoverInterrupted(active);
    this.startChild();
    if (!await this.awaitReady()) {
      if (this.stopping) return;
      await this.stopChild();
      // Never keep retrying a baseline across supervisor crashes.
      if (!await exists(this.file('baseline')) && await exists(this.file('baseline-old'))) await rename(this.file('baseline-old'), this.file('baseline'));
      const snapshot = await json(path.join(this.file('baseline'), 'snapshot.json'));
      const recovery = await json(this.file('startup-recovery.json'));
      if (!snapshot || recovery?.baselineId === snapshot.id) throw new Error('The bot did not confirm startup; recovery was already attempted or no baseline is available.');
      await atomic(this.file('startup-recovery.json'), { baselineId: snapshot.id, createdAt: new Date().toISOString() });
      await this.restoreSource(); this.startChild();
      if (!await this.awaitReady()) throw new Error('The source baseline did not confirm startup after recovery.');
      await this.complete({ id: randomUUID(), chatId: snapshot.chatId }, 'rolled_back', 'The source baseline was restored after a startup error. The bot is running.');
    }
    await this.heartbeat('running');
    while (!this.stopping) {
      if (this.exited) throw new Error('Bridge exited unexpectedly');
      const request = await json(this.file('request.json'));
      if (request) await this.processRequest(request);
      await this.heartbeat('running'); await pause(this.options.pollMs);
    }
  }
  async stop() { this.stopping = true; await this.stopChild(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root || !path.isAbsolute(root)) { console.error('Supervisor requires a fixed absolute application path'); process.exitCode = 1; }
  else {
    const supervisor = new Supervisor(root);
    const stop = () => { supervisor.stop().catch(error => console.error(error.message)); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    supervisor.run().catch(error => { console.error(`Supervisor: ${error.message}`); process.exitCode = 1; }).finally(async () => { await supervisor.stop(); await supervisor.heartbeat('stopped'); });
  }
}
