import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';

export const CODE_PATHS = Object.freeze(['src', 'scripts', 'deploy', 'tests', 'template', 'README.md', 'AGENTS.md', 'install.sh', '.gitignore', 'package.json', 'package-lock.json']);
const DEPENDENCIES = ['package.json', 'package-lock.json', 'node_modules/.package-lock.json'];
const MAX_BYTES = 25 * 1024 * 1024, MAX_FILES = 1000;
export const controlDirectory = root => path.join(root, '.self-change');
export async function readJson(file, fallback = null) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
export async function atomicJson(file, data) { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`; await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, file); }
async function exists(file) { try { await access(file); return true; } catch { return false; } }
const configFile = root => path.resolve(process.env.PI_KIT_CONFIG || path.join(root, 'config.json'));
async function assertPrivatePaths(root) {
  const config = await readJson(configFile(root), {});
  const resolve = async value => {
    const expanded = value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
    let absolute = path.resolve(root, expanded); const suffix = [];
    for (;;) { try { return path.join(await realpath(absolute), ...suffix); } catch { const parent = path.dirname(absolute); if (parent === absolute) return path.resolve(root, expanded); suffix.unshift(path.basename(absolute)); absolute = parent; } }
  };
  const privatePaths = await Promise.all([configFile(root), config.vaultRoot || 'vault', config.stateDir || '.state', config.facesDir, config.memoryFile, process.env.PI_CODING_AGENT_DIR || '.pi-agent'].filter(value => typeof value === 'string').map(resolve));
  const physicalRoot = await realpath(root);
  const codePaths = [...CODE_PATHS, '.self-change'].map(value => path.join(physicalRoot, value));
  if (privatePaths.some(privatePath => codePaths.some(codePath => privatePath === codePath || privatePath.startsWith(codePath + path.sep) || codePath.startsWith(privatePath + path.sep)))) throw new Error('Private data paths overlap source code or the self-change control directory. Move them outside these paths before using self-change.');
}
async function dependencyHashes(root) {
  return Object.fromEntries(await Promise.all(DEPENDENCIES.map(async file => { try { return [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')]; } catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error; } })));
}
export async function codeFiles(root) {
  const files = []; let bytes = 0;
  async function walk(relative) {
    const info = await lstat(path.join(root, relative));
    if (info.isSymbolicLink()) throw new Error(`Source symlinks are not supported: ${relative}`);
    if (info.isDirectory()) { for (const name of (await readdir(path.join(root, relative))).sort()) await walk(path.join(relative, name)); }
    else if (info.isFile()) { bytes += info.size; files.push(relative); if (files.length > MAX_FILES || bytes > MAX_BYTES) throw new Error('Source exceeds the safe snapshot limit (25 MB, 1000 files).'); }
    else throw new Error(`Special source file: ${relative}`);
  }
  for (const entry of CODE_PATHS) if (await exists(path.join(root, entry))) await walk(entry);
  return files;
}
async function withLock(root, operation) {
  await assertPrivatePaths(root);
  const lock = path.join(controlDirectory(root), 'cli-lock');
  await mkdir(controlDirectory(root), { recursive: true, mode: 0o700 });
  try { await mkdir(lock); } catch { throw new Error('Another source-change operation is running.'); }
  try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
}
async function assertNoPending(directory) {
  if (await exists(path.join(directory, 'request.json')) || await exists(path.join(directory, 'active.json'))) throw new Error('A restart is already pending or running. Check status.');
  if (await exists(path.join(directory, 'result.json'))) throw new Error('Wait until the previous restart result has been delivered.');
}
async function baseline(root) {
  const directory = controlDirectory(root);
  if (!await exists(path.join(directory, 'baseline')) && await exists(path.join(directory, 'baseline-old'))) await rename(path.join(directory, 'baseline-old'), path.join(directory, 'baseline'));
  const metadata = await readJson(path.join(directory, 'baseline', 'snapshot.json'));
  if (!metadata || metadata.format !== 1 || JSON.stringify(metadata.paths) !== JSON.stringify(CODE_PATHS)) throw new Error('No valid source baseline is available. Run begin before editing.');
  return metadata;
}
async function beginUnlocked(root, chatId) {
  const directory = controlDirectory(root); await assertNoPending(directory);
  const config = await readJson(configFile(root), {});
  chatId ??= config.telegram?.allowedUserIds?.[0] ?? null;
  await codeFiles(root);
  const metadata = { format: 1, id: randomUUID(), createdAt: new Date().toISOString(), chatId: chatId ?? null, paths: CODE_PATHS, dependencies: await dependencyHashes(root) };
  const pending = path.join(directory, 'baseline-pending'); await rm(pending, { recursive: true, force: true }); await mkdir(pending);
  try {
    for (const entry of CODE_PATHS) if (await exists(path.join(root, entry))) await cp(path.join(root, entry), path.join(pending, entry), { recursive: true, preserveTimestamps: true });
    await atomicJson(path.join(pending, 'snapshot.json'), metadata);
    await rm(path.join(directory, 'baseline-old'), { recursive: true, force: true });
    if (await exists(path.join(directory, 'baseline'))) await rename(path.join(directory, 'baseline'), path.join(directory, 'baseline-old'));
    try { await rename(pending, path.join(directory, 'baseline')); }
    catch (error) { if (await exists(path.join(directory, 'baseline-old'))) await rename(path.join(directory, 'baseline-old'), path.join(directory, 'baseline')); throw error; }
    await rm(path.join(directory, 'baseline-old'), { recursive: true, force: true });
    await rm(path.join(directory, 'failed'), { recursive: true, force: true });
  } finally { await rm(pending, { recursive: true, force: true }); }
  return { ok: true, id: metadata.id, status: 'editing', message: 'Source baseline saved. Make your edits, then run check and apply. Private data is outside the snapshot.' };
}
export async function begin(root, options = {}) { return withLock(root, () => beginUnlocked(root, options.chatId)); }
function execute(command, args, root, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const capture = data => { output = (output + data.toString()).slice(-12000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (timedOut || code !== 0) reject(new Error(`${timedOut ? 'Validation timed out' : `Validation exited with code ${code}`}\n${output}`)); else resolve(); });
  });
}
async function checkUnlocked(root, options = {}) {
  const metadata = await baseline(root);
  if (JSON.stringify(await dependencyHashes(root)) !== JSON.stringify(metadata.dependencies)) throw new Error('package.json, a lockfile or the installed dependency marker changed. Self-change does not update dependencies: restore them to the baseline; update dependencies manually with a full backup.');
  const files = await codeFiles(root);
  for (const file of files.filter(file => /\.(?:mjs|cjs|js)$/.test(file))) await execute(process.execPath, ['--check', file], root, options.syntaxTimeoutMs ?? 10_000);
  await execute(path.join(path.dirname(process.execPath), 'npm'), ['test'], root, options.testTimeoutMs ?? 120_000);
  // Tests may themselves change package files; compare again before approval.
  if (JSON.stringify(await dependencyHashes(root)) !== JSON.stringify(metadata.dependencies)) throw new Error('Validation changed dependencies. Apply was cancelled.');
  await atomicJson(path.join(controlDirectory(root), 'check.json'), { id: metadata.id, checkedAt: new Date().toISOString(), ok: true });
  return { ok: true, id: metadata.id, status: 'checked', message: 'Syntax checks and npm test passed. You can request apply.' };
}
export async function check(root, options = {}) { return withLock(root, () => checkUnlocked(root, options)); }
export async function requestChange(root, options = {}) {
  return withLock(root, async () => {
    const directory = controlDirectory(root); await assertNoPending(directory);
    const supervisor = await readJson(path.join(directory, 'supervisor.json'));
    if (!supervisor?.pid || Date.now() - Date.parse(supervisor.updatedAt) > 15_000) throw new Error('Supervisor is not running. Update the system installation first; direct npm start does not support controlled restarts.');
    try { process.kill(supervisor.pid, 0); } catch { throw new Error('Supervisor is not running.'); }
    const metadata = await baseline(root);
    const action = options.action === 'rollback' ? 'rollback' : 'apply';
    if (JSON.stringify(await dependencyHashes(root)) !== JSON.stringify(metadata.dependencies)) throw new Error('Dependencies differ from the source baseline. Apply and rollback are blocked: restore dependencies manually first.');
    if (action === 'apply') await checkUnlocked(root, options);
    const config = await readJson(configFile(root), {});
    const chatId = options.chatId ?? metadata.chatId ?? config.telegram?.allowedUserIds?.[0] ?? null;
    const request = { id: randomUUID(), baselineId: metadata.id, chatId, action, createdAt: new Date().toISOString() };
    await atomicJson(path.join(directory, 'request.json'), request);
    return { ok: true, id: request.id, status: 'queued', message: 'Validation passed. Restart is waiting for the current reply to finish; the result will arrive after startup.' };
  });
}
export async function status(root) {
  const directory = controlDirectory(root);
  const [supervisor, snapshot, request, active, result] = await Promise.all(['supervisor.json', 'baseline/snapshot.json', 'request.json', 'active.json', 'result.json'].map(file => readJson(path.join(directory, file))));
  return { ok: true, status: active ? 'restarting' : request ? 'queued' : supervisor?.state ?? 'offline', baselineId: snapshot?.id ?? null, requestId: request?.id ?? active?.request?.id ?? null, result, message: result?.message ?? (active ? 'Restart is running.' : request ? 'Waiting for the reply to finish before restarting.' : `Status: ${supervisor?.state ?? 'supervisor is offline'}. Baseline: ${snapshot ? 'available' : 'none'}.`) };
}
